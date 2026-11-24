// Live View Counter: a small local web app that shows a YouTube channel's total views counting up live.
//
//   node server.js                       run it in this window (then open http://localhost:4747)
//   node server.js --background --open   run it hidden in the background and open it in your browser
//   node server.js --install             add a desktop shortcut, start with Windows, and start it now
//   node server.js --uninstall           remove those shortcuts and stop it
//   node server.js --stop                stop the background counter
//   node server.js --lan                 let phones/tablets on your Wi-Fi open it too
//
// Uses only Node's built-in modules. No npm install needed.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { exec, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Tracker, DEFAULT_BUDGET, spendQuota } from './src/tracker.js';
import { createYouTube, resolveChannel, channelInfo, API_BASE } from './src/youtube.js';
import { readJson, writeJson } from './src/store.js';
import { cleanCounters } from './src/counters.js';
import {
  PLATFORMS, SocialSource, readAccount, normalizeHandle, sourceKey, refreshInstagramToken, IG_REFRESH_EVERY_MS,
} from './src/social.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- options ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DATA_DIR = path.resolve(option('data', process.env.LVC_DATA_DIR || path.join(ROOT, 'data')));
const API_BASE_URL = option('api-base', process.env.LVC_API_BASE || API_BASE);
const LAN = flag('lan') || process.env.LVC_LAN === '1';
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const START_PORT = Number(option('port', process.env.LVC_PORT || 4747));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');     // counters and how the page looks (shared by every browser and OBS)
const SOUND_FILE = path.join(DATA_DIR, 'custom-sound');         // the user's own tick sound, if they upload one
const SOUND_META_FILE = path.join(DATA_DIR, 'custom-sound.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const SERVER_FILE = fileURLToPath(import.meta.url);
const ICON_FILE = path.join(ROOT, 'assets', 'icon.ico');
const HIDDEN = flag('hidden'); // the background copy: no window, messages go to data/server.log

// Options that a background copy or a shortcut should keep using.
const keptArgs = () => argv.filter((a) => /^--(port|data|api-base)=/.test(a) || a === '--lan');

// ---------- background copy: write messages to a log file instead of a window ----------
if (HIDDEN) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1_000_000) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
  } catch { /* logging is best effort */ }
  const log = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const writer = (level) => (...args) => log.write(`${new Date().toISOString()} ${level}${util.format(...args).trim()}\n`);
  console.log = writer('');
  console.warn = writer('warning: ');
  console.error = writer('error: ');
  process.on('uncaughtException', (e) => {
    console.error('Stopped by an unexpected error:', e);
    log.end(() => process.exit(1));
  });
}

// ---------- state ----------
let config = readJson(CONFIG_FILE, {});
const state = readJson(STATE_FILE, {});
let tracker = null;
let snapshot = null;
let ownsState = false; // only the instance that is actually serving may write the state file
let saveTimer = null;
let urls = [];
const clients = new Set();

let settings = readJson(SETTINGS_FILE, {});
let settingsRev = Date.now();
const sources = new Map();       // "platform:handle" -> SocialSource
const checkedAvatars = new Map(); // avatars of accounts looked up while adding them

const setupSnapshot = () => ({ app: 'live-view-counter', status: 'setup', channel: null, total: null });
function current() {
  const social = {};
  for (const [key, src] of sources) social[key] = src.snapshot();
  return { ...(snapshot || setupSnapshot()), sources: social, serverTime: Date.now() };
}

// ---------- other platforms ----------
// Starts a poller for every TikTok/Twitch/Kick/Bluesky/Instagram account a counter uses, and stops unused ones.
function syncSources() {
  if (!ownsState) return;
  if (!state.social) state.social = {};
  const wanted = new Map();
  for (const c of settings.counters || []) {
    if (c.platform === 'youtube' || !PLATFORMS[c.platform]) continue;
    wanted.set(sourceKey(c.platform, c.handle), c);
  }
  for (const [key, src] of sources) {
    if (!wanted.has(key)) {
      src.stop();
      src.removeAllListeners();
      sources.delete(key);
    }
  }
  for (const [key, c] of wanted) {
    if (sources.has(key)) continue;
    const saved = state.social[key] || (state.social[key] = {});
    const src = new SocialSource({
      platform: c.platform,
      handle: c.handle,
      saved,
      getToken: () => (config.tokens && config.tokens[key] ? config.tokens[key].token : ''),
      onDirty: scheduleSave,
    });
    src.on('update', broadcast);
    sources.set(key, src);
    src.start();
  }
  // Forget saved history for accounts no counter uses any more.
  for (const key of Object.keys(state.social)) if (!wanted.has(key)) delete state.social[key];
  broadcast();
}

// Instagram tokens expire after 60 days unless renewed; renew them about once a week.
async function refreshTokens() {
  const tokens = config.tokens || {};
  for (const [key, t] of Object.entries(tokens)) {
    if (!key.startsWith('instagram:') || !t || !t.token) continue;
    if (Date.now() - (t.refreshedAt || t.savedAt || 0) < IG_REFRESH_EVERY_MS) continue;
    try {
      const token = await refreshInstagramToken(t.token);
      config.tokens[key] = { ...t, token, refreshedAt: Date.now() };
      writeJson(CONFIG_FILE, config, { pretty: true });
      console.log(`  Renewed the Instagram token for ${key.slice(10)}.`);
    } catch (e) {
      console.warn(`  Could not renew the Instagram token for ${key.slice(10)}: ${e.message}`);
    }
  }
}
setInterval(() => { if (ownsState) refreshTokens(); }, 6 * 3_600_000).unref();

// ---------- settings ----------
function broadcastSettings() {
  const frame = `event: settings\ndata: ${JSON.stringify({ settings, rev: settingsRev })}\n\n`;
  for (const c of clients) c.write(frame);
}

async function handleSettings(req, res) {
  if (!changeAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: { message: 'Settings can only be changed on the computer that runs the counter.' } });
  }
  let body;
  try { body = await readBody(req, 200_000); } catch { return sendJson(res, 400, { ok: false, error: { message: 'Those settings are too big to save.' } }); }
  const next = body && typeof body.settings === 'object' && body.settings ? body.settings : null;
  if (!next || Array.isArray(next)) return sendJson(res, 400, { ok: false, error: { message: 'Bad request.' } });
  next.counters = cleanCounters(next.counters);
  settings = next;
  settingsRev = Math.max(Date.now(), settingsRev + 1);
  writeJson(SETTINGS_FILE, settings, { pretty: true });
  broadcastSettings();
  syncSources();
  return sendJson(res, 200, { ok: true, rev: settingsRev, counters: settings.counters });
}

// Looks an account up before it's added, so typos show up straight away.
async function handleCheckAccount(req, res) {
  if (!changeAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: { message: 'Counters can only be added on the computer that runs the counter.' } });
  }
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: { message: 'Bad request.' } }); }
  const platform = String(body.platform || '');
  const p = PLATFORMS[platform];
  if (!p) return sendJson(res, 400, { ok: false, error: { message: 'Choose a platform.' } });
  const token = String(body.token || '').trim();
  let handle = normalizeHandle(platform, body.handle);
  if (platform === 'instagram') {
    if (!/^[A-Za-z0-9_|.-]{20,600}$/.test(token)) {
      return sendJson(res, 400, { ok: false, error: { field: 'token', message: 'Paste your Instagram access token. The steps below show how to get one.' } });
    }
    handle = handle || 'me';
  } else if (!handle) {
    return sendJson(res, 400, { ok: false, error: { field: 'handle', message: `That doesn’t look like a ${p.name} name. Paste the profile link or the @name.` } });
  }
  try {
    const r = await readAccount(platform, handle, token);
    const key = sourceKey(platform, r.handle);
    if (platform === 'instagram') {
      config.tokens = { ...(config.tokens || {}), [key]: { token, savedAt: Date.now() } };
      writeJson(CONFIG_FILE, config, { pretty: true });
    }
    if (r.avatarUrl) checkedAvatars.set(key, r.avatarUrl);
    return sendJson(res, 200, {
      ok: true,
      account: { platform, handle: r.handle, name: r.name, url: r.url, metrics: r.metrics, avatar: r.avatarUrl ? `/api/avatar?key=${encodeURIComponent(key)}` : '' },
    });
  } catch (e) {
    if (!e.kind) console.error(e);
    return sendJson(res, 400, { ok: false, error: { field: e.kind === 'auth' ? 'token' : 'handle', kind: e.kind, message: e.message || 'Something went wrong.' } });
  }
}

// Profile pictures from other platforms, passed through this server: some platforms won't show them on
// other sites, and going through here lets the page read the logo's colours.
const avatarCache = new Map();
async function handleAvatar(req, res, key) {
  const src = sources.get(key);
  const url = (src && src.avatarUrl()) || checkedAvatars.get(key) || '';
  if (!/^https:\/\//.test(url)) return sendText(res, 404, 'Not found');
  let hit = avatarCache.get(url);
  if (!hit || Date.now() - hit.at > 6 * 3_600_000) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LiveViewCounter' }, signal: AbortSignal.timeout(10_000) });
      const type = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok || !type.startsWith('image/') || buf.length > 3_000_000) throw new Error(`status ${r.status}`);
      hit = { buf, type, at: Date.now() };
      if (avatarCache.size > 60) avatarCache.delete(avatarCache.keys().next().value);
      avatarCache.set(url, hit);
    } catch {
      if (!hit) return sendText(res, 404, 'Not found');
    }
  }
  res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : hit.buf);
}

// The last 24 hours of one counter, for the chart.
function handleHistory(res, id) {
  const c = (settings.counters || []).find((x) => x.id === id);
  if (!c) return sendJson(res, 404, { ok: false, points: [] });
  let points = [];
  if (c.platform === 'youtube') {
    if (c.metric === 'views' && tracker) points = tracker.historyPoints(86_400_000);
  } else {
    const src = sources.get(sourceKey(c.platform, c.handle));
    if (src) points = src.points(c.metric).filter((p) => p[0] >= Date.now() - 86_400_000);
  }
  return sendJson(res, 200, { ok: true, points });
}

// ---------- the user's own files: a tick sound and a background picture ----------
const UPLOADS = {
  sound: {
    file: SOUND_FILE, meta: SOUND_META_FILE, max: 2_100_000, tooBig: 'That file is too big. Use a short sound under 2 MB.',
    types: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac'],
    wrongType: 'Use an MP3, WAV, OGG or M4A sound file.',
  },
  background: {
    file: path.join(DATA_DIR, 'custom-background'), meta: path.join(DATA_DIR, 'custom-background.json'), max: 8_000_000,
    tooBig: 'That picture is too big. Use one under 8 MB.',
    types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
    wrongType: 'Use a JPG, PNG, WebP or GIF picture.',
  },
};
async function handleUpload(req, res, kind) {
  const u = UPLOADS[kind];
  if (!u) return sendJson(res, 404, { ok: false, error: { message: 'Not found' } });
  if (!changeAllowed(req)) return sendJson(res, 403, { ok: false, error: { message: 'Files can only be changed on the computer that runs the counter.' } });
  let body;
  try { body = await readBody(req, Math.ceil(u.max * 1.37) + 4096); } catch { return sendJson(res, 400, { ok: false, error: { message: u.tooBig } }); }
  if (body.remove) {
    try { fs.unlinkSync(u.file); } catch { /* already gone */ }
    try { fs.unlinkSync(u.meta); } catch { /* already gone */ }
    return sendJson(res, 200, { ok: true });
  }
  const type = String(body.type || '').toLowerCase();
  if (!u.types.includes(type)) return sendJson(res, 400, { ok: false, error: { message: u.wrongType } });
  const buf = Buffer.from(String(body.data || ''), 'base64');
  if (!buf.length) return sendJson(res, 400, { ok: false, error: { message: u.wrongType } });
  if (buf.length > u.max) return sendJson(res, 400, { ok: false, error: { message: u.tooBig } });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(u.file, buf);
  const meta = { type, name: String(body.name || kind).slice(0, 80), size: buf.length, at: Date.now() };
  writeJson(u.meta, meta);
  return sendJson(res, 200, { ok: true, name: meta.name, at: meta.at });
}
function serveUpload(req, res, kind) {
  const u = UPLOADS[kind];
  const meta = u && readJson(u.meta, null);
  if (!meta) return sendText(res, 404, 'Not found');
  fs.readFile(u.file, (err, buf) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': meta.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function startTracker() {
  if (tracker) {
    tracker.stop();
    tracker.removeAllListeners();
    tracker = null;
  }
  if (!config.apiKey || !config.channelId) {
    snapshot = setupSnapshot();
    broadcast();
    return;
  }
  tracker = new Tracker({
    apiKey: config.apiKey,
    channelId: config.channelId,
    budget: config.budget || DEFAULT_BUDGET,
    state,
    apiBase: API_BASE_URL,
    onDirty: scheduleSave,
  });
  tracker.on('update', (s) => {
    snapshot = s;
    broadcast();
  });
  snapshot = tracker.snapshot();
  broadcast();
  tracker.start();
}

// ---------- saving ----------
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 15_000);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (ownsState) writeJson(STATE_FILE, state);
}
function shutdown() {
  saveNow();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, shutdown); } catch { /* signal not available on this OS */ }
}

// ---------- live updates (Server-Sent Events) ----------
function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: settings\ndata: ${JSON.stringify({ settings, rev: settingsRev })}\n\n`);
  res.write(`data: ${JSON.stringify(current())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
function broadcast() {
  if (!clients.size) return;
  const frame = `data: ${JSON.stringify(current())}\n\n`;
  for (const c of clients) c.write(frame);
}
setInterval(() => {
  for (const c of clients) c.write(': keep-alive\n\n');
}, 20_000).unref();

// ---------- HTTP helpers ----------
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

// Blocks DNS-rebinding tricks: only answer the API for local names and plain IP addresses.
const HOSTNAME = os.hostname().toLowerCase();
function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === HOSTNAME || host.endsWith('.localhost') || host.endsWith('.local')
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}
// Settings can only be changed from this computer, by this app's own page.
function changeAllowed(req) {
  const a = req.socket.remoteAddress || '';
  const local = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const json = String(req.headers['content-type'] || '').includes('application/json');
  let sameOrigin = true;
  if (req.headers.origin) {
    try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
  }
  return local && json && sameOrigin;
}

function publicConfig() {
  const k = config.apiKey || '';
  return {
    configured: Boolean(k && config.channelId),
    keyHint: k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '',
    channelInput: config.channelInput || '',
    budget: config.budget || DEFAULT_BUDGET,
    lan: LAN,
    urls,
  };
}

async function handleConnect(req, res) {
  if (!changeAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: { message: 'Settings can only be changed on the computer that runs the counter.' } });
  }
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: { message: 'Bad request.' } }); }

  const apiKey = String(body.apiKey || '').trim() || config.apiKey || '';
  const channelInput = String(body.channel || '').trim() || config.channelInput || '';
  if (!apiKey) return sendJson(res, 400, { ok: false, error: { field: 'apiKey', message: 'Paste your YouTube Data API key.' } });
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) {
    return sendJson(res, 400, { ok: false, error: { field: 'apiKey', message: 'That doesn’t look like an API key. It’s one long piece of text with no spaces, and Google keys usually start with “AIza”.' } });
  }
  if (!channelInput) return sendJson(res, 400, { ok: false, error: { field: 'channel', message: 'Enter your channel’s @handle or a link to it.' } });

  const yt = createYouTube({ apiKey, base: API_BASE_URL, onCost: (n) => spendQuota(state, n, 'main') });
  try {
    const info = channelInfo(await resolveChannel(yt, channelInput));
    const budget = Number(body.budget ?? config.budget);
    config = {
      ...config,
      apiKey,
      channelId: info.id,
      channelInput,
      budget: Number.isFinite(budget) && budget >= 2_000 ? Math.round(budget) : DEFAULT_BUDGET,
      savedAt: new Date().toISOString(),
    };
    writeJson(CONFIG_FILE, config, { pretty: true });
    console.log(`  Now tracking: ${info.title}${info.handle ? ` (${info.handle})` : ''}`);
    startTracker();
    scheduleSave();
    return sendJson(res, 200, { ok: true, channel: { id: info.id, title: info.title, handle: info.handle, thumb: info.thumb } });
  } catch (e) {
    const kind = e.kind || 'error';
    const field = kind === 'auth' ? 'apiKey' : kind === 'notFound' || kind === 'bad' ? 'channel' : null;
    if (!e.kind) console.error(e);
    return sendJson(res, 400, { ok: false, error: { field, kind, message: e.message || 'Something went wrong.', link: e.link || '' } });
  }
}

function handleDisconnect(req, res) {
  if (!changeAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: { message: 'Settings can only be changed on the computer that runs the counter.' } });
  }
  config = config.tokens ? { tokens: config.tokens } : {}; // keep other platforms' tokens
  writeJson(CONFIG_FILE, config, { pretty: true });
  console.log('  Disconnected. The API key was removed from this computer.');
  startTracker();
  return sendJson(res, 200, { ok: true });
}

// ---------- Windows shortcuts: desktop icon, and starting with Windows ----------
const STARTUP_LNK = process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Live View Counter.lnk')
  : null;
const autostartEnabled = () => Boolean(STARTUP_LNK && fs.existsSync(STARTUP_LNK));

// Makes a shortcut that starts the counter hidden (node.exe opens minimized and exits at once).
// folder: 'Startup' or 'Desktop'. Resolves with the shortcut's path.
function makeShortcut(folder, extraArgs) {
  const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$dir = [Environment]::GetFolderPath($env:LVC_FOLDER)',
    "$file = Join-Path $dir 'Live View Counter.lnk'",
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($file)',
    '$s.TargetPath = $env:LVC_TARGET',
    '$s.Arguments = $env:LVC_ARGS',
    '$s.WorkingDirectory = $env:LVC_DIR',
    '$s.WindowStyle = 7',
    '$s.IconLocation = $env:LVC_ICON',
    "$s.Description = 'Your YouTube views, counting up live'",
    '$s.Save()',
    'Write-Output $file',
  ].join('; ');
  const env = {
    ...process.env,
    LVC_FOLDER: folder,
    LVC_TARGET: process.execPath,
    LVC_ARGS: [SERVER_FILE, '--background', ...keptArgs(), ...extraArgs].map(quote).join(' '),
    LVC_DIR: ROOT,
    LVC_ICON: `${ICON_FILE},0`,
  };
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env, windowsHide: true, timeout: 20_000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout.trim())));
  });
}

async function setAutostart(on) {
  if (!STARTUP_LNK) throw new Error('Starting with the computer is only set up for Windows.');
  if (on) await makeShortcut('Startup', []);
  else if (fs.existsSync(STARTUP_LNK)) fs.unlinkSync(STARTUP_LNK);
}

async function handleAutostart(req, res) {
  if (!changeAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: { message: 'Settings can only be changed on the computer that runs the counter.' } });
  }
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: { message: 'Bad request.' } }); }
  try {
    await setAutostart(Boolean(body.enabled));
    console.log(`  Start with Windows: ${autostartEnabled() ? 'on' : 'off'}`);
    return sendJson(res, 200, { ok: true, enabled: autostartEnabled() });
  } catch (e) {
    console.error('  Could not change start-with-Windows:', e.message);
    return sendJson(res, 500, { ok: false, enabled: autostartEnabled(), error: { message: `Couldn’t change that setting: ${e.message}` } });
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const CSP = "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendText(res, 400, 'Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

async function handle(req, res) {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) {
      if (!hostAllowed(req)) return sendJson(res, 403, { ok: false, error: { message: 'Forbidden' } });
      if (pathname === '/api/health') return sendJson(res, 200, { app: 'live-view-counter', ok: true });
      if (pathname === '/api/stream' && req.method === 'GET') return stream(req, res);
      if (pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, current());
      if (pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, publicConfig());
      if (pathname === '/api/connect' && req.method === 'POST') return await handleConnect(req, res);
      if (pathname === '/api/disconnect' && req.method === 'POST') return handleDisconnect(req, res);
      if (pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, { settings, rev: settingsRev });
      if (pathname === '/api/settings' && req.method === 'POST') return await handleSettings(req, res);
      if (pathname === '/api/accounts/check' && req.method === 'POST') return await handleCheckAccount(req, res);
      if (pathname === '/api/avatar' && (req.method === 'GET' || req.method === 'HEAD')) {
        return await handleAvatar(req, res, new URL(req.url, 'http://localhost').searchParams.get('key') || '');
      }
      if (pathname === '/api/history' && req.method === 'GET') return handleHistory(res, new URL(req.url, 'http://localhost').searchParams.get('counter') || '');
      const upload = pathname.match(/^\/api\/files\/(sound|background)$/);
      if (upload && (req.method === 'GET' || req.method === 'HEAD')) return serveUpload(req, res, upload[1]);
      if (upload && req.method === 'POST') return await handleUpload(req, res, upload[1]);
      if (pathname === '/api/autostart' && req.method === 'GET') return sendJson(res, 200, { supported: Boolean(STARTUP_LNK), enabled: autostartEnabled() });
      if (pathname === '/api/autostart' && req.method === 'POST') return await handleAutostart(req, res);
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        if (!changeAllowed(req)) return sendJson(res, 403, { ok: false, error: { message: 'Only this computer can stop the counter.' } });
        console.log('Stopped.');
        sendJson(res, 200, { ok: true });
        setTimeout(shutdown, 200);
        return;
      }
      return sendJson(res, 404, { ok: false, error: { message: 'Not found' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: { message: 'Server error' } });
    else res.end();
  }
}

// ---------- start ----------
const server = http.createServer(handle);

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  return new Promise((resolve) => exec(cmd, { windowsHide: true }, () => resolve()));
}

async function isOurServer(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'live-view-counter';
  } catch {
    return false;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function listen(port, triesLeft = 15) {
  const onError = async (e) => {
    if (e.code === 'EADDRINUSE') {
      if (await isOurServer(port)) {
        const url = `http://localhost:${port}`;
        console.log(`\n  Live View Counter is already running: ${url}\n`);
        if (flag('open')) openBrowser(url);
        setTimeout(() => process.exit(0), 500);
        return;
      }
      if (triesLeft > 0) return listen(port + 1, triesLeft - 1);
    }
    console.error(`\n  Could not start the server: ${e.message}\n`);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.off('error', onError);
    ownsState = true;
    // Also answer on the IPv6 loopback, for browsers that resolve "localhost" to ::1.
    if (!LAN) {
      const v6 = http.createServer(handle);
      v6.on('error', () => {});
      v6.listen(port, '::1');
    }
    const local = `http://localhost:${port}`;
    urls = [local, ...(LAN ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [])];
    if (HIDDEN) {
      console.log(`Live View Counter started in the background on ${local}`);
    } else {
      console.log('');
      console.log('  Live View Counter is running');
      console.log(`  Open ${local} in your browser`);
      if (LAN) for (const u of urls.slice(1)) console.log(`  On your phone (same Wi-Fi): ${u}`);
      console.log('  Keep this window open while you use the counter. Close it to stop.');
      console.log('  (Or run it in the background with no window: use "Start Live View Counter.bat".)');
      console.log('');
    }
    startTracker();
    syncSources();
    refreshTokens();
    if (flag('open')) openBrowser(local);
  });
}

// ---------- background mode, stopping, shortcuts ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRunning() {
  for (let p = START_PORT; p <= START_PORT + 15; p++) if (await isOurServer(p)) return p;
  return null;
}

// Start a hidden copy of the counter (unless one is already running), then optionally open it.
async function launchInBackground({ open }) {
  let port = await findRunning();
  if (!port) {
    const child = spawn(process.execPath, [SERVER_FILE, '--hidden', ...keptArgs()], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 60 && !port; i++) {
      await sleep(250);
      port = await findRunning();
    }
  }
  if (!port) {
    console.error(`\n  The counter didn't start. Details are in ${LOG_FILE}\n`);
    return false;
  }
  const url = `http://localhost:${port}`;
  console.log(`\n  Live View Counter is running in the background: ${url}`);
  console.log('  You can close this window. The counter keeps running.\n');
  if (open) await openBrowser(url);
  return true;
}

async function stopRunning() {
  const port = await findRunning();
  if (!port) {
    console.log('\n  Live View Counter isn’t running.\n');
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    console.log('\n  Live View Counter stopped.\n');
  } catch (e) {
    console.error(`\n  Couldn’t stop it: ${e.message}\n`);
  }
}

async function install() {
  if (process.platform !== 'win32') {
    console.log('\n  Shortcuts are only set up automatically on Windows. Starting the counter in the background instead.');
    return launchInBackground({ open: true });
  }
  const desktop = await makeShortcut('Desktop', ['--open']);
  console.log(`\n  Desktop shortcut: ${desktop}`);
  await setAutostart(true);
  console.log(`  Starts automatically when you sign in to Windows: ${STARTUP_LNK}`);
  return launchInBackground({ open: flag('open') });
}

async function uninstall() {
  await stopRunning();
  if (STARTUP_LNK && fs.existsSync(STARTUP_LNK)) fs.unlinkSync(STARTUP_LNK);
  const desktop = process.platform === 'win32' ? await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { windowsHide: true },
      (err, out) => resolve(err ? '' : out.trim()));
  }) : '';
  const lnk = desktop && path.join(desktop, 'Live View Counter.lnk');
  if (lnk && fs.existsSync(lnk)) fs.unlinkSync(lnk);
  console.log('  Removed the desktop shortcut and start-with-Windows. Your saved key and history are kept.\n');
}

function runCommand(task) {
  task().then(
    (ok) => setTimeout(() => process.exit(ok === false ? 1 : 0), 200),
    (e) => {
      console.error(`\n  Something went wrong: ${e.message}\n`);
      setTimeout(() => process.exit(1), 200);
    },
  );
}

if (flag('background')) runCommand(() => launchInBackground({ open: flag('open') }));
else if (flag('stop')) runCommand(stopRunning);
else if (flag('install')) runCommand(install);
else if (flag('uninstall')) runCommand(uninstall);
else listen(START_PORT);

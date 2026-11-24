// Live View Counter, website version (Vercel). Every /api/... address is sent here (see vercel.json).
//
// Visitors see the site owner's counters with each platform's own official numbers, checked about once
// a minute. Only the owner can change anything: they sign in with the ADMIN_PASSWORD environment
// variable. Settings and the latest numbers are kept in an Upstash Redis database connected in Vercel.
//
// How it differs from the local app (server.js):
// - YouTube: only the channel's official statistics from the YouTube Data API. No per-video tracking,
//   no estimated "live" count, pace, chart or 24-hour change, because YouTube's API policies don't
//   allow showing independently calculated metrics to the public.
// - Only platforms with official APIs: YouTube, Bluesky and Instagram.
// - Nothing personal about visitors is stored. Failed owner sign-ins store a keyed hash of the IP
//   address for 15 minutes, to stop password guessing.

import crypto from 'node:crypto';
import { cmd, pipeline, kvReady } from '../src/kv.js';
import { createYouTube, resolveChannel, channelInfo, CHANNEL_PARTS, YouTubeError } from '../src/youtube.js';
import { msUntilQuotaReset } from '../src/tracker.js';
import {
  PLATFORMS, readAccount, normalizeHandle, sourceKey, refreshInstagramToken, IG_REFRESH_EVERY_MS,
} from '../src/social.js';
import { cleanCounters } from '../src/counters.js';

// ---------- settings from Vercel's environment variables ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MIN_PASSWORD = 12;
const ENV_KEY = String(process.env.YOUTUBE_API_KEY || '').trim();
const OWNER_NAME = String(process.env.OWNER_NAME || '').trim().slice(0, 120);
const API_BASE_URL = process.env.LVC_API_BASE || undefined; // only for testing against a stand-in API

// ---------- limits and timings ----------
const HOSTED_PLATFORMS = ['youtube', 'bluesky', 'instagram'];
const EVERY = { youtube: 60_000, bluesky: 60_000, instagram: 120_000 }; // how often each is checked
// Shared answers are kept by Vercel's CDN (Vercel-CDN-Cache-Control, which Vercel removes before the
// answer reaches the browser), so many visitors cost about the same as one. Browsers always ask again.
const cdnCache = (seconds, staleSeconds = 0) => ({
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Vercel-CDN-Cache-Control': `max-age=${seconds}${staleSeconds ? `, stale-while-revalidate=${staleSeconds}` : ''}`,
});
const STATE_CACHE = cdnCache(30, 60);
const HISTORY_STEP_MS = 5 * 60_000;        // chart: at most one point every 5 minutes...
const HISTORY_KEEP_MS = 25 * 3_600_000;    // ...kept for 25 hours
const KEEP_STALE_MS = 30 * 86_400_000;     // numbers that couldn't be refreshed for 30 days are dropped
const LIVE_TTL_S = 30 * 86_400;            // and if nobody visits for 30 days, the database forgets them too
const SESSION_MS = 7 * 86_400_000;         // owner sign-in lasts a week
const FAIL_LIMIT = 8;                      // failed sign-ins per IP address...
const FAIL_WINDOW_S = 15 * 60;             // ...per 15 minutes
const LOCK_MS = 20_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const AVATAR_HOSTS = ['ggpht.com', 'googleusercontent.com', 'ytimg.com', 'bsky.app', 'cdninstagram.com', 'fbcdn.net'];
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

const UPLOADS = {
  sound: {
    max: 2_000_000, tooBig: 'That file is too big. Use a short sound under 2 MB.',
    types: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac'],
    wrongType: 'Use an MP3, WAV, OGG or M4A sound file.',
  },
  background: {
    max: 3_000_000, tooBig: 'That picture is too big. On the website, use one under 3 MB.',
    types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
    wrongType: 'Use a JPG, PNG, WebP or GIF picture.',
  },
};

// Database keys
const K = {
  settings: 'lvc:settings', // { settings, rev }: counters and how the page looks
  config: 'lvc:config',     // { apiKey?, channelId, channelInput, tokens }: never sent to the browser
  live: 'lvc:live',         // the latest numbers from each platform
  lock: 'lvc:lock',
  file: (kind) => `lvc:file:${kind}`,
  hist: (key, metric) => `lvc:hist:${key}:${metric}`,
  fail: (hash) => `lvc:fail:${hash}`,
};

const NO_DB = 'No database is connected. In Vercel, open this project → Storage, connect an Upstash Redis database, then redeploy.';

// ---------- small helpers ----------
const parse = (text, fallback) => {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};
const emptyLive = () => ({ yt: null, sources: {}, checked: {} });
const emptySaved = () => ({ settings: {}, rev: 0 });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url').slice(0, 10);

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}
const fail = (status, message, extra = {}) => json(status, { ok: false, error: { message, ...extra } });
const notFound = () => fail(404, 'Not found');

class UserError extends Error {
  constructor(message, field = null, status = 400) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

async function readBody(request, limit = 16_384) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw new UserError('That’s too big to send.', null, 413);
  const text = await request.text();
  if (text.length > limit) throw new UserError('That’s too big to send.', null, 413);
  try {
    const body = text ? JSON.parse(text) : {};
    if (!isObj(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new UserError('Bad request.');
  }
}

// ---------- the owner's sign-in ----------
const signInReady = () => ADMIN_PASSWORD.length >= MIN_PASSWORD;
const sessionKey = () => crypto.createHmac('sha256', process.env.SESSION_SECRET || ADMIN_PASSWORD).update('lvc-owner-session-v1').digest();
const signature = (exp) => crypto.createHmac('sha256', sessionKey()).update(`owner.${exp}`).digest('base64url');

function cookiesOf(request) {
  const out = {};
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isOwner(request) {
  if (!signInReady()) return false;
  const value = cookiesOf(request).lvc_owner || '';
  const [exp, sig] = value.split('.');
  if (!/^\d{10,16}$/.test(exp || '') || Number(exp) < Date.now() || !sig) return false;
  const want = Buffer.from(signature(exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site';
  try { return new URL(origin).host === host; } catch { return false; }
}

// Changes need: the owner's sign-in cookie, a request from this site's own page, and JSON.
function ownerCheck(request) {
  if (!isOwner(request)) return fail(403, 'Only the site owner can change this. Sign in first.');
  if (!sameOrigin(request) || !String(request.headers.get('content-type') || '').includes('application/json')) {
    return fail(403, 'Forbidden');
  }
  if (!kvReady()) return fail(503, NO_DB);
  return null;
}

function clientIp(request) {
  return request.headers.get('x-real-ip') || String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}
const ipHash = (ip) => crypto.createHmac('sha256', sessionKey()).update(`ip.${ip}`).digest('base64url').slice(0, 24);

const memoryFails = new Map(); // used only when no database is connected
async function failedTries(hash) {
  if (!kvReady()) {
    const f = memoryFails.get(hash);
    return f && f.until > Date.now() ? f.count : 0;
  }
  return Number(await cmd('GET', K.fail(hash))) || 0;
}
async function noteFailure(hash) {
  if (!kvReady()) {
    const f = memoryFails.get(hash);
    const live = f && f.until > Date.now();
    memoryFails.set(hash, { count: (live ? f.count : 0) + 1, until: live ? f.until : Date.now() + FAIL_WINDOW_S * 1000 });
    return;
  }
  // Starts a 15-minute window on the first failure; later failures count within it.
  await pipeline([['SET', K.fail(hash), 0, 'EX', FAIL_WINDOW_S, 'NX'], ['INCR', K.fail(hash)]]);
}

async function handleLogin(request) {
  if (!signInReady()) {
    return fail(503, ADMIN_PASSWORD
      ? `Owner sign-in is off: ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters. Change it in Vercel → Settings → Environment Variables, then redeploy.`
      : 'Owner sign-in isn’t set up. Add an ADMIN_PASSWORD environment variable in Vercel (Settings → Environment Variables), then redeploy.');
  }
  if (!sameOrigin(request)) return fail(403, 'Forbidden');
  const body = await readBody(request, 2_048);
  const hash = ipHash(clientIp(request));
  if (await failedTries(hash) >= FAIL_LIMIT) return fail(429, 'Too many wrong passwords. Wait 15 minutes, then try again.');
  const a = crypto.createHash('sha256').update(String(body.password || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    await noteFailure(hash);
    await sleep(400);
    return fail(401, 'That password isn’t right.', { field: 'password' });
  }
  if (kvReady()) await cmd('DEL', K.fail(hash));
  const exp = Date.now() + SESSION_MS;
  return json(200, { ok: true }, {
    'Set-Cookie': `lvc_owner=${exp}.${signature(exp)}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`,
  });
}

function handleLogout(request) {
  if (!sameOrigin(request)) return fail(403, 'Forbidden');
  return json(200, { ok: true }, { 'Set-Cookie': 'lvc_owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
}

// ---------- one writer at a time ----------
async function lock(waitMs) {
  const id = crypto.randomUUID();
  const until = Date.now() + waitMs;
  for (;;) {
    if ((await cmd('SET', K.lock, id, 'NX', 'PX', LOCK_MS)) === 'OK') return id;
    if (Date.now() >= until) return null;
    await sleep(250);
  }
}
async function unlock(id) {
  try {
    await cmd('EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, K.lock, id);
  } catch { /* it expires by itself */ }
}

// Loads everything, lets fn change it, and saves what changed. Returns null if the lock wasn't free.
async function withLock(waitMs, fn) {
  const id = await lock(waitMs);
  if (!id) return null;
  try {
    const [a, b, c] = await cmd('MGET', K.live, K.settings, K.config);
    const d = {
      live: { ...emptyLive(), ...parse(a, {}) },
      saved: { ...emptySaved(), ...parse(b, {}) },
      config: parse(c, null) || {},
      dirty: new Set(),
      ops: [],
    };
    const result = await fn(d);
    const ops = [];
    if (d.dirty.has('live')) ops.push(['SET', K.live, JSON.stringify(d.live), 'EX', LIVE_TTL_S]);
    if (d.dirty.has('settings')) ops.push(['SET', K.settings, JSON.stringify(d.saved)]);
    if (d.dirty.has('config')) ops.push(['SET', K.config, JSON.stringify(d.config)]);
    ops.push(...d.ops);
    if (ops.length) await pipeline(ops);
    return { d, result };
  } finally {
    await unlock(id);
  }
}

// ---------- reading the platforms ----------
function wantedSources(settings) {
  const out = new Map();
  for (const c of (settings && settings.counters) || []) {
    if (c.platform === 'youtube' || !HOSTED_PLATFORMS.includes(c.platform) || !c.handle) continue;
    out.set(sourceKey(c.platform, c.handle), { platform: c.platform, handle: c.handle });
  }
  return out;
}

function ytFromInfo(info, now) {
  return {
    channelId: info.id,
    channel: { id: info.id, title: info.title, handle: info.handle, thumbUrl: info.thumb, subs: info.subs, videoCount: info.videoCount },
    views: info.viewCount,
    status: 'live',
    error: null,
    checkedAt: now,
    okAt: now,
    nextAt: now + EVERY.youtube,
    failures: 0,
  };
}

async function refreshYouTube(d, now) {
  const { config, live } = d;
  const prev = live.yt && live.yt.channelId === config.channelId ? live.yt : { channelId: config.channelId, channel: null, views: null };
  try {
    const yt = createYouTube({ apiKey: ENV_KEY || config.apiKey, base: API_BASE_URL });
    const res = await yt.channels({ part: CHANNEL_PARTS, id: config.channelId });
    const item = res && Array.isArray(res.items) && res.items[0];
    if (!item) throw new YouTubeError('This channel can’t be found any more. It may have been deleted or made private.', { kind: 'notFound' });
    live.yt = ytFromInfo(channelInfo(item), now);
  } catch (e) {
    const kind = e instanceof YouTubeError ? e.kind : 'network';
    if (!(e instanceof YouTubeError)) console.error('YouTube:', e);
    const failures = (prev.failures || 0) + 1;
    let wait;
    let status;
    if (kind === 'quota') { wait = msUntilQuotaReset(now) + 60_000; status = 'quota'; }
    else if (kind === 'auth' || kind === 'bad' || kind === 'notFound') { wait = MAX_BACKOFF_MS; status = 'error'; }
    else { wait = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(failures - 1, 4)); status = 'offline'; }
    live.yt = {
      ...prev,
      status,
      error: { kind, message: e.message || 'Something went wrong talking to YouTube.', link: e.link || '', retryAt: now + wait, ...(kind === 'quota' ? { resetAt: now + wait } : {}) },
      checkedAt: now,
      nextAt: now + wait,
      failures,
    };
  }
  d.dirty.add('live');
}

async function refreshSource(d, key, s, now) {
  const { live, config } = d;
  const prev = live.sources[key] || { platform: s.platform, handle: s.handle, metrics: {}, failures: 0, histAt: 0 };
  const every = EVERY[s.platform] || 60_000;
  const token = s.platform === 'instagram' ? ((config.tokens || {})[key] || {}).token || '' : '';
  try {
    const r = await readAccount(s.platform, s.handle, token);
    const metrics = { ...(prev.metrics || {}) };
    for (const [m, v] of Object.entries(r.metrics)) if (v != null) metrics[m] = { value: v, at: now };
    const next = {
      platform: s.platform,
      handle: s.handle,
      info: { name: r.name, handle: r.handle, url: r.url, avatarUrl: r.avatarUrl },
      metrics,
      live: Boolean(r.live),
      status: 'live',
      error: null,
      checkedAt: now,
      okAt: now,
      nextAt: now + every * (0.9 + Math.random() * 0.2),
      failures: 0,
      histAt: prev.histAt || 0,
    };
    if (now - next.histAt >= HISTORY_STEP_MS) {
      // A sorted set per number, scored by time, so readings older than 25 hours are always removed.
      for (const [m, v] of Object.entries(r.metrics)) {
        if (v == null) continue;
        const hk = K.hist(key, m);
        d.ops.push(
          ['ZADD', hk, now, `${now}:${v}`],
          ['ZREMRANGEBYSCORE', hk, '-inf', `(${now - HISTORY_KEEP_MS}`],
          ['EXPIRE', hk, Math.ceil(HISTORY_KEEP_MS / 1000)],
        );
      }
      next.histAt = now;
    }
    live.sources[key] = next;
    if (live.checked) delete live.checked[key];
  } catch (e) {
    const kind = e.kind || 'error';
    if (!e.kind) console.error(`${key}:`, e);
    const failures = (prev.failures || 0) + 1;
    const lasting = kind === 'notFound' || kind === 'auth';
    const wait = lasting ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, every * 2 ** Math.min(failures, 6));
    live.sources[key] = {
      ...prev,
      status: lasting ? 'error' : 'offline',
      error: { kind, message: e.message || 'Something went wrong.', retryAt: now + wait },
      checkedAt: now,
      nextAt: now + wait,
      failures,
    };
  }
  d.dirty.add('live');
}

// Instagram tokens expire after 60 days unless renewed; renew them about once a week.
async function renewTokens(d, now) {
  for (const [key, t] of Object.entries(d.config.tokens || {})) {
    if (!key.startsWith('instagram:') || !t || !t.token) continue;
    if (now - (t.refreshedAt || t.savedAt || 0) < IG_REFRESH_EVERY_MS) continue;
    if (now - (t.triedAt || 0) < 6 * 3_600_000) continue;
    try {
      t.token = await refreshInstagramToken(t.token);
      t.refreshedAt = now;
      delete t.triedAt;
    } catch (e) {
      t.triedAt = now;
      console.warn(`Couldn’t renew the Instagram token for ${key.slice(10)}: ${e.message}`);
    }
    d.dirty.add('config');
  }
}

// What needs checking now?
function dueNow(live, saved, now) {
  if (live.yt && now >= (live.yt.nextAt || 0)) return true;
  // A YouTube counter but no YouTube numbers yet (for example after a long quiet spell): look again,
  // at most every 5 minutes in case YouTube simply isn't connected.
  const wantsYouTube = ((saved.settings && saved.settings.counters) || []).some((c) => c.platform === 'youtube');
  if (!live.yt && wantsYouTube && now - (live.ytLookedAt || 0) >= 5 * 60_000) return true;
  const wanted = wantedSources(saved.settings);
  for (const [key] of wanted) {
    const cur = live.sources[key];
    if (!cur || now >= (cur.nextAt || 0)) return true;
  }
  return Object.keys(live.sources).some((key) => !wanted.has(key));
}

async function refreshDue(d, now) {
  const { live, config, saved } = d;
  const jobs = [];
  if (!config.channelId || !(ENV_KEY || config.apiKey)) {
    live.yt = null;
    live.ytLookedAt = now;
    d.dirty.add('live');
  } else if (!live.yt || live.yt.channelId !== config.channelId || now >= (live.yt.nextAt || 0)) {
    jobs.push(refreshYouTube(d, now));
  }
  const wanted = wantedSources(saved.settings);
  if ([...wanted.keys()].some((k) => k.startsWith('instagram:'))) await renewTokens(d, now);
  for (const key of Object.keys(live.sources)) {
    if (!wanted.has(key)) { delete live.sources[key]; d.dirty.add('live'); }
  }
  // Pictures of accounts looked up in Settings but never added are forgotten after an hour.
  for (const [key, c] of Object.entries(live.checked || {})) {
    if (!wanted.has(key) && now - ((c && c.at) || 0) > 3_600_000) { delete live.checked[key]; d.dirty.add('live'); }
  }
  for (const [key, s] of wanted) {
    const cur = live.sources[key];
    if (!cur || now >= (cur.nextAt || 0)) jobs.push(refreshSource(d, key, s, now));
  }
  await Promise.all(jobs);
  // Numbers that haven't been refreshed for 30 days are deleted rather than kept.
  if (live.yt && live.yt.channel && now - (live.yt.okAt || 0) > KEEP_STALE_MS) {
    live.yt = { ...live.yt, channel: null, views: null };
    d.dirty.add('live');
  }
  for (const s of Object.values(live.sources)) {
    if (s.okAt && now - s.okAt > KEEP_STALE_MS && Object.keys(s.metrics || {}).length) {
      s.metrics = {};
      d.dirty.add('live');
    }
  }
}

// ---------- what the page gets ----------
const avatarPath = (key, url) => (url ? `/api/avatar?key=${encodeURIComponent(key)}&v=${shortHash(url)}` : '');

function snapshotOf(live, saved, now) {
  const yt = live.yt;
  const ch = yt && yt.channel;
  const sources = {};
  for (const [key, s] of Object.entries(live.sources || {})) {
    const info = s.info || {};
    const metrics = {};
    for (const [m, v] of Object.entries(s.metrics || {})) metrics[m] = { value: v.value, at: v.at, rate: null, day: null };
    sources[key] = {
      key,
      platform: s.platform,
      handle: info.handle || s.handle,
      name: info.name || s.handle,
      url: info.url || '',
      avatar: avatarPath(key, info.avatarUrl),
      live: Boolean(s.live),
      status: s.status || 'starting',
      error: s.error || null,
      checkedAt: s.checkedAt || null,
      every: EVERY[s.platform] || 60_000,
      metrics,
    };
  }
  return {
    app: 'live-view-counter',
    hosted: true,
    status: yt ? yt.status || 'starting' : 'setup',
    error: yt ? yt.error || null : null,
    channel: ch ? { id: ch.id, title: ch.title, handle: ch.handle, thumb: avatarPath('youtube', ch.thumbUrl), subs: ch.subs, videoCount: ch.videoCount } : null,
    total: ch && yt.views != null ? yt.views : null,
    official: ch && yt.views != null ? yt.views : null,
    updatedAt: (yt && yt.okAt) || null,
    checkedAt: (yt && yt.checkedAt) || null,
    serverTime: now,
    rate: null,
    lastHour: null,
    lastDay: null,
    sources,
    settings: { settings: isObj(saved.settings) ? saved.settings : {}, rev: saved.rev || 0 },
  };
}

async function handleState() {
  if (!kvReady()) return json(200, snapshotOf(emptyLive(), emptySaved(), Date.now()), STATE_CACHE);
  const [a, b] = await cmd('MGET', K.live, K.settings);
  let live = { ...emptyLive(), ...parse(a, {}) };
  let saved = { ...emptySaved(), ...parse(b, {}) };
  const now = Date.now();
  if (dueNow(live, saved, now)) {
    const done = await withLock(0, (d) => refreshDue(d, now));
    if (done) ({ live, saved } = done.d);
  }
  return json(200, snapshotOf(live, saved, Date.now()), STATE_CACHE);
}

async function handleConfig(request) {
  const admin = isOwner(request);
  const out = {
    hosted: true,
    admin,
    signIn: signInReady(),
    db: kvReady(),
    owner: OWNER_NAME,
    envKey: Boolean(ENV_KEY),
    platforms: HOSTED_PLATFORMS,
    lan: false,
    urls: [],
  };
  if (admin && kvReady()) {
    const config = parse(await cmd('GET', K.config), null) || {};
    const key = ENV_KEY || config.apiKey || '';
    out.configured = Boolean(key && config.channelId);
    out.keyHint = config.apiKey && !ENV_KEY ? `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-4)}` : '';
    out.channelInput = config.channelInput || '';
  }
  return json(200, out);
}

// ---------- the owner's changes ----------
function cleanSettings(next) {
  next.counters = cleanCounters(next.counters, HOSTED_PLATFORMS);
  // Background pictures must be uploaded here: links to other sites would load them from there.
  if (isObj(next.look) && typeof next.look.bgImage === 'string' && !/^(upload:\d{1,16})?$/.test(next.look.bgImage)) next.look.bgImage = '';
  next.privacy = { analytics: Boolean(isObj(next.privacy) && next.privacy.analytics === true) };
  return next;
}

async function handleSettingsSave(request) {
  const denied = ownerCheck(request);
  if (denied) return denied;
  const body = await readBody(request, 200_000);
  if (!isObj(body.settings)) throw new UserError('Bad request.');
  const next = cleanSettings(body.settings);
  const done = await withLock(5_000, async (d) => {
    const before = wantedSources(d.saved.settings);
    const after = wantedSources(next);
    d.saved = { settings: next, rev: Math.max(Date.now(), (d.saved.rev || 0) + 1) };
    d.dirty.add('settings');
    // Forget accounts no counter uses any more: their chart history and (for Instagram) the token.
    for (const [key, s] of before) {
      if (after.has(key)) continue;
      for (const m of (PLATFORMS[s.platform] || { metrics: [] }).metrics) d.ops.push(['DEL', K.hist(key, m)]);
    }
    for (const [key, t] of Object.entries(d.config.tokens || {})) {
      if (after.has(key) || Date.now() - ((t && t.savedAt) || 0) < 3_600_000) continue;
      delete d.config.tokens[key];
      d.dirty.add('config');
    }
    await refreshDue(d, Date.now()); // newly added accounts are read straight away
    return snapshotOf(d.live, d.saved, Date.now());
  });
  if (!done) return fail(503, 'The site is busy. Try again in a moment.');
  return json(200, { ok: true, rev: done.d.saved.rev, counters: next.counters, state: done.result });
}

async function handleConnect(request) {
  const denied = ownerCheck(request);
  if (denied) return denied;
  const body = await readBody(request);
  if (body.agree !== true) throw new UserError('Tick the box to agree to the terms first.', 'agree');
  const apiKey = ENV_KEY ? '' : String(body.apiKey || '').trim();
  if (apiKey && !/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) {
    throw new UserError('That doesn’t look like an API key. It’s one long piece of text with no spaces, and Google keys usually start with “AIza”.', 'apiKey');
  }
  try {
    const done = await withLock(5_000, async (d) => {
      const key = ENV_KEY || apiKey || d.config.apiKey || '';
      if (!key) throw new UserError('Paste your YouTube Data API key.', 'apiKey');
      const channelInput = String(body.channel || '').trim().slice(0, 300) || d.config.channelInput || '';
      if (!channelInput) throw new UserError('Enter your channel’s @handle or a link to it.', 'channel');
      const info = channelInfo(await resolveChannel(createYouTube({ apiKey: key, base: API_BASE_URL }), channelInput));
      d.config = { ...d.config, channelId: info.id, channelInput, savedAt: new Date().toISOString() };
      if (ENV_KEY) delete d.config.apiKey;
      else d.config.apiKey = key;
      d.dirty.add('config');
      d.live.yt = ytFromInfo(info, Date.now());
      d.dirty.add('live');
      return info;
    });
    if (!done) return fail(503, 'The site is busy. Try again in a moment.');
    const info = done.result;
    return json(200, {
      ok: true,
      channel: { id: info.id, title: info.title, handle: info.handle },
      state: snapshotOf(done.d.live, done.d.saved, Date.now()),
    });
  } catch (e) {
    if (!(e instanceof YouTubeError)) throw e;
    const field = e.kind === 'auth' ? 'apiKey' : e.kind === 'notFound' || e.kind === 'bad' ? 'channel' : null;
    return fail(400, e.message || 'Something went wrong.', { field, kind: e.kind, link: e.link || '' });
  }
}

async function handleDisconnect(request) {
  const denied = ownerCheck(request);
  if (denied) return denied;
  const done = await withLock(5_000, (d) => {
    d.config = d.config.tokens ? { tokens: d.config.tokens } : {}; // keep Instagram tokens
    d.live.yt = null;
    d.dirty.add('config');
    d.dirty.add('live');
  });
  if (!done) return fail(503, 'The site is busy. Try again in a moment.');
  return json(200, { ok: true, state: snapshotOf(done.d.live, done.d.saved, Date.now()) });
}

// Looks an account up before it's added, so typos show up straight away.
async function handleCheckAccount(request) {
  const denied = ownerCheck(request);
  if (denied) return denied;
  const body = await readBody(request, 4_096);
  const platform = String(body.platform || '');
  if (!HOSTED_PLATFORMS.includes(platform) || platform === 'youtube') {
    throw new UserError('On the website you can add Bluesky and Instagram accounts (and your YouTube channel under App).');
  }
  const p = PLATFORMS[platform];
  const token = String(body.token || '').trim();
  let handle = normalizeHandle(platform, body.handle);
  if (platform === 'instagram') {
    if (!/^[A-Za-z0-9_|.-]{20,600}$/.test(token)) throw new UserError('Paste your Instagram access token. The steps below show how to get one.', 'token');
    handle = handle || 'me';
  } else if (!handle) {
    throw new UserError(`That doesn’t look like a ${p.name} name. Paste the profile link or the @name.`, 'handle');
  }
  let r;
  try {
    r = await readAccount(platform, handle, token);
  } catch (e) {
    if (!e.kind) console.error(e);
    return fail(400, e.message || 'Something went wrong.', { field: e.kind === 'auth' ? 'token' : 'handle', kind: e.kind });
  }
  const key = sourceKey(platform, r.handle);
  const done = await withLock(5_000, (d) => {
    if (platform === 'instagram') {
      d.config.tokens = { ...(d.config.tokens || {}), [key]: { token, savedAt: Date.now() } };
      d.dirty.add('config');
    }
    if (r.avatarUrl) {
      const checked = { ...(d.live.checked || {}), [key]: { url: r.avatarUrl, at: Date.now() } };
      d.live.checked = Object.fromEntries(Object.entries(checked).slice(-10));
      d.dirty.add('live');
    }
  });
  if (!done) return fail(503, 'The site is busy. Try again in a moment.');
  return json(200, {
    ok: true,
    account: { platform, handle: r.handle, name: r.name, url: r.url, metrics: r.metrics, avatar: avatarPath(key, r.avatarUrl) },
  });
}

// ---------- pictures and files ----------
// Profile pictures are passed through this site, so visitors' browsers never contact the platforms.
function avatarAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AVATAR_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function handleAvatar(request, url) {
  const key = url.searchParams.get('key') || '';
  const miss = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60', 'Vercel-CDN-Cache-Control': 'max-age=60' } });
  if (!kvReady()) return miss();
  const live = { ...emptyLive(), ...parse(await cmd('GET', K.live), {}) };
  let src = '';
  if (key === 'youtube') src = (live.yt && live.yt.channel && live.yt.channel.thumbUrl) || '';
  else src = ((live.sources[key] || {}).info || {}).avatarUrl || ((live.checked || {})[key] || {}).url || '';
  if (!avatarAllowed(src)) return miss();
  let r;
  try {
    r = await fetch(src, { headers: { 'User-Agent': 'LiveViewCounter (+website)' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return miss();
  }
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || !AVATAR_TYPES.includes(type) || buf.length > 3_000_000) return miss();
  return new Response(request.method === 'HEAD' ? null : buf, {
    // (The address changes when the picture does, so it can be kept for a while.)
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Vercel-CDN-Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function serveUpload(request, url, kind) {
  const meta = kvReady() ? parse(await cmd('GET', K.file(kind)), null) : null;
  if (!meta || !meta.data) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const versioned = url.searchParams.has('v');
  return new Response(request.method === 'HEAD' ? null : Buffer.from(meta.data, 'base64'), {
    headers: {
      'Content-Type': meta.type,
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      // Each upload gets a new ?v=, so Vercel's CDN can keep this copy instead of reading the database
      // again. Only for a day, so a removed file doesn't stay reachable there for long.
      ...(versioned ? { 'Vercel-CDN-Cache-Control': 'max-age=86400' } : {}),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function handleUpload(request, kind) {
  const denied = ownerCheck(request);
  if (denied) return denied;
  const u = UPLOADS[kind];
  let body;
  try {
    body = await readBody(request, Math.ceil(u.max * 1.37) + 4_096);
  } catch (e) {
    if (e.status === 413) throw new UserError(u.tooBig);
    throw e;
  }
  if (body.remove) {
    await cmd('DEL', K.file(kind));
    return json(200, { ok: true });
  }
  const type = String(body.type || '').toLowerCase();
  if (!u.types.includes(type)) throw new UserError(u.wrongType);
  const data = String(body.data || '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new UserError(u.wrongType);
  const size = Buffer.byteLength(data, 'base64');
  if (size > u.max) throw new UserError(u.tooBig);
  const meta = { type, name: String(body.name || kind).slice(0, 80), size, at: Date.now() };
  await cmd('SET', K.file(kind), JSON.stringify({ ...meta, data }));
  return json(200, { ok: true, name: meta.name, at: meta.at });
}

// The last 24 hours of a Bluesky or Instagram counter, for the chart. (YouTube counters have no chart here.)
async function handleHistory(url) {
  const cache = cdnCache(120, 120);
  if (!kvReady()) return json(200, { ok: true, points: [] }, cache);
  const saved = { ...emptySaved(), ...parse(await cmd('GET', K.settings), {}) };
  const id = url.searchParams.get('counter') || '';
  const c = ((saved.settings && saved.settings.counters) || []).find((x) => x.id === id);
  if (!c) return json(404, { ok: false, points: [] }, cache);
  if (c.platform === 'youtube' || !c.handle) return json(200, { ok: true, points: [] }, cache);
  const since = Date.now() - 86_400_000;
  const list = (await cmd('ZRANGEBYSCORE', K.hist(sourceKey(c.platform, c.handle), c.metric), since, '+inf')) || [];
  const points = list
    .map((s) => String(s).split(':').map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= since);
  return json(200, { ok: true, points }, cache);
}

async function handleSettingsGet() {
  const saved = kvReady() ? { ...emptySaved(), ...parse(await cmd('GET', K.settings), {}) } : emptySaved();
  return json(200, { settings: saved.settings, rev: saved.rev }, STATE_CACHE);
}

// ---------- routing ----------
async function route(request) {
  const url = new URL(request.url);
  let path = url.searchParams.get('__path');
  if (path == null) path = url.pathname.replace(/^\/api\/?/, '');
  path = path.replace(/^\/+|\/+$/g, '');
  if (path === 'index') path = '';
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';

  if (path === '' || path === 'health') return json(200, { app: 'live-view-counter', ok: true, hosted: true, db: kvReady() });
  if (path === 'state' && read) return handleState();
  if (path === 'config' && read) return handleConfig(request);
  if (path === 'settings' && read) return handleSettingsGet();
  if (path === 'settings' && method === 'POST') return handleSettingsSave(request);
  if (path === 'history' && read) return handleHistory(url);
  if (path === 'avatar' && read) return handleAvatar(request, url);
  const file = path.match(/^files\/(sound|background)$/);
  if (file && read) return serveUpload(request, url, file[1]);
  if (file && method === 'POST') return handleUpload(request, file[1]);
  if (path === 'connect' && method === 'POST') return handleConnect(request);
  if (path === 'disconnect' && method === 'POST') return handleDisconnect(request);
  if (path === 'accounts/check' && method === 'POST') return handleCheckAccount(request);
  if (path === 'admin/login' && method === 'POST') return handleLogin(request);
  if (path === 'admin/logout' && method === 'POST') return handleLogout(request);
  return notFound();
}

export default {
  async fetch(request) {
    try {
      return await route(request);
    } catch (e) {
      if (e instanceof UserError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
      console.error(e);
      return fail(500, 'Something went wrong on the server. Try again in a moment.');
    }
  },
};

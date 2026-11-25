// Live View Counter, website version (Vercel). Every /api/... address is sent here (see vercel.json).
//
// A free public site: anyone aged 13 or over can make an account (a username and a password, no email
// address) and watch their own YouTube channel's and Bluesky profiles' numbers. Each account has a
// counter page at /u/<username>, which is private until its owner makes it public. Accounts and
// settings live in an Upstash Redis database connected in Vercel.
//
// - Passwords are stored only as scrypt hashes. A one-time recovery code (also stored only as a hash)
//   resets a forgotten password, so the site never needs an email address.
// - Sessions are signed cookies. "Sign out on all devices" and changing the password end every session.
// - Numbers: the site's own YouTube API key reads every watched channel in batches of up to 50 for one
//   quota unit, and Bluesky's public API reads profiles 25 at a time. The latest readings sit in one
//   shared cache, so many pages and viewers cost about the same as one. The site owner pastes the key on
//   /admin (it's kept in the database and never sent to any browser); a YOUTUBE_API_KEY set in Vercel
//   is used when none is saved there.
// - Official numbers only: no estimates, pace, charts or 24-hour change (YouTube's API policies don't
//   allow showing calculated metrics). Readings nobody has asked for in a week are dropped, and numbers
//   that couldn't be refreshed for 30 days are deleted.
// - The site owner (ADMIN_PASSWORD) uses /admin to add the YouTube API key, and to look up, suspend or
//   delete an account, for reports.

import crypto from 'node:crypto';
import { cmd, pipeline, kvReady } from '../src/kv.js';
import { createYouTube, parseChannelInput, channelInfo, YouTubeError } from '../src/youtube.js';
import { msUntilQuotaReset } from '../src/tracker.js';
import { normalizeHandle } from '../src/social.js';
import { cleanCounters } from '../src/counters.js';

// ---------- settings from Vercel's environment variables ----------
const env = process.env;
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const ENV_YT_KEY = String(env.YOUTUBE_API_KEY || '').trim(); // used when no key is saved on /admin
const OWNER_NAME = String(env.OWNER_NAME || '').trim().slice(0, 120);
const MAX_USERS = Math.max(1, Math.min(1_000_000, Math.floor(Number(env.MAX_USERS)) || 300));
const SIGNUPS_OPEN = String(env.SIGNUPS || '').trim().toLowerCase() !== 'closed';
const ANALYTICS = ['1', 'true', 'on', 'yes'].includes(String(env.WEB_ANALYTICS || '').trim().toLowerCase());
const YT_BASE = env.LVC_API_BASE || undefined; // only for testing against stand-in APIs
const BSKY_BASE = String(env.LVC_BSKY_BASE || 'https://public.api.bsky.app').replace(/\/+$/, '');

// ---------- limits and timings ----------
const PLATFORMS = ['youtube', 'bluesky'];
const TERMS_VERSION = '2026-11-25';
const MIN_ADMIN_PASSWORD = 12;
const REFRESH_MS = 60_000;               // each watched channel or profile is read about once a minute
const WANT_MS = 10 * 60_000;             // ...for 10 minutes after a page last asked for it
const WANT_RENEW_MS = 4 * 60_000;        // pages that are open renew that every few minutes
const DROP_MS = 7 * 86_400_000;          // readings nobody has asked for in a week are dropped
const KEEP_STALE_MS = 30 * 86_400_000;   // numbers that couldn't be refreshed for 30 days are deleted
const MAX_BACKOFF_MS = 10 * 60_000;
const ACCOUNT_TTL_S = 365 * 86_400;      // accounts unused for 12 months are deleted
const REMEMBER_MS = 30 * 86_400_000;     // "Keep me signed in"
const SESSION_MS = 12 * 3_600_000;       // otherwise: until the browser closes, and at most 12 hours
const ADMIN_SESSION_MS = 12 * 3_600_000;
const LOCK_MS = 30_000;
const AVATAR_HOSTS = ['ggpht.com', 'googleusercontent.com', 'ytimg.com', 'bsky.app'];
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const cdnCache = (seconds, staleSeconds = 0) => ({
  // Kept by Vercel's CDN (which removes this header before the browser sees it); browsers always ask again.
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Vercel-CDN-Cache-Control': `max-age=${seconds}${staleSeconds ? `, stale-while-revalidate=${staleSeconds}` : ''}`,
});
const PAGE_CACHE = cdnCache(60, 60);

// Tries allowed per window (seconds) before the site says "wait".
const LIMITS = {
  signinIp: { max: 10, window: 900 },
  signinName: { max: 10, window: 900 },
  recoverIp: { max: 10, window: 900 },
  recoverName: { max: 5, window: 900 },
  signup: { max: 5, window: 3600 },
  admin: { max: 8, window: 900 },
  lookup: { max: 30, window: 3600 },     // channel and profile lookups per account
};

// Database keys
const K = {
  secret: 'lvc:secret',
  user: (name) => `lvc:u:${name}`,        // one account: login, settings and page, as JSON
  touch: (name) => `lvc:t:${name}`,       // "this page was opened today" (keeps an account alive)
  lock: (name) => `lvc:lock:${name}`,
  count: 'lvc:count',
  cache: 'lvc:cache',                     // the latest readings of every watched channel and profile
  ytKey: 'lvc:ytkey',                     // the YouTube API key saved on /admin (never sent to browsers)
  cacheLock: 'lvc:cache:lock',
  rl: (bucket, id) => `lvc:rl:${bucket}:${id}`,
};
// Left over from the single-owner version of the site; removed when the admin page is opened.
const LEGACY_KEYS = ['lvc:settings', 'lvc:config', 'lvc:live', 'lvc:lock', 'lvc:file:sound', 'lvc:file:background'];

const NO_DB = 'The site’s database isn’t connected, so accounts don’t work right now. Please try again later.';
const UNAVAILABLE = 'YouTube numbers aren’t available on this site right now. Please try again later.';
const NOT_SET_UP = 'YouTube isn’t switched on for this site yet, so channels can’t be added right now. Please check back soon.';
const BUSY = 'The site is busy. Try again in a moment.';

// ---------- small helpers ----------
const parse = (text, fallback) => {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url').slice(0, 10);
const num = (v) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n >= 0 ? n : null;
};
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}
const fail = (status, message, extra = {}, headers = {}) => json(status, { ok: false, error: { message, ...extra } }, headers);
const notFound = () => fail(404, 'Not found');

class UserError extends Error {
  constructor(message, field = null, status = 400, extra = {}) {
    super(message);
    this.field = field;
    this.status = status;
    this.extra = extra;
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

function cookiesOf(request) {
  const out = {};
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site';
  try { return new URL(origin).host === host; } catch { return false; }
}

// Every change must come from this site's own pages, as JSON, with the database connected.
function guard(request) {
  if (!sameOrigin(request) || !String(request.headers.get('content-type') || '').includes('application/json')) {
    throw new UserError('Forbidden', null, 403);
  }
  if (!kvReady()) throw new UserError(NO_DB, null, 503);
}

function clientIp(request) {
  return request.headers.get('x-real-ip') || String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// ---------- the secret that signs cookies ----------
// SESSION_SECRET if it's set (32+ characters), otherwise a random one made once and kept in the database.
let secretPromise = null;
function getSecret() {
  if (!secretPromise) {
    secretPromise = (async () => {
      const fromEnv = String(env.SESSION_SECRET || '');
      if (fromEnv.length >= 32) return fromEnv;
      if (!kvReady()) throw new UserError(NO_DB, null, 503);
      await cmd('SET', K.secret, crypto.randomBytes(32).toString('base64url'), 'NX');
      const s = await cmd('GET', K.secret);
      if (!s) throw new Error('No cookie secret.');
      return String(s);
    })().catch((e) => {
      secretPromise = null;
      throw e;
    });
  }
  return secretPromise;
}
const sign = async (text) => crypto.createHmac('sha256', await getSecret()).update(text).digest('base64url');
// A coded version of the visitor's IP address, for limiting tries. It can't be turned back into the address.
const ipId = async (request) => (await sign(`ip.${clientIp(request)}`)).slice(0, 22);

// ---------- passwords and recovery codes ----------
const SCRYPT = { N: 16_384, r: 8, p: 5, keylen: 32 }; // OWASP's minimum strength for scrypt
function scryptAsync(password, salt, o) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt, SCRYPT);
  return `s1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 's1') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64url');
  const got = await scryptAsync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: want.length });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// Unknown usernames take as long to answer as wrong passwords.
let dummyPromise = null;
const dummyHash = () => dummyPromise || (dummyPromise = hashPassword(crypto.randomBytes(18).toString('base64url')));

const COMMON_PASSWORDS = new Set([
  'password12', 'password123', 'password1234', 'password12345', '1234567890', '12345678910', '0987654321', 'qwertyuiop',
  'qwerty1234', 'qwerty12345', '1q2w3e4r5t', 'iloveyou12', 'iloveyou123', 'passwordpassword', 'abcdefghij', 'abc1234567',
  'football123', 'letmein123', 'welcome123', 'changeme123', 'asdfghjkl1', 'administrator', 'liveviewcounter', 'livecounter',
  'youtube123', 'subscribe123', 'minecraft123', 'aaaaaaaaaa', '1111111111', 'qwertyuiop1', 'password1!', 'password123!',
]);
function passwordProblem(password, name) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters. Three random words together works well.';
  if (password.length > 200) return 'That password is too long. Use 200 characters or fewer.';
  const lower = password.toLowerCase();
  if (name && lower.includes(name)) return 'Don’t put your username in your password.';
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too easy to guess. Try three random words together.';
  return '';
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters, no 0/O or 1/I
function newRecoveryCode() {
  let s = '';
  for (const b of crypto.randomBytes(20)) s += CODE_ALPHABET[b & 31];
  return s.match(/.{4}/g).join('-'); // 20 characters, 100 bits
}
const cleanCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const codeHash = (name, code) => `h1$${crypto.createHash('sha256').update(`lvc-recovery.${name}.${cleanCode(code)}`).digest('base64url')}`;

// ---------- usernames ----------
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/; // 3 to 24 characters
const RESERVED = new Set([
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app', 'assets', 'billing', 'blog', 'bluesky', 'contact',
  'cookies', 'dashboard', 'delete', 'docs', 'email', 'forgot', 'google', 'help', 'home', 'info', 'legal', 'live', 'login',
  'logout', 'mail', 'moderator', 'news', 'noreply', 'null', 'official', 'owner', 'password', 'privacy', 'public', 'register',
  'report', 'reports', 'root', 'security', 'settings', 'signin', 'signout', 'signup', 'site', 'staff', 'static', 'status',
  'support', 'system', 'team', 'terms', 'undefined', 'upstash', 'user', 'users', 'vercel', 'webmaster', 'www', 'youtube',
]);
const cleanName = (v) => String(v || '').trim().replace(/^@/, '').toLowerCase();

// ---------- accounts in the database ----------
async function getUser(name) {
  return NAME_RE.test(name) ? parse(await cmd('GET', K.user(name)), null) : null;
}

async function lock(key, waitMs) {
  const id = crypto.randomUUID();
  const until = Date.now() + waitMs;
  for (;;) {
    if ((await cmd('SET', key, id, 'NX', 'PX', LOCK_MS)) === 'OK') return id;
    if (Date.now() >= until) return null;
    await sleep(200);
  }
}
async function unlock(key, id) {
  try {
    await cmd('EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, key, id);
  } catch { /* it expires by itself */ }
}

// Loads an account, lets fn change it, and saves it (which also restarts its 12-month clock).
async function withUser(name, fn) {
  const id = await lock(K.lock(name), 5_000);
  if (!id) throw new UserError(BUSY, null, 503);
  try {
    const rec = await getUser(name);
    if (!rec) throw new UserError('That account doesn’t exist any more.', null, 404);
    const result = await fn(rec);
    await cmd('SET', K.user(name), JSON.stringify(rec), 'EX', ACCOUNT_TTL_S);
    return { rec, result };
  } finally {
    await unlock(K.lock(name), id);
  }
}

async function deleteUser(name) {
  const id = await lock(K.lock(name), 5_000);
  if (!id) throw new UserError(BUSY, null, 503);
  try {
    const [gone] = await pipeline([['DEL', K.user(name)], ['DEL', K.touch(name)]]);
    if (Number(gone) > 0) await cmd('DECR', K.count);
  } finally {
    await unlock(K.lock(name), id);
  }
}

// Tries counted per window: [bucket, id] pairs.
async function overLimit(pairs) {
  const values = await cmd('MGET', ...pairs.map(([b, id]) => K.rl(b, id)));
  return pairs.some(([b], i) => (Number(values[i]) || 0) >= LIMITS[b].max);
}
const countTry = (bucket, id) => [['SET', K.rl(bucket, id), 0, 'EX', LIMITS[bucket].window, 'NX'], ['INCR', K.rl(bucket, id)]];

async function spendLookup(name) {
  const res = await pipeline(countTry('lookup', name));
  if (Number(res[1]) > LIMITS.lookup.max) throw new UserError('That’s a lot of lookups in a short time. Wait a while, then try again.', null, 429);
}

const publicOf = (rec) => Boolean(rec.page && rec.page.public);
const pagePath = (rec) => `/u/${rec.name}`;
function notSuspended(rec) {
  if (rec.suspended) {
    throw new UserError('Your page has been suspended, so it can’t be changed. Email noobvexbusiness@gmail.com if you think this is a mistake.', null, 403);
  }
}

// ---------- sessions ----------
const SESSION_COOKIE = 'lvc_session';
const ADMIN_COOKIE = 'lvc_admin';

async function sessionCookie(rec, remember) {
  const exp = Date.now() + (remember ? REMEMBER_MS : SESSION_MS);
  const sig = await sign(`session.${rec.name}.${rec.gen}.${exp}`);
  return `${SESSION_COOKIE}=${rec.name}.${rec.gen}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? `; Max-Age=${REMEMBER_MS / 1000}` : ''}`;
}
const END_SESSION = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// Who the cookie says is signed in (checked against the account's session number by the caller).
async function sessionOf(request) {
  const raw = cookiesOf(request)[SESSION_COOKIE];
  if (!raw || !kvReady()) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [name, gen, exp, sig] = parts;
  if (!NAME_RE.test(name) || !/^\d{1,9}$/.test(gen) || !/^\d{10,16}$/.test(exp) || Number(exp) <= Date.now()) return null;
  if (!safeEqual(sig, await sign(`session.${name}.${gen}.${exp}`))) return null;
  return { name, gen: Number(gen), exp: Number(exp) };
}
const sessionValid = (s, rec) => Boolean(s && rec && rec.name === s.name && Number(rec.gen) === s.gen);
const remembered = (s) => s.exp - Date.now() > SESSION_MS;

async function signedIn(request) {
  const s = await sessionOf(request);
  if (!s) return null;
  const rec = await getUser(s.name);
  return sessionValid(s, rec) ? { rec, session: s } : null;
}
async function requireUser(request) {
  const me = await signedIn(request);
  if (!me) throw new UserError('You’re signed out. Sign in again.', null, 401, { signIn: true });
  return me;
}

// The site owner's moderation sign-in (ADMIN_PASSWORD). Changing the password signs them out.
const adminReady = () => ADMIN_PASSWORD.length >= MIN_ADMIN_PASSWORD;
const adminTag = () => crypto.createHash('sha256').update(`lvc-admin.${ADMIN_PASSWORD}`).digest('base64url').slice(0, 16);
async function isAdmin(request) {
  if (!adminReady() || !kvReady()) return false;
  const [exp, sig] = String(cookiesOf(request)[ADMIN_COOKIE] || '').split('.');
  if (!/^\d{10,16}$/.test(exp || '') || Number(exp) <= Date.now() || !sig) return false;
  return safeEqual(sig, await sign(`admin.${adminTag()}.${exp}`));
}

// ---------- the shared cache of readings ----------
function cacheOf(text) {
  const c = parse(text, null);
  const out = { yt: isObj(c && c.yt) ? c.yt : {}, bs: isObj(c && c.bs) ? c.bs : {} };
  if (c && isObj(c.keyIssue)) out.keyIssue = c.keyIssue; // the last problem Google had with the API key (for /admin)
  return out;
}

// ---------- the site's YouTube API key ----------
// The key saved on /admin wins; otherwise YOUTUBE_API_KEY from Vercel. Remembered for a minute per
// server instance, so pages don't ask the database every time. Never sent to a browser.
const KEY_RE = /^[A-Za-z0-9_-]{30,100}$/;
let keyMemo = { at: 0, saved: null };
function rememberKey(text) {
  const v = parse(text, null);
  keyMemo = { at: Date.now(), saved: isObj(v) && typeof v.key === 'string' && KEY_RE.test(v.key) ? v : null };
  return keyMemo.saved;
}
async function savedKey(fresh = false) {
  if (!kvReady()) return null;
  if (!fresh && Date.now() - keyMemo.at < 60_000) return keyMemo.saved;
  return rememberKey(await cmd('GET', K.ytKey));
}
const keyToUse = (saved) => (saved && saved.key) || ENV_YT_KEY;
// A page owner's own key, pasted when they set up their page (kept with their account, never sent out).
const ownKeyOf = (rec) => (rec && isObj(rec.ytKey) && typeof rec.ytKey.key === 'string' && KEY_RE.test(rec.ytKey.key) ? rec.ytKey.key : '');
const ownKeyHint = (rec) => (ownKeyOf(rec) ? `…${rec.ytKey.key.slice(-4)}` : '');
const siteKey = async (fresh = false) => keyToUse(await savedKey(fresh).catch(() => keyMemo.saved));

// What an account's page needs read: its YouTube channel and its Bluesky profiles.
function wantsOf(rec) {
  if (rec.suspended) return { yt: [], bs: [] };
  const yt = rec.yt && rec.yt.channelId ? [rec.yt.channelId] : [];
  const bs = [];
  for (const c of (isObj(rec.settings) && Array.isArray(rec.settings.counters) ? rec.settings.counters : [])) {
    if (c && c.platform === 'bluesky' && c.handle && !bs.includes(c.handle)) bs.push(c.handle);
  }
  return { yt, bs };
}

function needsReading(cache, wants, now, ownKey = '') {
  const stale = (e) => !e || now >= (e.nextAt || 0) || now - (e.wantAt || 0) > WANT_RENEW_MS;
  const trySite = Boolean(keyToUse(keyMemo.saved)); // (as last seen: this is only a quick check)
  return wants.yt.some((id) => stale(cache.yt[id]) || otherKeyFailed(cache.yt[id], ownKey, trySite)) || wants.bs.some((h) => stale(cache.bs[h]));
}

// True when a channel's last reading failed because of a key this page doesn't use (another page
// owner's, or the site's), so reading it again with this page's key straight away may work.
function otherKeyFailed(e, ownKey, siteKeyThere) {
  const err = e && e.error;
  if (!err) return false;
  if (ownKey) return !err.mine && (err.kind === 'quota' || err.kind === 'unavailable');
  return Boolean(err.mine) && Boolean(siteKeyThere);
}

// extra.mine: the problem is with the page owner's own API key (only they see the details).
function setFailed(e, kind, message, now, extra = {}) {
  e.failures = (e.failures || 0) + 1;
  let wait;
  let status;
  if (kind === 'quota') { wait = msUntilQuotaReset(now) + 60_000; status = 'quota'; }
  else if (kind === 'notFound' || kind === 'unavailable' || kind === 'ownKey') { wait = MAX_BACKOFF_MS; status = 'error'; }
  else { wait = Math.min(MAX_BACKOFF_MS, REFRESH_MS * 2 ** Math.min(e.failures - 1, 4)); status = 'offline'; }
  e.status = status;
  e.error = {
    kind, message, retryAt: now + wait, ...(kind === 'quota' ? { resetAt: now + wait } : {}),
    ...(extra.mine ? { mine: true } : {}), ...(extra.link ? { link: extra.link } : {}),
  };
  e.checkedAt = now;
  e.nextAt = now + wait;
}
function setRead(e, info, now) {
  Object.assign(e, { info, status: 'live', error: null, okAt: now, checkedAt: now, nextAt: now + REFRESH_MS, failures: 0 });
}
const ytInfo = (info) => ({
  id: info.id, title: info.title, handle: info.handle, thumb: info.thumb, subs: info.subs, videoCount: info.videoCount, views: info.viewCount,
});

// Reads channels with one API key: the site's (shared, in batches of 50) or, with mine = true, a
// page owner's own key (just their channel).
async function readYouTube(cache, ids, now, apiKey, mine = false) {
  if (!ids.length) return;
  if (!apiKey) {
    for (const id of ids) setFailed(cache.yt[id], 'unavailable', UNAVAILABLE, now);
    return;
  }
  const yt = createYouTube({ apiKey, base: YT_BASE, timeoutMs: 12_000 });
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const res = await yt.channels({ part: 'snippet,statistics', id: chunk.join(','), maxResults: 50 });
      if (!mine) delete cache.keyIssue;
      const found = new Map((Array.isArray(res && res.items) ? res.items : []).map((it) => [it.id, it]));
      for (const id of chunk) {
        const item = found.get(id);
        if (item) setRead(cache.yt[id], ytInfo(channelInfo(item)), now);
        else setFailed(cache.yt[id], 'notFound', 'YouTube can’t find this channel any more. It may have been deleted or made private.', now);
      }
    } catch (err) {
      const kind = err instanceof YouTubeError ? err.kind : 'network';
      if (!mine && (!(err instanceof YouTubeError) || kind === 'auth' || kind === 'bad')) console.error('YouTube:', err.message || err);
      let message = 'Can’t reach YouTube right now. Trying again soon.';
      let k = kind;
      let extra = {};
      if (mine && (kind === 'quota' || kind === 'auth' || kind === 'bad')) {
        // The page owner's own key: tell them exactly what Google said (visitors see a plain message).
        extra = { mine: true, link: err.link || '' };
        if (kind === 'quota') message = 'Your API key’s free YouTube allowance for today is used up. Numbers update again after midnight Pacific time.';
        else { message = `Your API key stopped working. ${String(err.message || 'Google refused it.').slice(0, 300)}`; k = 'ownKey'; }
      } else if (kind === 'quota') message = 'This site has used up today’s YouTube allowance. Numbers update again after midnight Pacific time.';
      else if (kind === 'auth' || kind === 'bad' || kind === 'notFound') { message = UNAVAILABLE; k = 'unavailable'; }
      if (!mine && (kind === 'quota' || kind === 'auth' || kind === 'bad')) {
        cache.keyIssue = { kind, message: String(err.message || '').slice(0, 300), link: err.link || '', at: now };
      }
      for (const id of chunk) setFailed(cache.yt[id], k, message, now, extra);
    }
  }
}

async function bskyProfiles(actors) {
  const qs = actors.map((a) => `actors=${encodeURIComponent(a)}`).join('&');
  const r = await fetch(`${BSKY_BASE}/xrpc/app.bsky.actor.getProfiles?${qs}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !Array.isArray(j.profiles)) {
    const e = new Error(`Bluesky answered ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j.profiles;
}
const bskyInfo = (p) => ({
  name: p.displayName || p.handle, handle: p.handle, url: `https://bsky.app/profile/${p.handle}`, avatar: p.avatar || '',
  followers: num(p.followersCount), posts: num(p.postsCount),
});

async function readBluesky(cache, handles, now) {
  for (let i = 0; i < handles.length; i += 25) {
    const chunk = handles.slice(i, i + 25);
    let profiles;
    try {
      profiles = await bskyProfiles(chunk);
    } catch (err) {
      // One bad name shouldn't stop everyone else's: read them one at a time instead.
      if (err.status === 400 && chunk.length > 1) {
        for (const h of chunk) await readBluesky(cache, [h], now);
        continue;
      }
      if (err.status === 400) {
        setFailed(cache.bs[chunk[0]], 'notFound', `Bluesky can’t find ${chunk[0]}. If the account changed its name, add it again.`, now);
        continue;
      }
      console.warn('Bluesky:', err.message);
      for (const h of chunk) setFailed(cache.bs[h], 'offline', 'Can’t reach Bluesky right now. Trying again soon.', now);
      continue;
    }
    const byKey = new Map();
    for (const p of profiles) {
      if (!p) continue;
      if (p.handle) byKey.set(String(p.handle).toLowerCase(), p);
      if (p.did) byKey.set(String(p.did).toLowerCase(), p);
    }
    for (const h of chunk) {
      const p = byKey.get(h);
      if (p) setRead(cache.bs[h], bskyInfo(p), now);
      else setFailed(cache.bs[h], 'notFound', `Bluesky can’t find ${h}. If the account changed its name, add it again.`, now);
    }
  }
}

function prune(cache, now) {
  for (const map of [cache.yt, cache.bs]) {
    for (const [k, e] of Object.entries(map)) {
      if (!isObj(e) || now - (e.wantAt || 0) > DROP_MS) { delete map[k]; continue; }
      if (e.info && e.okAt && now - e.okAt > KEEP_STALE_MS) delete e.info;
    }
  }
}

// Notes what this page wants, then reads everything wanted recently that's due (in batches).
// ownKey: the page owner's own YouTube API key, if they saved one. Their channel is then read with it
// (by their page, whoever is looking at it), and while that page is being looked at, it's left out of
// the site key's shared batches.
// Returns the new cache, or null if another request is already doing this.
async function readNow(wants, now, change, ownKey = '') {
  const id = await lock(K.cacheLock, 0);
  if (!id) return null;
  try {
    const [cacheText, keyText] = await cmd('MGET', K.cache, K.ytKey); // (one command for both)
    const cache = cacheOf(cacheText);
    const apiKey = keyToUse(rememberKey(keyText));
    if (change) change(cache);
    for (const cid of wants.yt) {
      const e = (cache.yt[cid] = isObj(cache.yt[cid]) ? cache.yt[cid] : {});
      e.wantAt = now;
      if (ownKey) e.ownAt = now;
      delete e.own; // (an earlier version's flag)
    }
    for (const h of wants.bs) (cache.bs[h] = isObj(cache.bs[h]) ? cache.bs[h] : {}).wantAt = now;
    // (Things due in the next 20 seconds are read too, so they line up and are read together.)
    const due = (map) => Object.keys(map).filter((k) => now - (map[k].wantAt || 0) <= WANT_MS && now + 20_000 >= (map[k].nextAt || 0));
    const dueYt = due(cache.yt);
    for (const cid of wants.yt) if (!dueYt.includes(cid) && otherKeyFailed(cache.yt[cid], ownKey, apiKey)) dueYt.push(cid);
    const mine = ownKey ? dueYt.filter((cid) => wants.yt.includes(cid)) : [];
    // A channel someone is watching with their own key is read with that key, not the site's (unless
    // this page wants it too and the site has a key).
    const ownWatched = (cid) => now - (cache.yt[cid].ownAt || 0) <= WANT_MS;
    const shared = dueYt.filter((cid) => !mine.includes(cid) && (!ownWatched(cid) || (apiKey && wants.yt.includes(cid)))).slice(0, 500);
    await Promise.all([
      readYouTube(cache, shared, now, apiKey),
      readYouTube(cache, mine, now, ownKey, true),
      readBluesky(cache, due(cache.bs).slice(0, 250), now),
    ]);
    prune(cache, now);
    await cmd('SET', K.cache, JSON.stringify(cache));
    return cache;
  } finally {
    await unlock(K.cacheLock, id);
  }
}

// ---------- what a counter page gets ----------
const avatarPath = (key, url) => (url ? `/api/avatar?key=${encodeURIComponent(key)}&v=${shortHash(url)}` : '');

function snapshotOf(rec, cache, now, own) {
  const settings = isObj(rec.settings) ? rec.settings : {};
  const sources = {};
  for (const c of Array.isArray(settings.counters) ? settings.counters : []) {
    if (!c || c.platform !== 'bluesky' || !c.handle) continue;
    const key = `bluesky:${c.handle}`;
    if (sources[key]) continue;
    const e = isObj(cache.bs[c.handle]) ? cache.bs[c.handle] : {};
    const i = e.info || null;
    const metrics = {};
    if (i && i.followers != null) metrics.followers = { value: i.followers, at: e.okAt, rate: null, day: null };
    if (i && i.posts != null) metrics.posts = { value: i.posts, at: e.okAt, rate: null, day: null };
    sources[key] = {
      key,
      platform: 'bluesky',
      handle: i ? i.handle : c.handle,
      name: i ? i.name : c.handle,
      url: i ? i.url : `https://bsky.app/profile/${c.handle}`,
      avatar: i ? avatarPath(key, i.avatar) : '',
      live: false,
      status: e.status || 'starting',
      error: e.error || null,
      checkedAt: e.checkedAt || null,
      every: REFRESH_MS,
      metrics,
    };
  }
  const cid = rec.yt && rec.yt.channelId;
  const y = cid && isObj(cache.yt[cid]) ? cache.yt[cid] : null;
  const info = y && y.info;
  let error = (y && y.error) || null;
  const ownKey = ownKeyOf(rec);
  if (error && error.mine && !(own && ownKey)) {
    // Problems with the owner's own API key are theirs to see; visitors get a plain message.
    error = {
      kind: error.kind === 'quota' ? 'quota' : 'unavailable',
      message: error.kind === 'quota' ? 'Today’s YouTube allowance for this page is used up. Numbers update again after midnight Pacific time.' : UNAVAILABLE,
      retryAt: error.retryAt,
      ...(error.resetAt ? { resetAt: error.resetAt } : {}),
    };
  } else if (error && own && !ownKey && error.kind === 'unavailable' && !keyToUse(keyMemo.saved)) {
    error = { ...error, message: 'This site has no shared YouTube key at the moment. Paste your own free API key in Settings, under Channel, to carry on.' };
  }
  return {
    app: 'live-view-counter',
    hosted: true,
    page: { name: rec.name, own: Boolean(own), public: publicOf(rec) },
    status: cid ? (y && y.status) || 'starting' : 'setup',
    error,
    channel: info ? {
      id: info.id, title: info.title, handle: info.handle, thumb: avatarPath(`youtube:${info.id}`, info.thumb), subs: info.subs, videoCount: info.videoCount,
    } : null,
    total: info ? info.views : null,
    official: info ? info.views : null,
    updatedAt: (y && y.okAt) || null,
    checkedAt: (y && y.checkedAt) || null,
    serverTime: now,
    rate: null,
    lastHour: null,
    lastDay: null,
    sources,
    settings: { settings, rev: rec.rev || 0 },
  };
}

async function pageSnapshot(rec, cacheText, own) {
  let cache = cacheOf(cacheText);
  const wants = wantsOf(rec);
  const now = Date.now();
  if (needsReading(cache, wants, now, ownKeyOf(rec))) {
    const fresh = await readNow(wants, now, null, ownKeyOf(rec)).catch((e) => { console.error('Reading:', e); return null; });
    if (fresh) cache = fresh;
  }
  return snapshotOf(rec, cache, Date.now(), own);
}

// An account whose page is opened (by anyone) stays for another 12 months. Checked once a day.
async function touch(name, touchedToday) {
  if (touchedToday) return;
  try {
    await pipeline([['SET', K.touch(name), 1, 'EX', 86_400], ['EXPIRE', K.user(name), ACCOUNT_TTL_S]]);
  } catch (e) { console.warn('Touch:', e.message); }
}

// /u/<name> for everyone else: public pages only. (The owner's own browser uses /api/me/state, which
// also works while the page is private.) Answers are the same for everyone, so the CDN can keep them.
async function handlePageState(name) {
  const missing = () => fail(404, 'There’s nothing to see here. This page may be private, or the account may not exist.', { kind: 'missing' }, cdnCache(30));
  name = cleanName(name);
  if (!NAME_RE.test(name) || !kvReady()) return missing();
  const [u, c, t] = await cmd('MGET', K.user(name), K.cache, K.touch(name));
  const rec = parse(u, null);
  if (!rec || !publicOf(rec) || rec.suspended) return missing();
  await touch(name, t);
  return json(200, await pageSnapshot(rec, c, false), PAGE_CACHE);
}

// The signed-in user's own page (for editing): never cached.
async function handleMyState(request) {
  const s = await sessionOf(request);
  if (!s) return fail(401, 'You’re signed out. Sign in again.', { signIn: true });
  const [u, c, t] = await cmd('MGET', K.user(s.name), K.cache, K.touch(s.name));
  const rec = parse(u, null);
  if (!sessionValid(s, rec)) return fail(401, 'You’re signed out. Sign in again.', { signIn: true });
  await touch(s.name, t);
  return json(200, await pageSnapshot(rec, c, true));
}

// ---------- site config ----------
async function handleConfig(request) {
  const out = {
    hosted: true,
    db: kvReady(),
    signIn: kvReady(),
    signUp: SIGNUPS_OPEN && kvReady(),
    owner: OWNER_NAME,
    envKey: false,                 // everyone can paste their own YouTube API key (or use the site's)
    ytAvailable: Boolean(await siteKey()), // the site owner added a key that everyone can use
    platforms: PLATFORMS,
    analytics: ANALYTICS,
    lan: false,
    urls: [],
    user: null,
    moderator: false,
  };
  if (kvReady()) {
    const me = await signedIn(request).catch(() => null);
    if (me) {
      const r = me.rec;
      out.user = { name: r.name, suspended: Boolean(r.suspended), public: publicOf(r), page: pagePath(r) };
      out.configured = Boolean(r.yt && r.yt.channelId);
      out.channelInput = (r.yt && r.yt.channelInput) || '';
      out.keyHint = ownKeyHint(r); // only the last 4 characters of their own key, if they saved one
    }
    out.moderator = await isAdmin(request).catch(() => false);
  }
  return json(200, out);
}

// ---------- sign up, sign in, sign out, recover ----------
async function handleSignup(request) {
  guard(request);
  const body = await readBody(request, 4_096);
  if (!SIGNUPS_OPEN) throw new UserError('New accounts are paused right now. Please try again later.', null, 403);
  if (body.website) throw new UserError('Couldn’t make the account. Please try again.'); // a box only bots fill in
  const name = cleanName(body.username);
  if (!name) throw new UserError('Choose a username.', 'username');
  if (!NAME_RE.test(name)) {
    throw new UserError('Use 3 to 24 lowercase letters, numbers, dashes (-) or underscores (_), starting and ending with a letter or number.', 'username');
  }
  if (RESERVED.has(name)) throw new UserError('That username isn’t available. Try another.', 'username');
  const password = String(body.password || '');
  const problem = passwordProblem(password, name);
  if (problem) throw new UserError(problem, 'password');
  if (body.age !== true) throw new UserError('You need to be 13 or older to make an account.', 'age');
  if (body.agree !== true) throw new UserError('Tick the box to agree to the Terms.', 'agree');

  const ip = await ipId(request);
  const [count, tries] = await cmd('MGET', K.count, K.rl('signup', ip));
  if ((Number(tries) || 0) >= LIMITS.signup.max) throw new UserError('Too many new accounts from your connection. Try again in an hour.', null, 429);
  if ((Number(count) || 0) >= MAX_USERS) throw new UserError('The site is full right now, so new accounts are paused. Please try again later.', null, 503);

  const code = newRecoveryCode();
  const now = Date.now();
  const rec = {
    v: 1,
    name,
    pw: await hashPassword(password),
    rc: codeHash(name, code),
    gen: 1,
    createdAt: now,
    pwAt: now,
    signInAt: now,
    terms: TERMS_VERSION,
    agreedAt: now,
    page: { public: false },
    settings: {},
    rev: 0,
    yt: null,
  };
  const made = await cmd('SET', K.user(name), JSON.stringify(rec), 'NX', 'EX', ACCOUNT_TTL_S);
  if (made !== 'OK') throw new UserError('That username is taken. Try another.', 'username', 409);
  await pipeline([['INCR', K.count], ...countTry('signup', ip)]);
  return json(200, { ok: true, name, page: pagePath(rec), recoveryCode: code }, { 'Set-Cookie': await sessionCookie(rec, body.remember === true) });
}

async function handleSignin(request) {
  guard(request);
  const body = await readBody(request, 4_096);
  const name = cleanName(body.username);
  const password = String(body.password || '');
  if (!name) throw new UserError('Enter your username.', 'username');
  if (!password) throw new UserError('Enter your password.', 'password');
  const ip = await ipId(request);
  const nameId = NAME_RE.test(name) ? name : '_';
  if (await overLimit([['signinIp', ip], ['signinName', nameId]])) {
    throw new UserError('Too many wrong tries. Wait 15 minutes and try again, or reset your password with your recovery code.', null, 429);
  }
  const rec = await getUser(name);
  const good = rec ? await checkPassword(password, rec.pw) : (await checkPassword(password, await dummyHash()), false);
  if (!good) {
    await pipeline([...countTry('signinIp', ip), ...countTry('signinName', nameId)]);
    await sleep(300);
    throw new UserError('That username and password don’t match.', 'password', 401);
  }
  const { rec: next } = await withUser(name, (r) => { r.signInAt = Date.now(); });
  await cmd('DEL', K.rl('signinName', name));
  return json(200, { ok: true, name, page: pagePath(next) }, { 'Set-Cookie': await sessionCookie(next, body.remember === true) });
}

function handleSignout(request) {
  if (!sameOrigin(request)) throw new UserError('Forbidden', null, 403);
  return json(200, { ok: true }, { 'Set-Cookie': END_SESSION });
}

async function handleRecover(request) {
  guard(request);
  const body = await readBody(request, 4_096);
  const name = cleanName(body.username);
  const code = cleanCode(body.code);
  const password = String(body.password || '');
  if (!name) throw new UserError('Enter your username.', 'username');
  if (!code) throw new UserError('Enter your recovery code.', 'code');
  const ip = await ipId(request);
  const nameId = NAME_RE.test(name) ? name : '_';
  if (await overLimit([['recoverIp', ip], ['recoverName', nameId]])) {
    throw new UserError('Too many wrong tries. Wait 15 minutes, then try again.', null, 429);
  }
  const rec = await getUser(name);
  if (!rec || !safeEqual(codeHash(name, code), rec.rc || '')) {
    await pipeline([...countTry('recoverIp', ip), ...countTry('recoverName', nameId)]);
    await sleep(300);
    throw new UserError('That username and recovery code don’t match.', 'code', 401);
  }
  const problem = passwordProblem(password, name);
  if (problem) throw new UserError(problem, 'password');
  const hash = await hashPassword(password);
  const fresh = newRecoveryCode();
  const { rec: next } = await withUser(name, (r) => {
    r.pw = hash;
    r.rc = codeHash(name, fresh);
    r.gen = (Number(r.gen) || 0) + 1; // signs out every other device
    r.pwAt = Date.now();
    r.signInAt = Date.now();
  });
  await pipeline([['DEL', K.rl('recoverName', name)], ['DEL', K.rl('signinName', name)]]);
  return json(200, { ok: true, name, page: pagePath(next), recoveryCode: fresh }, { 'Set-Cookie': await sessionCookie(next, false) });
}

// ---------- the signed-in user's account ----------
async function handleMe(request) {
  const me = await signedIn(request);
  if (!me) return fail(401, 'You’re signed out. Sign in again.', { signIn: true });
  const r = me.rec;
  return json(200, {
    ok: true,
    name: r.name,
    createdAt: r.createdAt,
    signInAt: r.signInAt,
    pwAt: r.pwAt,
    sessionEnds: me.session.exp,
    remembered: remembered(me.session),
    suspended: r.suspended ? { reason: r.suspended.reason || '' } : null,
    public: publicOf(r),
    page: pagePath(r),
    youtube: r.yt ? { input: r.yt.channelInput || r.yt.channelId } : null,
    keyHint: ownKeyHint(r),
    counters: isObj(r.settings) && Array.isArray(r.settings.counters) ? r.settings.counters.length : 0,
  });
}

async function checkCurrentPassword(rec, password, field) {
  if (await overLimit([['signinName', rec.name]])) throw new UserError('Too many wrong tries. Wait 15 minutes, then try again.', null, 429);
  if (!password || !(await checkPassword(password, rec.pw))) {
    await pipeline(countTry('signinName', rec.name));
    await sleep(300);
    throw new UserError('That password isn’t right.', field, 400);
  }
}

async function handlePassword(request) {
  guard(request);
  const { rec, session } = await requireUser(request);
  const body = await readBody(request, 4_096);
  await checkCurrentPassword(rec, String(body.current || ''), 'current');
  const password = String(body.password || '');
  const problem = passwordProblem(password, rec.name);
  if (problem) throw new UserError(problem, 'password');
  const hash = await hashPassword(password);
  const { rec: next } = await withUser(rec.name, (r) => {
    r.pw = hash;
    r.pwAt = Date.now();
    r.gen = (Number(r.gen) || 0) + 1; // other devices are signed out; this one gets a new cookie
  });
  return json(200, { ok: true }, { 'Set-Cookie': await sessionCookie(next, remembered(session)) });
}

async function handleNewCode(request) {
  guard(request);
  const { rec } = await requireUser(request);
  const body = await readBody(request, 4_096);
  await checkCurrentPassword(rec, String(body.password || ''), 'password');
  const code = newRecoveryCode();
  await withUser(rec.name, (r) => { r.rc = codeHash(r.name, code); });
  return json(200, { ok: true, recoveryCode: code });
}

async function handleSignoutAll(request) {
  guard(request);
  const { rec } = await requireUser(request);
  await withUser(rec.name, (r) => { r.gen = (Number(r.gen) || 0) + 1; });
  return json(200, { ok: true }, { 'Set-Cookie': END_SESSION });
}

async function handleDelete(request) {
  guard(request);
  const { rec } = await requireUser(request);
  const body = await readBody(request, 4_096);
  if (cleanName(body.confirm) !== rec.name) throw new UserError('Type your username to confirm.', 'confirm');
  await checkCurrentPassword(rec, String(body.password || ''), 'password');
  await deleteUser(rec.name);
  return json(200, { ok: true }, { 'Set-Cookie': END_SESSION });
}

async function handleExport(request) {
  const { rec, session } = await requireUser(request);
  const data = {
    about: 'Everything Live View Counter keeps about your account. Your password and recovery code are kept only as one-way coded versions (hashes), so they can’t be shown here.',
    exportedAt: iso(Date.now()),
    account: {
      username: rec.name,
      createdAt: iso(rec.createdAt),
      lastSignIn: iso(rec.signInAt),
      passwordChangedAt: iso(rec.pwAt),
      agreedToTerms: { version: rec.terms || null, at: iso(rec.agreedAt) },
      confirmedAged13OrOver: true,
      suspended: rec.suspended ? { at: iso(rec.suspended.at), reason: rec.suspended.reason || '' } : false,
      thisSignInEnds: iso(session.exp),
    },
    page: {
      address: pagePath(rec),
      public: publicOf(rec),
      youtubeChannel: rec.yt ? { channelId: rec.yt.channelId, whatYouTyped: rec.yt.channelInput || '', connectedAt: iso(rec.yt.savedAt) } : null,
      // (Your own key itself isn't put in this file, so a copy can't leak from your downloads.)
      yourYouTubeKey: ownKeyOf(rec) ? { saved: true, endsWith: rec.ytKey.key.slice(-4), savedAt: iso(rec.ytKey.addedAt) } : null,
      settings: isObj(rec.settings) ? rec.settings : {},
    },
  };
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="live-view-counter-${rec.name}.json"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function handleVisibility(request) {
  guard(request);
  const { rec } = await requireUser(request);
  notSuspended(rec);
  const body = await readBody(request, 1_024);
  if (typeof body.public !== 'boolean') throw new UserError('Bad request.');
  const { rec: next } = await withUser(rec.name, (r) => { r.page = { ...(isObj(r.page) ? r.page : {}), public: body.public }; });
  return json(200, { ok: true, public: publicOf(next), page: pagePath(next) });
}

// ---------- changing the page ----------
function cleanSettings(input) {
  const out = JSON.parse(JSON.stringify(input));
  out.counters = cleanCounters(out.counters, PLATFORMS);
  if (isObj(out.look)) {
    out.look.bgImage = '';                       // no uploaded or linked pictures on the website
    if (out.look.bg === 'image') out.look.bg = 'aurora';
    out.look.stats = false;                      // official numbers only: no pace or 24-hour change
    out.look.chart = false;
  }
  if (isObj(out.sound)) {
    if (out.sound.type === 'custom') out.sound.type = 'click'; // no uploaded sounds on the website
    delete out.sound.customName;
    delete out.sound.customAt;
  }
  delete out.privacy;
  return out;
}

async function handleSettingsSave(request) {
  guard(request);
  const { rec } = await requireUser(request);
  notSuspended(rec);
  const body = await readBody(request, 60_000);
  if (!isObj(body.settings)) throw new UserError('Bad request.');
  const next = cleanSettings(body.settings);
  const { rec: saved } = await withUser(rec.name, (r) => {
    r.settings = next;
    r.rev = Math.max(Date.now(), (Number(r.rev) || 0) + 1);
  });
  let cache = cacheOf(await cmd('GET', K.cache));
  const wants = wantsOf(saved);
  if (needsReading(cache, wants, Date.now(), ownKeyOf(saved))) cache = (await readNow(wants, Date.now(), null, ownKeyOf(saved)).catch(() => null)) || cache; // new accounts are read straight away
  return json(200, { ok: true, rev: saved.rev, counters: next.counters, state: snapshotOf(saved, cache, Date.now(), true) });
}

// Finds a channel from what the user typed. Never uses YouTube's search (100 units a time).
async function findChannel(yt, raw) {
  const q = parseChannelInput(raw);
  if (!q || q.by === 'search') {
    throw new YouTubeError('Enter the channel’s @handle (like @yourname), or paste a link to the channel or one of its videos.', { kind: 'bad' });
  }
  const PARTS = 'snippet,statistics';
  const first = (res) => (res && Array.isArray(res.items) && res.items[0]) || null;
  let item = null;
  if (q.by === 'id') item = first(await yt.channels({ part: PARTS, id: q.value }));
  else if (q.by === 'handle') item = first(await yt.channels({ part: PARTS, forHandle: q.value }));
  else if (q.by === 'username') item = first(await yt.channels({ part: PARTS, forUsername: q.value }));
  else if (q.by === 'video') {
    const v = first(await yt.videos({ part: 'snippet', id: q.value }));
    if (v && v.snippet && v.snippet.channelId) item = first(await yt.channels({ part: PARTS, id: v.snippet.channelId }));
  } else if (q.by === 'name') {
    item = first(await yt.channels({ part: PARTS, forHandle: `@${q.value}` })) || first(await yt.channels({ part: PARTS, forUsername: q.value }));
  }
  if (!item) {
    throw new YouTubeError(`Couldn’t find a YouTube channel for “${String(raw).trim().slice(0, 100)}”. Try the @handle exactly as it shows on the channel page.`, { kind: 'notFound' });
  }
  return item;
}

async function handleConnect(request) {
  guard(request);
  const { rec } = await requireUser(request);
  notSuspended(rec);
  const body = await readBody(request);
  const input = String(body.channel || '').trim().slice(0, 300);
  // Everyone can paste their own (free) YouTube API key. Without one, the site's key is used if the
  // site owner added one.
  const pasted = String(body.apiKey || '').replace(/\s+/g, '');
  if (pasted && !KEY_RE.test(pasted)) {
    throw new UserError('That doesn’t look like an API key. It’s one long piece of text with no spaces, about 39 characters, and usually starts with “AIza”.', 'apiKey');
  }
  if (!input) throw new UserError('Enter your channel’s @handle or a link to it.', 'channel');
  const ownKey = pasted || ownKeyOf(rec);
  const apiKey = ownKey || (await siteKey(true));
  if (!apiKey) {
    throw new UserError('Paste your YouTube Data API key. It’s free from Google, and the steps below show how to get one.', 'apiKey', 400, { kind: 'needKey' });
  }
  await spendLookup(rec.name);
  let info;
  try {
    info = ytInfo(channelInfo(await findChannel(createYouTube({ apiKey, base: YT_BASE, timeoutMs: 12_000 }), input)));
  } catch (e) {
    if (!(e instanceof YouTubeError)) throw e;
    if (e.kind === 'notFound' && pasted) {
      // Google answered with this key, so it works: keep it, so only the channel needs fixing.
      const { rec: kept } = await withUser(rec.name, (r) => { r.ytKey = { key: pasted, addedAt: Date.now() }; });
      return fail(400, e.message, { field: 'channel', kind: e.kind, keySaved: true, keyHint: ownKeyHint(kept) });
    }
    if (e.kind === 'notFound' || e.kind === 'bad') return fail(400, e.message, { field: 'channel', kind: e.kind });
    if (e.kind === 'quota') {
      return ownKey
        ? fail(400, 'Google says this API key’s free allowance for today is used up. Try again after midnight Pacific time, or use a key from another Google Cloud project.', { field: 'apiKey', kind: 'quota' })
        : fail(503, 'This site has used up today’s YouTube allowance. Paste your own free API key to carry on now, or try again after midnight Pacific time.', { field: 'apiKey', kind: 'quota' });
    }
    if (e.kind === 'auth' && ownKey) return fail(400, e.message, { field: 'apiKey', kind: 'auth', ...(e.link ? { link: e.link } : {}) });
    if (e.kind === 'auth') {
      console.error('YouTube (connect, site key):', e.message);
      return fail(503, 'The site’s own YouTube key isn’t working right now. Paste your own free API key to carry on.', { field: 'apiKey', kind: 'auth' });
    }
    return fail(503, 'Can’t reach YouTube right now. Please try again in a minute.', { kind: e.kind });
  }
  if (!/^UC[\w-]{22}$/.test(info.id)) throw new UserError('That channel can’t be used.', 'channel');
  const { rec: next } = await withUser(rec.name, (r) => {
    r.yt = { channelId: info.id, channelInput: input, savedAt: Date.now() };
    if (pasted) r.ytKey = { key: pasted, addedAt: Date.now() };
  });
  const now = Date.now();
  const put = (c) => {
    c.yt[info.id] = isObj(c.yt[info.id]) ? c.yt[info.id] : {};
    setRead(c.yt[info.id], info, now);
  };
  let cache = await readNow(wantsOf(next), now, put, ownKeyOf(next)).catch(() => null);
  if (!cache) { cache = { yt: {}, bs: {} }; put(cache); }
  return json(200, {
    ok: true,
    channel: { id: info.id, title: info.title, handle: info.handle },
    keyHint: ownKeyHint(next),
    state: snapshotOf(next, cache, Date.now(), true),
  });
}

// Saves (or removes) the page owner's own YouTube API key by itself, without connecting a channel at
// the same time. The key is checked with Google first (1 unit of the key's own allowance). If a channel
// is connected, it's read again straight away with the new key.
async function handleMyKey(request) {
  guard(request);
  const { rec } = await requireUser(request);
  notSuspended(rec);
  const body = await readBody(request, 2_048);
  const action = String(body.action || 'save');
  if (action === 'remove') {
    const { rec: next } = await withUser(rec.name, (r) => { delete r.ytKey; });
    return json(200, { ok: true, keyHint: '', state: snapshotOf(next, cacheOf(await cmd('GET', K.cache)), Date.now(), true) });
  }
  if (action !== 'save') throw new UserError('Bad request.');
  const key = String(body.apiKey || '').replace(/\s+/g, '');
  if (!key) throw new UserError('Paste your API key first.', 'apiKey');
  if (!KEY_RE.test(key)) {
    throw new UserError('That doesn’t look like an API key. It’s one long piece of text with no spaces, about 39 characters, and usually starts with “AIza”.', 'apiKey');
  }
  await spendLookup(rec.name);
  const channelId = rec.yt && rec.yt.channelId;
  let note = '';
  try {
    await createYouTube({ apiKey: key, base: YT_BASE, timeoutMs: 12_000 }).channels({ part: 'id', id: channelId || KEY_TEST_CHANNEL, maxResults: 1 });
  } catch (e) {
    if (!(e instanceof YouTubeError)) throw e;
    if (e.kind === 'quota') note = 'Saved. Google says this key’s free allowance for today is used up, so it starts working after midnight Pacific time.';
    else if (e.kind === 'network' || e.kind === 'server' || e.kind === 'rate') {
      return fail(503, 'Couldn’t reach YouTube to check the key. Try again in a minute.', { kind: e.kind });
    } else return fail(400, e.message, { field: 'apiKey', kind: e.kind, ...(e.link ? { link: e.link } : {}) });
  }
  const { rec: next } = await withUser(rec.name, (r) => { r.ytKey = { key, addedAt: Date.now() }; });
  let cache = null;
  if (channelId && !note) {
    const due = (c) => { if (isObj(c.yt[channelId])) c.yt[channelId].nextAt = 0; };
    cache = await readNow(wantsOf(next), Date.now(), due, key).catch(() => null);
  }
  if (!cache) cache = cacheOf(await cmd('GET', K.cache));
  return json(200, { ok: true, note, keyHint: ownKeyHint(next), state: snapshotOf(next, cache, Date.now(), true) });
}

// Removes the channel and the page owner's own API key (if they saved one).
async function handleDisconnect(request) {
  guard(request);
  const { rec } = await requireUser(request);
  const { rec: next } = await withUser(rec.name, (r) => {
    r.yt = null;
    delete r.ytKey;
  });
  return json(200, { ok: true, state: snapshotOf(next, cacheOf(await cmd('GET', K.cache)), Date.now(), true) });
}

// Looks a Bluesky profile up before it's added, so typos show up straight away.
async function handleCheckAccount(request) {
  guard(request);
  const { rec } = await requireUser(request);
  notSuspended(rec);
  const body = await readBody(request, 4_096);
  if (String(body.platform || '') !== 'bluesky') {
    throw new UserError('On this site you can add Bluesky profiles here, and your YouTube channel under the Channel tab.');
  }
  const handle = normalizeHandle('bluesky', body.handle);
  if (!handle) throw new UserError('That doesn’t look like a Bluesky name. Paste the profile link or the name, like yourname.bsky.social.', 'handle');
  await spendLookup(rec.name);
  let profiles;
  try {
    profiles = await bskyProfiles([handle]);
  } catch (e) {
    if (e.status === 400) return fail(400, `There’s no Bluesky account called ${handle}.`, { field: 'handle', kind: 'notFound' });
    return fail(503, 'Can’t reach Bluesky right now. Please try again in a minute.', { kind: 'offline' });
  }
  const p = profiles[0];
  if (!p || !p.handle) return fail(400, `There’s no Bluesky account called ${handle}.`, { field: 'handle', kind: 'notFound' });
  const i = bskyInfo(p);
  return json(200, {
    ok: true,
    account: { platform: 'bluesky', handle: normalizeHandle('bluesky', i.handle) || handle, name: i.name, url: i.url, metrics: { followers: i.followers, posts: i.posts }, avatar: '' },
  });
}

// ---------- profile pictures ----------
// Passed through this site, so visitors' browsers never contact YouTube or Bluesky.
function avatarAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AVATAR_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function handleAvatar(request, url) {
  const miss = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60', 'Vercel-CDN-Cache-Control': 'max-age=60' } });
  const m = String(url.searchParams.get('key') || '').match(/^(youtube|bluesky):(.{1,200})$/);
  if (!m || !kvReady()) return miss();
  const cache = cacheOf(await cmd('GET', K.cache));
  const entry = m[1] === 'youtube' ? cache.yt[m[2]] : cache.bs[m[2]];
  const info = (isObj(entry) && entry.info) || {};
  const src = m[1] === 'youtube' ? info.thumb : info.avatar;
  if (!src || !avatarAllowed(src)) return miss();
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
    // (The address changes when the picture does, so it can be kept for a day.)
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Vercel-CDN-Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}

// ---------- the site owner's moderation tools ----------
async function handleAdminLogin(request) {
  guard(request);
  if (!adminReady()) return fail(503, 'Owner sign-in isn’t set up. Add an ADMIN_PASSWORD (at least 12 characters) in Vercel → Settings → Environment Variables, then redeploy.');
  const body = await readBody(request, 2_048);
  const ip = await ipId(request);
  if (await overLimit([['admin', ip]])) return fail(429, 'Too many wrong passwords. Wait 15 minutes, then try again.');
  const a = crypto.createHash('sha256').update(String(body.password || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    await pipeline(countTry('admin', ip));
    await sleep(400);
    return fail(401, 'That password isn’t right.', { field: 'password' });
  }
  await cmd('DEL', K.rl('admin', ip));
  const exp = Date.now() + ADMIN_SESSION_MS;
  return json(200, { ok: true }, {
    'Set-Cookie': `${ADMIN_COOKIE}=${exp}.${await sign(`admin.${adminTag()}.${exp}`)}; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`,
  });
}

function handleAdminLogout(request) {
  if (!sameOrigin(request)) throw new UserError('Forbidden', null, 403);
  return json(200, { ok: true }, { 'Set-Cookie': `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
}

async function requireAdmin(request) {
  if (!(await isAdmin(request))) throw new UserError('Sign in as the site owner first.', null, 403, { signIn: true });
}

async function handleAdminOverview(request) {
  await requireAdmin(request);
  // Counts the accounts afresh (some expire by themselves) and tidies up the old single-owner keys.
  let users = 0;
  let cursor = '0';
  for (let rounds = 0; rounds < 100; rounds++) {
    const [next, keys] = await cmd('SCAN', cursor, 'MATCH', 'lvc:u:*', 'COUNT', 1000);
    users += Array.isArray(keys) ? keys.length : 0;
    cursor = String(next);
    if (cursor === '0') break;
  }
  // A key pasted into the single-owner version of the site is kept, rather than deleted with it.
  const [oldConfig, savedText] = await cmd('MGET', 'lvc:config', K.ytKey);
  const old = parse(oldConfig, null);
  if (!rememberKey(savedText) && isObj(old) && typeof old.apiKey === 'string' && KEY_RE.test(old.apiKey.trim())) {
    const key = old.apiKey.trim();
    await cmd('SET', K.ytKey, JSON.stringify({ key, addedAt: Date.now(), last4: key.slice(-4), earlier: true }), 'NX');
    await savedKey(true);
  }
  await pipeline([['SET', K.count, users], ['DEL', ...LEGACY_KEYS]]);
  const cache = cacheOf(await cmd('GET', K.cache));
  return json(200, {
    ok: true,
    users,
    maxUsers: MAX_USERS,
    signUpsOpen: SIGNUPS_OPEN,
    youtube: youtubeStatus(keyMemo.saved, cache),
    analytics: ANALYTICS,
    watched: { youtube: Object.keys(cache.yt).length, bluesky: Object.keys(cache.bs).length },
  });
}

// What /admin shows about the YouTube key. Only its last 4 characters ever leave the server.
function youtubeStatus(saved, cache) {
  const issue = cache && isObj(cache.keyIssue) ? cache.keyIssue : null;
  return {
    using: saved ? 'site' : ENV_YT_KEY ? 'vercel' : null,
    saved: saved ? { last4: String(saved.last4 || saved.key.slice(-4)), addedAt: saved.addedAt || null, earlier: Boolean(saved.earlier) } : null,
    vercel: Boolean(ENV_YT_KEY),
    issue: issue && (saved || ENV_YT_KEY) ? { kind: issue.kind, message: issue.message, link: issue.link || '', at: issue.at } : null,
  };
}

// Checks a pasted key with Google (1 unit of its free daily allowance), then saves it, or removes it.
const KEY_TEST_CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw'; // Google for Developers: any answer at all means the key works
async function handleAdminYouTubeKey(request) {
  guard(request);
  await requireAdmin(request);
  const body = await readBody(request, 2_048);
  const action = String(body.action || '');
  if (action === 'remove') {
    await cmd('DEL', K.ytKey);
    rememberKey(null);
    return json(200, { ok: true, youtube: youtubeStatus(null, cacheOf(await cmd('GET', K.cache))) });
  }
  if (action !== 'save') throw new UserError('Bad request.');
  const key = String(body.key || '').replace(/\s+/g, '');
  if (!key) throw new UserError('Paste the API key first.', 'key');
  if (!KEY_RE.test(key)) {
    throw new UserError('That doesn’t look like an API key. It’s one long piece of text with no spaces, about 39 characters, and usually starts with “AIza”.', 'key');
  }
  let note = '';
  try {
    await createYouTube({ apiKey: key, base: YT_BASE, timeoutMs: 12_000 }).channels({ part: 'id', id: KEY_TEST_CHANNEL, maxResults: 1 });
  } catch (e) {
    if (!(e instanceof YouTubeError)) throw e;
    if (e.kind === 'quota') note = 'Google says this key’s free allowance for today is used up, so numbers start after midnight Pacific time.';
    else if (e.kind === 'network' || e.kind === 'server' || e.kind === 'rate') {
      return fail(503, 'Couldn’t reach YouTube to check the key. Try again in a minute.', { kind: e.kind });
    } else return fail(400, e.message, { field: 'key', kind: e.kind, ...(e.link ? { link: e.link } : {}) });
  }
  const saved = { key, addedAt: Date.now(), last4: key.slice(-4) };
  await cmd('SET', K.ytKey, JSON.stringify(saved));
  rememberKey(JSON.stringify(saved));
  // Channels that couldn't be read without a working key are read again straight away.
  let cache = null;
  const id = await lock(K.cacheLock, 5_000);
  if (id) {
    try {
      cache = cacheOf(await cmd('GET', K.cache));
      if (!note) delete cache.keyIssue;
      for (const e of Object.values(cache.yt)) {
        if (isObj(e) && e.error && (e.error.kind === 'unavailable' || (!note && e.error.kind === 'quota'))) e.nextAt = 0;
      }
      await cmd('SET', K.cache, JSON.stringify(cache));
    } finally {
      await unlock(K.cacheLock, id);
    }
  }
  return json(200, { ok: true, note, youtube: youtubeStatus(saved, cache || cacheOf(await cmd('GET', K.cache))) });
}

async function handleAdminUser(request) {
  guard(request);
  await requireAdmin(request);
  const body = await readBody(request, 2_048);
  const name = cleanName(body.username);
  if (!NAME_RE.test(name)) throw new UserError('Enter a username.', 'username');
  const action = String(body.action || 'find');
  if (!['find', 'suspend', 'unsuspend', 'delete'].includes(action)) throw new UserError('Bad request.');
  let rec = await getUser(name);
  if (!rec) return fail(404, `There’s no account called ${name}.`, { field: 'username' });
  if (action === 'delete') {
    await deleteUser(name);
    return json(200, { ok: true, deleted: name });
  }
  if (action === 'suspend') {
    const reason = String(body.reason || '').trim().slice(0, 300);
    rec = (await withUser(name, (r) => { r.suspended = { at: Date.now(), reason }; })).rec;
  } else if (action === 'unsuspend') {
    rec = (await withUser(name, (r) => { delete r.suspended; })).rec;
  }
  return json(200, {
    ok: true,
    account: {
      username: rec.name,
      createdAt: rec.createdAt,
      signInAt: rec.signInAt,
      public: publicOf(rec),
      page: pagePath(rec),
      suspended: rec.suspended ? { at: rec.suspended.at, reason: rec.suspended.reason || '' } : null,
      youtubeChannel: rec.yt ? rec.yt.channelId : null,
      ownKey: Boolean(ownKeyOf(rec)),
      counters: isObj(rec.settings) && Array.isArray(rec.settings.counters) ? rec.settings.counters.length : 0,
    },
  });
}

// ---------- robots.txt and sitemap.xml ----------
function siteOrigin(request) {
  const host = String(request.headers.get('x-forwarded-host') || request.headers.get('host') || '').toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  const proto = request.headers.get('x-forwarded-proto') === 'http' || /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
}
const PUBLIC_PAGES = ['/', '/signup', '/signin', '/contact', '/privacy', '/terms', '/cookies'];
function handleRobots(request) {
  const origin = siteOrigin(request);
  const text = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /live.html',
    'Disallow: /account',
    'Disallow: /admin',
    'Disallow: /forgot',
    '',
    ...(origin ? [`Sitemap: ${origin}/sitemap.xml`] : []),
    '',
  ].join('\n');
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cdnCache(86_400) } });
}
function handleSitemap(request) {
  const origin = siteOrigin(request);
  const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', ...cdnCache(86_400) } });
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
  const post = method === 'POST';

  if (path === '' || path === 'health') return json(200, { app: 'live-view-counter', ok: true, hosted: true, db: kvReady() });
  if (read && path === 'robots') return handleRobots(request);
  if (read && path === 'sitemap') return handleSitemap(request);
  if (read && path === 'config') return handleConfig(request);
  const page = path.match(/^u\/([^/]{1,40})\/state$/);
  if (read && page) return handlePageState(page[1]);
  if (read && path === 'avatar') return handleAvatar(request, url);
  if (post && path === 'auth/signout') return handleSignout(request);
  if (post && path === 'admin/logout') return handleAdminLogout(request);
  if (!kvReady()) return fail(503, NO_DB);

  if (post && path === 'auth/signup') return handleSignup(request);
  if (post && path === 'auth/signin') return handleSignin(request);
  if (post && path === 'auth/recover') return handleRecover(request);
  if (read && path === 'me') return handleMe(request);
  if (read && path === 'me/state') return handleMyState(request);
  if (read && path === 'me/export') return handleExport(request);
  if (post && path === 'me/settings') return handleSettingsSave(request);
  if (post && path === 'me/connect') return handleConnect(request);
  if (post && path === 'me/disconnect') return handleDisconnect(request);
  if (post && path === 'me/key') return handleMyKey(request);
  if (post && path === 'me/accounts/check') return handleCheckAccount(request);
  if (post && path === 'me/visibility') return handleVisibility(request);
  if (post && path === 'me/password') return handlePassword(request);
  if (post && path === 'me/recovery-code') return handleNewCode(request);
  if (post && path === 'me/signout-all') return handleSignoutAll(request);
  if (post && path === 'me/delete') return handleDelete(request);
  if (post && path === 'admin/login') return handleAdminLogin(request);
  if (read && path === 'admin/overview') return handleAdminOverview(request);
  if (post && path === 'admin/user') return handleAdminUser(request);
  if (post && path === 'admin/youtube-key') return handleAdminYouTubeKey(request);
  return notFound();
}

export default {
  async fetch(request) {
    try {
      return await route(request);
    } catch (e) {
      if (e instanceof UserError) return fail(e.status, e.message, { ...(e.field ? { field: e.field } : {}), ...e.extra });
      console.error(e);
      return fail(500, 'Something went wrong on the server. Try again in a moment.');
    }
  },
};

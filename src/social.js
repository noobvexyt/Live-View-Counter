// Live counts from other platforms: TikTok, Twitch, Kick and Bluesky (public profile numbers, no login),
// and Instagram (with an access token from Meta, because Instagram doesn't show counts to logged-out visitors).
// Each account is polled on its own timer. Readings are kept for 25 hours so the page can show the pace,
// the 24-hour change and a chart.
import { EventEmitter } from 'node:events';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STEP_MS = 60_000;          // one history point a minute
const KEEP_MS = 25 * 3_600_000;  // keep a day (and a bit) of history
const TREND_MS = 30 * 60_000;    // pace = slope of the last 30 minutes
const MAX_BACKOFF_MS = 10 * 60_000;
const IG_API = 'https://graph.instagram.com/v21.0';
const IG_REFRESH_EVERY_MS = 7 * 86_400_000; // Instagram tokens last 60 days; refresh them weekly

export const PLATFORMS = {
  tiktok: { name: 'TikTok', metrics: ['followers', 'likes', 'videos'], every: 45_000 },
  twitch: { name: 'Twitch', metrics: ['followers', 'viewers'], every: 20_000 },
  kick: { name: 'Kick', metrics: ['followers', 'viewers'], every: 30_000 },
  bluesky: { name: 'Bluesky', metrics: ['followers', 'posts'], every: 30_000 },
  instagram: { name: 'Instagram', metrics: ['followers', 'posts'], every: 60_000, token: true },
};

export class SourceError extends Error {
  // kind: notFound | auth | blocked | offline | error
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Accepts a link, an @handle or a plain name and returns the platform's own form of the name, or ''.
export function normalizeHandle(platform, input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const fromUrl = (re) => {
    const m = s.match(re);
    if (m) s = m[1];
  };
  if (platform === 'tiktok') {
    fromUrl(/tiktok\.com\/@([^/?#\s]+)/i);
    s = s.replace(/^@/, '');
    return /^[A-Za-z0-9._]{2,24}$/.test(s) ? s : '';
  }
  if (platform === 'twitch') {
    fromUrl(/twitch\.tv\/([^/?#\s]+)/i);
    s = s.replace(/^@/, '').toLowerCase();
    return /^[a-z0-9_]{2,25}$/.test(s) ? s : '';
  }
  if (platform === 'kick') {
    fromUrl(/kick\.com\/([^/?#\s]+)/i);
    s = s.replace(/^@/, '').toLowerCase().replace(/_/g, '-');
    return /^[a-z0-9-]{2,30}$/.test(s) ? s : '';
  }
  if (platform === 'bluesky') {
    fromUrl(/bsky\.app\/profile\/([^/?#\s]+)/i);
    s = s.replace(/^@/, '').toLowerCase();
    if (/^did:[a-z]+:[a-z0-9._:%-]+$/.test(s)) return s;
    if (!s.includes('.')) s += '.bsky.social';
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
  }
  if (platform === 'instagram') {
    fromUrl(/instagram\.com\/([^/?#\s]+)/i);
    s = s.replace(/^@/, '').toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(s) ? s : '';
  }
  return '';
}

async function request(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new SourceError('offline', 'Can’t reach it right now. Is the internet connected?');
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// ---------- one reader per platform: each returns { name, handle, url, avatarUrl, metrics } ----------
const readers = {
  async tiktok(handle) {
    const r = await request(`https://www.tiktok.com/@${encodeURIComponent(handle)}?lang=en`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
    });
    const html = await r.text();
    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new SourceError('blocked', `TikTok didn’t send the profile this time (${r.status}). Trying again soon.`);
    let d;
    try { d = JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.user-detail']; } catch { d = null; }
    const info = d && d.userInfo;
    if (!info || !info.user || !info.user.uniqueId) {
      if (d && d.statusCode && d.statusCode !== 0) throw new SourceError('notFound', `There’s no TikTok account called @${handle}.`);
      throw new SourceError('blocked', 'TikTok sent an unexpected page. Trying again soon.');
    }
    const st = info.stats || {};
    const v2 = info.statsV2 || {}; // exact numbers as text; "stats" rounds big ones
    const pick = (k) => num(v2[k]) ?? num(st[k]);
    return {
      name: info.user.nickname || info.user.uniqueId,
      handle: info.user.uniqueId,
      url: `https://www.tiktok.com/@${info.user.uniqueId}`,
      avatarUrl: info.user.avatarLarger || info.user.avatarMedium || info.user.avatarThumb || '',
      metrics: { followers: pick('followerCount'), likes: pick('heartCount') ?? pick('heart'), videos: pick('videoCount') },
    };
  },

  async twitch(login) {
    const r = await request('https://gql.twitch.tv/gql', {
      method: 'POST',
      // The public client ID twitch.tv itself uses for logged-out visitors.
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': BROWSER_UA },
      body: JSON.stringify({
        query: 'query($login:String!){user(login:$login){login displayName profileImageURL(width:300) followers{totalCount} stream{viewersCount}}}',
        variables: { login },
      }),
    });
    let j;
    try { j = await r.json(); } catch { throw new SourceError('blocked', `Twitch sent an unexpected reply (${r.status}). Trying again soon.`); }
    if (!j || !j.data) throw new SourceError('blocked', 'Twitch didn’t answer this time. Trying again soon.');
    const u = j.data.user;
    if (!u) throw new SourceError('notFound', `There’s no Twitch channel called ${login}.`);
    return {
      name: u.displayName || u.login,
      handle: u.login,
      url: `https://www.twitch.tv/${u.login}`,
      avatarUrl: u.profileImageURL || '',
      metrics: { followers: num(u.followers && u.followers.totalCount), viewers: u.stream ? num(u.stream.viewersCount) ?? 0 : 0 },
      live: Boolean(u.stream),
    };
  },

  async kick(slug) {
    const r = await request(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    });
    if (r.status === 404) throw new SourceError('notFound', `There’s no Kick channel called ${slug}.`);
    let j;
    try { j = await r.json(); } catch { throw new SourceError('blocked', `Kick didn’t answer this time (${r.status}). Trying again soon.`); }
    if (!r.ok || !j) throw new SourceError('blocked', `Kick didn’t answer this time (${r.status}). Trying again soon.`);
    const live = j.livestream && j.livestream.is_live !== false ? j.livestream : null;
    return {
      name: (j.user && j.user.username) || j.slug || slug,
      handle: j.slug || slug,
      url: `https://kick.com/${j.slug || slug}`,
      avatarUrl: (j.user && j.user.profile_pic) || '',
      metrics: { followers: num(j.followers_count ?? j.followersCount), viewers: live ? num(live.viewer_count) ?? 0 : 0 },
      live: Boolean(live),
    };
  },

  async bluesky(actor) {
    const r = await request(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, {
      headers: { Accept: 'application/json' },
    });
    let j;
    try { j = await r.json(); } catch { throw new SourceError('blocked', `Bluesky didn’t answer this time (${r.status}).`); }
    if (r.status === 400) throw new SourceError('notFound', `There’s no Bluesky account called ${actor}.`);
    if (!r.ok) throw new SourceError('blocked', `Bluesky didn’t answer this time (${r.status}).`);
    return {
      name: j.displayName || j.handle,
      handle: j.handle,
      url: `https://bsky.app/profile/${j.handle}`,
      avatarUrl: j.avatar || '',
      metrics: { followers: num(j.followersCount), posts: num(j.postsCount) },
    };
  },

  async instagram(_handle, token) {
    if (!token) throw new SourceError('auth', 'Instagram needs an access token. Add the account again with your token.');
    const fields = 'user_id,username,name,profile_picture_url,followers_count,media_count';
    const r = await request(`${IG_API}/me?fields=${fields}&access_token=${encodeURIComponent(token)}`);
    let j;
    try { j = await r.json(); } catch { throw new SourceError('blocked', `Instagram didn’t answer this time (${r.status}).`); }
    if (j && j.error) {
      const code = j.error.code;
      if (code === 190 || code === 102 || j.error.type === 'OAuthException') {
        throw new SourceError('auth', `Instagram didn’t accept the access token: ${j.error.message || 'it may have expired'}. Add the account again with a new token.`);
      }
      throw new SourceError(code === 4 || code === 17 || code === 32 ? 'blocked' : 'error', `Instagram: ${j.error.message || 'something went wrong'}`);
    }
    if (!r.ok || !j || !j.username) throw new SourceError('blocked', `Instagram didn’t answer this time (${r.status}).`);
    return {
      name: j.name || j.username,
      handle: j.username,
      url: `https://www.instagram.com/${j.username}/`,
      avatarUrl: j.profile_picture_url || '',
      metrics: { followers: num(j.followers_count), posts: num(j.media_count) },
    };
  },
};

// Looks an account up once (used when adding it). Resolves with the reading or throws a SourceError.
export function readAccount(platform, handle, token) {
  const read = readers[platform];
  if (!read) return Promise.reject(new SourceError('error', 'That platform isn’t supported.'));
  return read(handle, token);
}

// Instagram long-lived tokens can be renewed for another 60 days while they're still valid.
export async function refreshInstagramToken(token) {
  const r = await request(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.access_token) throw new SourceError('auth', (j && j.error && j.error.message) || 'Could not renew the Instagram token.');
  return j.access_token;
}

export const sourceKey = (platform, handle) => `${platform}:${String(handle).toLowerCase()}`;

// ---------- history helpers ----------
export function valueAt(pts, ms) {
  if (!pts.length || ms < pts[0][0]) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid][0] <= ms) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo];
  const b = pts[lo + 1];
  if (!b || b[0] === a[0]) return a[1];
  return a[1] + ((b[1] - a[1]) * (ms - a[0])) / (b[0] - a[0]);
}

export function slope(pts) {
  if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < 3 * 60_000) return null;
  const t0 = pts[0][0];
  const y0 = pts[0][1];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [t, v] of pts) {
    const x = (t - t0) / 1000;
    const y = v - y0;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = pts.length;
  const den = n * sxx - sx * sx;
  return den > 0 ? (n * sxy - sx * sy) / den : null;
}

// ---------- a polled account ----------
export class SocialSource extends EventEmitter {
  // saved: this account's entry in state.json (kept up to date in place)
  constructor({ platform, handle, getToken, saved, onDirty }) {
    super();
    this.platform = platform;
    this.handle = handle;
    this.key = sourceKey(platform, handle);
    this.getToken = getToken || (() => '');
    this.saved = saved;
    if (!saved.series) saved.series = {};
    this.onDirty = onDirty || (() => {});
    this.status = saved.info ? 'starting' : 'starting';
    this.error = null;
    this.checkedAt = null;
    this.failures = 0;
    this.timer = null;
    this.stopped = false;
    this.live = false;
  }

  start() {
    this.stopped = false;
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => this.poll(), ms);
    this.timer.unref?.();
  }

  async poll() {
    const every = PLATFORMS[this.platform].every;
    try {
      const r = await readAccount(this.platform, this.handle, this.getToken());
      if (this.stopped) return;
      this.record(r);
      this.status = 'live';
      this.error = null;
      this.failures = 0;
      this.schedule(every * (0.9 + Math.random() * 0.2));
    } catch (e) {
      if (this.stopped) return;
      this.failures++;
      const kind = e.kind || 'error';
      const wait = kind === 'notFound' || kind === 'auth'
        ? MAX_BACKOFF_MS
        : Math.min(MAX_BACKOFF_MS, every * 2 ** Math.min(this.failures, 6));
      this.status = kind === 'notFound' || kind === 'auth' ? 'error' : 'offline';
      this.error = { kind, message: e.message || 'Something went wrong.', retryAt: Date.now() + wait };
      if (!e.kind) console.error(`  ${this.key}:`, e);
      this.schedule(wait);
    }
    this.checkedAt = Date.now();
    this.emit('update');
  }

  record(r) {
    const now = Date.now();
    this.saved.info = { name: r.name, handle: r.handle, url: r.url, avatarUrl: r.avatarUrl };
    this.live = Boolean(r.live);
    for (const [metric, value] of Object.entries(r.metrics)) {
      if (value == null) continue;
      const s = this.saved.series[metric] || (this.saved.series[metric] = { hist: [], cur: null });
      s.cur = [now, value];
      const last = s.hist[s.hist.length - 1];
      if (!last || now - last[0] >= STEP_MS) s.hist.push([now, value]);
      while (s.hist.length > 2 && now - s.hist[0][0] > KEEP_MS) s.hist.shift();
    }
    this.onDirty();
  }

  points(metric) {
    const s = this.saved.series[metric];
    if (!s) return [];
    const pts = s.hist.slice();
    if (s.cur && (!pts.length || pts[pts.length - 1][0] < s.cur[0])) pts.push(s.cur);
    return pts;
  }

  metricSnapshot(metric, now) {
    const s = this.saved.series[metric];
    if (!s || !s.cur) return null;
    const pts = this.points(metric);
    const recent = pts.filter((p) => p[0] >= now - TREND_MS);
    const rate = slope(recent);
    const start = Math.max(now - 86_400_000, pts[0][0]);
    const before = now - start >= 60_000 ? valueAt(pts, start) : null;
    return {
      value: s.cur[1],
      at: s.cur[0],
      rate: rate == null ? null : rate,
      day: before == null ? null : { change: Math.round(s.cur[1] - before), spanMs: now - start },
    };
  }

  snapshot() {
    const now = Date.now();
    const info = this.saved.info || {};
    const metrics = {};
    for (const m of PLATFORMS[this.platform].metrics) metrics[m] = this.metricSnapshot(m, now);
    return {
      key: this.key,
      platform: this.platform,
      handle: info.handle || this.handle,
      name: info.name || this.handle,
      url: info.url || '',
      avatar: info.avatarUrl ? `/api/avatar?key=${encodeURIComponent(this.key)}` : '',
      live: this.live,
      status: this.status,
      error: this.error,
      checkedAt: this.checkedAt,
      every: PLATFORMS[this.platform].every,
      metrics,
    };
  }

  avatarUrl() {
    return (this.saved.info && this.saved.info.avatarUrl) || '';
  }
}

export { IG_REFRESH_EVERY_MS };

// Minimal client for the official YouTube Data API v3, with only the read-only calls the counter needs.
// Every call costs quota "units": 10,000 free per day per Google Cloud project, reset at midnight Pacific.

export const API_BASE = 'https://www.googleapis.com/youtube/v3';
export const CHANNEL_PARTS = 'snippet,statistics,contentDetails';
export const BATCH_STATS = 'videos:batchGetStats'; // has its own separate 10,000-unit daily quota
const COST = { channels: 1, playlistItems: 1, videos: 1, search: 100, [BATCH_STATS]: 1 };

export class YouTubeError extends Error {
  // kind: 'network' | 'server' | 'rate' | 'quota' | 'auth' | 'notFound' | 'bad'
  constructor(message, { kind = 'network', status = 0, reason = '', link = '' } = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
    this.link = link;
  }
}

// Turn Google's error JSON into a plain-English message plus a "kind" the tracker can act on.
function classify(status, body) {
  const err = (body && body.error) || {};
  const first = (Array.isArray(err.errors) && err.errors[0]) || {};
  const detail = (Array.isArray(err.details) && err.details.find((d) => d && d.reason)) || {};
  const reasons = `${first.reason || ''} ${detail.reason || ''} ${err.status || ''}`;
  const raw = String(err.message || first.message || '').replace(/<[^>]*>/g, '').trim();
  const opts = (kind, reason, link = '') => ({ kind, status, reason, link });

  if (/quotaExceeded|dailyLimitExceeded/.test(reasons)) {
    return new YouTubeError('Today’s free YouTube API allowance is used up.', opts('quota', 'quotaExceeded'));
  }
  if (status === 429 || /rateLimitExceeded|RATE_LIMIT_EXCEEDED/.test(reasons)) {
    return new YouTubeError('YouTube asked us to slow down for a moment.', opts('rate', 'rateLimited'));
  }
  if (/API_KEY_INVALID|keyInvalid/.test(reasons) || /API key not valid/i.test(raw)) {
    return new YouTubeError(
      'Google says this API key isn’t valid. Copy it again from Google Cloud → Credentials (it usually starts with “AIza”).',
      opts('auth', 'keyInvalid', 'https://console.cloud.google.com/apis/credentials'),
    );
  }
  if (/SERVICE_DISABLED|accessNotConfigured/.test(reasons) || /has not been used in project|it is disabled/i.test(raw)) {
    const found = (raw.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"']+/) || [])[0];
    return new YouTubeError(
      'The YouTube Data API v3 isn’t turned on for the Google Cloud project this key belongs to. Turn it on, wait a minute, then try again.',
      opts('auth', 'apiDisabled', (found || 'https://console.cloud.google.com/apis/library/youtube.googleapis.com').replace(/[).,]+$/, '')),
    );
  }
  if (/API_KEY_\w*(BLOCKED|DENIED)/.test(reasons) || /referer|referrer|IP address|are blocked/i.test(raw)) {
    return new YouTubeError(
      'This API key has restrictions that block this app. In Google Cloud → Credentials, open the key, set “Application restrictions” to None and make sure “YouTube Data API v3” is allowed.',
      opts('auth', 'keyRestricted', 'https://console.cloud.google.com/apis/credentials'),
    );
  }
  if (status === 404) return new YouTubeError(raw || 'Not found.', opts('notFound', first.reason || 'notFound'));
  if (status >= 500) return new YouTubeError(`YouTube had a temporary problem (error ${status}).`, opts('server', first.reason || 'backendError'));
  if (status === 403) return new YouTubeError(raw || 'YouTube refused the request.', opts('auth', first.reason || 'forbidden'));
  return new YouTubeError(raw || `YouTube API error ${status}.`, opts('bad', first.reason || 'badRequest'));
}

export function createYouTube({ apiKey, base = API_BASE, onCost = () => {}, timeoutMs = 15_000 }) {
  const root = String(base || API_BASE).replace(/\/+$/, '');

  async function call(resource, params) {
    const url = new URL(`${root}/${resource}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', apiKey);
    onCost(COST[resource] || 1, resource);

    const fail = (err) => { err.resource = resource; return err; };
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const code = (e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timed out' : e && e.name) || 'error';
      throw fail(new YouTubeError(`Can’t reach YouTube right now (${code}).`, { kind: 'network', reason: String(code) }));
    }
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok && body) return body;
    if (res.ok) throw fail(new YouTubeError('YouTube sent back an unreadable response.', { kind: 'server', status: res.status }));
    throw fail(classify(res.status, body));
  }

  return {
    channels: (p) => call('channels', p),
    playlistItems: (p) => call('playlistItems', p),
    videos: (p) => call('videos', p),
    batchStats: (p) => call(BATCH_STATS, p),
    search: (p) => call('search', p),
  };
}

// ---------- understanding what the user typed ----------

// Accepts @handle, a channel link (/@handle, /channel/UC…, /user/…, /c/…), a channel ID,
// or a link to any video (watch, youtu.be, shorts, live).
export function parseChannelInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* keep as typed */ }

  const video = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})(?![\w-])/);
  if (video) return { by: 'video', value: video[1] };
  const id = s.match(/(?:^|\/channel\/)(UC[\w-]{22})(?![\w-])/);
  if (id) return { by: 'id', value: id[1] };
  const handle = s.match(/(?:^|[/\s])@([\p{L}\p{N}\p{M}._·-]{1,100})/u);
  if (handle) return { by: 'handle', value: `@${handle[1]}` };
  const user = s.match(/youtube\.com\/user\/([\w.-]+)/i);
  if (user) return { by: 'username', value: user[1] };
  const custom = s.match(/youtube\.com\/c\/([^/?#\s]+)/i);
  if (custom) return { by: 'name', value: custom[1] };
  if (/^[\p{L}\p{N}\p{M}._·-]{3,100}$/u.test(s)) return { by: 'name', value: s };
  return { by: 'search', value: s };
}

export async function resolveChannel(yt, raw) {
  const q = parseChannelInput(raw);
  if (!q) {
    throw new YouTubeError('Enter your channel’s @handle, a link to your channel, or a link to one of your videos.', { kind: 'bad' });
  }
  const first = (res) => (res && Array.isArray(res.items) && res.items[0]) || null;
  const byId = async (id) => first(await yt.channels({ part: CHANNEL_PARTS, id }));
  const byHandle = async (h) => first(await yt.channels({ part: CHANNEL_PARTS, forHandle: h }));
  const byUsername = async (u) => first(await yt.channels({ part: CHANNEL_PARTS, forUsername: u }));
  const bySearch = async (text) => { // costs 100 units, only used as a last resort during setup
    const hit = first(await yt.search({ part: 'snippet', type: 'channel', q: text, maxResults: 1 }));
    const cid = hit && ((hit.id && hit.id.channelId) || (hit.snippet && hit.snippet.channelId));
    return cid ? byId(cid) : null;
  };

  let item = null;
  if (q.by === 'id') item = await byId(q.value);
  else if (q.by === 'handle') item = await byHandle(q.value);
  else if (q.by === 'username') item = await byUsername(q.value);
  else if (q.by === 'video') {
    const v = first(await yt.videos({ part: 'snippet', id: q.value }));
    if (v && v.snippet && v.snippet.channelId) item = await byId(v.snippet.channelId);
  } else if (q.by === 'name') {
    item = (await byHandle(`@${q.value}`)) || (await byUsername(q.value)) || (await bySearch(q.value));
  } else {
    item = await bySearch(q.value);
  }

  if (!item) {
    throw new YouTubeError(
      `Couldn’t find a YouTube channel for “${String(raw).trim()}”. Try your @handle exactly as it appears on your channel page.`,
      { kind: 'notFound' },
    );
  }
  return item;
}

export function channelInfo(item) {
  const sn = item.snippet || {};
  const st = item.statistics || {};
  const cd = item.contentDetails || {};
  const th = sn.thumbnails || {};
  const custom = String(sn.customUrl || '');
  return {
    id: item.id,
    title: sn.title || 'Your channel',
    handle: custom ? (custom.startsWith('@') ? custom : `@${custom}`) : '',
    thumb: (th.high || th.medium || th.default || {}).url || '',
    subs: st.hiddenSubscriberCount ? null : Number(st.subscriberCount || 0),
    videoCount: Number(st.videoCount || 0),
    viewCount: Number(st.viewCount || 0),
    uploads: (cd.relatedPlaylists && cd.relatedPlaylists.uploads) || (String(item.id).startsWith('UC') ? `UU${String(item.id).slice(2)}` : ''),
  };
}

// Tracks one channel's total views, live.
//
// How it works:
// - YouTube refreshes a channel's own total (channels.list → statistics.viewCount) only now and then,
//   so the live number is built from every public video's view count, which YouTube keeps much fresher.
// - Each tick re-reads the 50 videos most likely to have new views (1 quota unit). Videos are ranked by
//   "expected unseen views" = recent views-per-second × time since last checked, so busy videos are
//   checked every few seconds and old quiet ones every so often, and nothing is missed for long.
// - The poll rate is paced from the quota left until the daily reset (midnight Pacific), so the free
//   daily allowance is never used up, however long the counter runs.
// - The total doesn't go backwards: views from videos that get deleted or hidden are kept for 30 days
//   (YouTube's API policies allow storing its data that long without refreshing it), and if YouTube's
//   own channel total is ever higher than the sum (e.g. views from deleted videos), the counter lifts
//   its baseline to match.

import { EventEmitter } from 'node:events';
import { createYouTube, channelInfo, YouTubeError, CHANNEL_PARTS, BATCH_STATS } from './youtube.js';

export const DAILY_LIMIT = 10_000;     // default free quota per bucket, per day
export const DEFAULT_BUDGET = 9_500;   // how much of each bucket the counter lets itself use
const MAIN_RESERVE = 1_000;            // main-bucket units kept back for channel checks and rescans
const BATCH = 50;                      // video IDs per stats request
const MIN_TICK_MS = 2_000;             // fastest check rate; quota pacing slows it when needed
const TREND_WINDOW_MS = 30 * 60_000;   // the pace line is fitted through this much recent history
const LOWER_ACCEPT_MS = 2 * 3_600_000; // a video's count only goes down after this long of lower readings
const MAX_TICK_MS = 15 * 60_000;
const CHANNEL_CHECK_MS = 4 * 60_000;   // look for new uploads + YouTube's own total
const FULL_SCAN_MS = 6 * 3_600_000;    // re-list every upload
const MAX_STALE_MS = 6 * 3_600_000;    // every video is re-read at least this often
const RATE_TAU_S = 30 * 60;            // smoothing window for each video's views-per-second
const RATE_FLOOR = 1 / 86_400;         // assume at least ~1 view/day so quiet videos still get rechecked
const HISTORY_STEP_MS = 60_000;
const HISTORY_KEEP_MS = 49 * 3_600_000;
const GONE_KEEP_MS = 30 * 86_400_000;  // deleted/hidden videos' last counts are dropped after this

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const bucketOf = (resource) => (resource === BATCH_STATS ? 'stats' : 'main');

// ---------- quota day: YouTube resets quotas at midnight Pacific time ----------
const ptFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function pacific(ms) {
  const p = {};
  for (const { type, value } of ptFormat.formatToParts(new Date(ms))) p[type] = value;
  return { day: `${p.year}-${p.month}-${p.day}`, secs: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
export const quotaDay = (ms = Date.now()) => pacific(ms).day;
export const msUntilQuotaReset = (ms = Date.now()) => Math.max(1_000, (86_400 - pacific(ms).secs) * 1_000 - (ms % 1_000));

export function spendQuota(state, units, bucket = 'main', ms = Date.now()) {
  const day = quotaDay(ms);
  if (!state.quota || state.quota.day !== day) state.quota = { day, main: 0, stats: 0 };
  state.quota[bucket] = (state.quota[bucket] || 0) + units;
}
export function quotaUsed(state, bucket = 'main', ms = Date.now()) {
  const q = state.quota;
  return q && q.day === quotaDay(ms) ? q[bucket] || 0 : 0;
}

// Saved per video (short keys keep state.json small for big channels):
//   v views · t last read (ms) · r views/sec · p published (ms) · k has a reading
//   g gone (deleted/hidden: keep last count, stop asking) · gt when it went (ms) · m misses in a row
//   l since when every reading was lower (ms)
export class Tracker extends EventEmitter {
  constructor({ apiKey, channelId, state, budget = DEFAULT_BUDGET, apiBase, onDirty = () => {} }) {
    super();
    this.channelId = channelId;
    this.state = state;
    this.budget = clamp(Math.round(Number(budget) || DEFAULT_BUDGET), 2_000, 1_000_000);
    this.onDirty = onDirty;
    this.yt = createYouTube({ apiKey, base: apiBase, onCost: (n, resource) => spendQuota(state, n, bucketOf(resource)) });
    this.statsMode = 'batch';  // 'batch' = videos:batchGetStats (own quota) + videos.list; 'list' = videos.list only
    this.running = false;
    this.ready = false;
    this.status = 'starting';
    this.error = null;
    this.tickMs = 10_000;
    this.nextChannelCheck = 0;
    this.backoffMs = 0;
    this.changeGapMs = null;
    this.lastIncreaseAt = 0;
    this.checkedAt = null;
    this.timer = null;
    this.wake = null;
  }

  get track() {
    const t = this.state.track;
    return t && t.channelId === this.channelId ? t : null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((e) => console.error('  Tracker stopped unexpectedly:', e));
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.wake) this.wake();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
    });
  }

  // ---------- pacing ----------
  headroom(bucket, now = Date.now()) {
    return this.budget - (bucket === 'main' ? MAIN_RESERVE : 0) - quotaUsed(this.state, bucket, now);
  }
  statsBuckets() {
    return this.statsMode === 'batch' ? ['stats', 'main'] : ['main'];
  }
  // Time between stats reads so that what's left of today's quota lasts until the reset. null = none left.
  pollDelay(now = Date.now()) {
    const untilReset = msUntilQuotaReset(now);
    let perMs = 0;
    for (const b of this.statsBuckets()) perMs += Math.max(0, this.headroom(b, now)) / untilReset;
    return perMs > 0 ? clamp(1 / perMs, MIN_TICK_MS, MAX_TICK_MS) : null;
  }
  mainRoom() {
    return this.budget - quotaUsed(this.state, 'main');
  }
  exhaust(bucket) {
    spendQuota(this.state, Math.max(0, DAILY_LIMIT - quotaUsed(this.state, bucket)), bucket);
  }

  // ---------- main loop ----------
  async loop() {
    while (this.running) {
      let wait;
      if (this.pollDelay() == null) {
        wait = msUntilQuotaReset() + 30_000;
        this.status = 'quota';
        this.error = { kind: 'quota', message: 'Today’s YouTube API allowance is used up.', resetAt: Date.now() + wait };
      } else {
        try {
          await this.tick();
          if (!this.running) break;
          this.backoffMs = 0;
          this.status = 'live';
          this.error = null;
          wait = this.pollDelay() ?? 60_000;
          this.tickMs = wait;
        } catch (e) {
          if (!this.running) break;
          wait = this.handleError(e);
        }
      }
      this.publish();
      await this.sleep(wait);
    }
  }

  async tick() {
    const now = Date.now();
    if (!this.ready) {
      await this.bootstrap();
      this.ready = true;
    } else if (now >= this.nextChannelCheck && this.mainRoom() >= 3) {
      await this.checkChannel();
    } else if (now - (this.track.scannedAt || 0) >= FULL_SCAN_MS && this.mainRoom() >= this.scanCost() + 2) {
      await this.fullScan();
    } else {
      await this.pollBatch();
    }
    if (this.running) {
      this.record();
      this.onDirty();
    }
  }

  handleError(e) {
    const known = e instanceof YouTubeError;
    const kind = known ? e.kind : 'network';
    const now = Date.now();
    if (known) console.warn(`  YouTube: ${e.message}`);
    else console.error('  Unexpected error:', e);

    if (kind === 'quota') {
      this.exhaust(bucketOf(e.resource));
      const other = this.ready ? this.pollDelay() : null;
      if (other != null) return other; // the other quota bucket still has room: keep counting
      const wait = msUntilQuotaReset() + 60_000;
      this.status = 'quota';
      this.error = { kind, message: e.message, resetAt: now + wait };
      return wait;
    }
    if (kind === 'auth' || kind === 'bad' || kind === 'notFound') {
      // Needs the user to fix something (key, API not enabled, channel gone). Keep retrying slowly.
      this.status = 'error';
      this.error = { kind, reason: e.reason || '', message: e.message, link: e.link || '', retryAt: now + 120_000 };
      return 120_000;
    }
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, 5 * 60_000) : 5_000;
    this.status = 'offline';
    this.error = { kind, message: e.message, retryAt: now + this.backoffMs };
    return this.backoffMs;
  }

  // ---------- talking to YouTube ----------
  ensureTrack() {
    if (!this.track) {
      this.state.track = {
        channelId: this.channelId, channel: null, official: null, offset: 0, offsetReady: false,
        videos: {}, scannedAt: 0, history: [], total: null, updatedAt: null,
      };
    }
    return this.state.track;
  }

  async bootstrap() {
    const res = await this.yt.channels({ part: CHANNEL_PARTS, id: this.channelId });
    if (!this.running) return;
    const item = res.items && res.items[0];
    if (!item) {
      throw new YouTubeError('This channel can’t be found any more. It may have been deleted or made private.', { kind: 'notFound' });
    }
    const info = channelInfo(item);
    const t = this.ensureTrack();
    this.applyChannel(info);
    this.dropOldGone();
    const needFull = !t.scannedAt || Date.now() - t.scannedAt >= FULL_SCAN_MS || !Object.keys(t.videos).length;
    if (needFull) await this.fullScan();
    else await this.scanNewest();
    if (!this.running) return;
    await this.pollAll();
    if (!this.running) return;
    if (!t.offsetReady) {
      // Start from the larger of YouTube's own total and the sum of the videos. The sum is usually
      // fresher. YouTube's total can be higher when it includes views from deleted or hidden videos.
      t.offset = Math.max(0, info.viewCount - this.sum());
      t.offsetReady = true;
      t.official = { views: info.viewCount, changedAt: Date.now(), seenAt: Date.now() };
    } else {
      this.noteOfficial(info.viewCount);
    }
    this.nextChannelCheck = Date.now() + CHANNEL_CHECK_MS;
  }

  applyChannel(info) {
    const { id, title, handle, thumb, subs, videoCount, uploads } = info;
    this.track.channel = { id, title, handle, thumb, subs, videoCount, uploads };
  }

  async checkChannel() {
    const res = await this.yt.channels({ part: CHANNEL_PARTS, id: this.channelId });
    if (!this.running) return;
    const item = res.items && res.items[0];
    if (item) {
      const info = channelInfo(item);
      this.applyChannel(info);
      this.noteOfficial(info.viewCount); // before adding new uploads, so their views aren't counted twice
    }
    await this.scanNewest();
    this.dropOldGone();
    this.nextChannelCheck = Date.now() + CHANNEL_CHECK_MS;
  }

  // YouTube refreshed its own channel total. If it's higher than everything we can account for
  // (views on deleted or unlisted videos, say), raise the baseline to match. Never lower it.
  noteOfficial(views) {
    const t = this.track;
    const now = Date.now();
    if (!Number.isFinite(views)) return;
    if (t.official && t.official.views === views) {
      t.official.seenAt = now;
      return;
    }
    t.official = { views, changedAt: now, seenAt: now };
    if (!t.offsetReady || this.hasUnread()) return;
    const gap = views - (this.sum() + this.expectedUnseen(now));
    if (gap > t.offset) t.offset = Math.round(gap);
  }

  async listUploads(playlistId, pageToken) {
    try {
      return await this.yt.playlistItems({ part: 'contentDetails', playlistId, maxResults: 50, pageToken });
    } catch (e) {
      if (e instanceof YouTubeError && e.kind === 'notFound') return { items: [] }; // no public uploads yet
      throw e;
    }
  }

  async fullScan() {
    const t = this.track;
    const playlistId = t.channel && t.channel.uploads;
    if (!playlistId) {
      t.scannedAt = Date.now();
      return;
    }
    const seen = new Set();
    let pageToken;
    let pages = 0;
    do {
      const res = await this.listUploads(playlistId, pageToken);
      pages++;
      if (!this.running) return;
      for (const it of res.items || []) {
        const cd = it.contentDetails || {};
        if (!cd.videoId) continue;
        seen.add(cd.videoId);
        this.addVideo(cd.videoId, cd.videoPublishedAt);
      }
      pageToken = res.nextPageToken;
    } while (pageToken && pages < 600);
    // Uploads that vanished (deleted or made private) stop being read but keep their last count,
    // so the total doesn't drop. Skip this if the listing looks incomplete.
    const known = Object.values(t.videos).filter((v) => !v.g).length;
    if (seen.size >= known * 0.5) {
      const now = Date.now();
      for (const [id, v] of Object.entries(t.videos)) {
        if (seen.has(id) || v.g) continue;
        v.g = 1;
        v.gt = now;
      }
    }
    t.scannedAt = Date.now();
  }

  async scanNewest() {
    const t = this.track;
    const playlistId = t.channel && t.channel.uploads;
    if (!playlistId) return;
    const res = await this.listUploads(playlistId);
    if (!this.running) return;
    let fresh = 0;
    for (const it of res.items || []) {
      const cd = it.contentDetails || {};
      if (!cd.videoId) continue;
      if (!t.videos[cd.videoId] || t.videos[cd.videoId].g) fresh++;
      this.addVideo(cd.videoId, cd.videoPublishedAt);
    }
    if (fresh >= 45) t.scannedAt = 0; // lots of new uploads at once: re-list everything next tick
  }

  scanCost() {
    return Math.ceil(Object.keys(this.track.videos).length / BATCH) + 1;
  }

  addVideo(id, publishedAt) {
    const videos = this.track.videos;
    const v = videos[id] || (videos[id] = { v: 0, t: 0, r: 0 });
    const p = publishedAt ? Date.parse(publishedAt) : NaN;
    if (Number.isFinite(p)) v.p = p;
    delete v.g;
    delete v.gt;
    delete v.m;
    return v;
  }

  // Deleted or hidden videos can't be re-read, so their last counts are dropped after 30 days: YouTube's
  // API policies allow storing its data that long without refreshing it. The total drops by the same amount
  // (if YouTube's own channel total still includes those views, the next channel check lifts it back).
  dropOldGone(now = Date.now()) {
    const t = this.track;
    if (!t) return;
    let dropped = 0;
    for (const [id, v] of Object.entries(t.videos)) {
      if (!v.g) continue;
      if (!v.gt) { v.gt = now; continue; } // marked gone before this rule: start its 30 days now
      if (now - v.gt < GONE_KEEP_MS) continue;
      dropped += v.v || 0;
      delete t.videos[id];
    }
    if (dropped && t.total != null) t.total = Math.max(0, t.total - dropped);
  }

  activeIds() {
    return Object.entries(this.track.videos).filter(([, v]) => !v.g).map(([id]) => id);
  }

  async pollAll() {
    const ids = this.activeIds();
    const batches = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length && this.running) await this.pollIds(batches[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
  }

  async pollBatch() {
    const ids = this.pickBatch(Date.now());
    if (ids.length) await this.pollIds(ids);
  }

  // The 50 videos most likely to have views we haven't seen yet.
  pickBatch(now) {
    const active = Object.entries(this.track.videos).filter(([, v]) => !v.g);
    if (active.length <= BATCH) return active.map(([id]) => id);
    return active
      .map(([id, v]) => {
        const age = now - v.t;
        const urgent = !v.k || age > MAX_STALE_MS;
        return [id, urgent ? 1e15 + age : Math.max(v.r, RATE_FLOOR) * age];
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, BATCH)
      .map(([id]) => id);
  }

  async fetchStats(ids) {
    const bucket = this.statsMode === 'batch' && this.headroom('stats') >= this.headroom('main') ? 'stats' : 'main';
    if (bucket === 'stats') {
      try {
        return { res: await this.yt.batchStats({ part: 'statistics', id: ids.join(',') }), via: 'batch' };
      } catch (e) {
        if (!(e instanceof YouTubeError)) throw e;
        if (e.kind === 'quota') this.exhaust('stats');
        else if (e.kind === 'bad' || e.kind === 'notFound' || e.kind === 'auth') this.useListOnly(e.message);
        else throw e;
      }
    }
    return { res: await this.yt.videos({ part: 'statistics', id: ids.join(',') }), via: 'list' };
  }

  useListOnly(why) {
    if (this.statsMode === 'list') return;
    this.statsMode = 'list';
    console.log(`  (Fast stats endpoint not usable${why ? `: ${why}` : ''}. Using videos.list instead.)`);
  }

  async pollIds(ids) {
    if (!ids.length) return;
    const { res, via } = await this.fetchStats(ids);
    if (!this.running) return;
    const now = Date.now();
    const found = new Set();
    for (const it of (res && res.items) || []) {
      const id = it && (it.id || it.videoId);
      const n = Number(it && it.statistics && it.statistics.viewCount);
      if (!id || !Number.isFinite(n) || !this.track.videos[id]) continue;
      found.add(id);
      this.updateVideo(id, n, now);
    }
    if (via === 'batch' && !found.size) {
      // Nothing usable came back from the newer endpoint: don't trust it, use videos.list.
      this.useListOnly('unexpected response');
      return this.pollIds(ids);
    }
    for (const id of ids) {
      if (found.has(id)) continue;
      const v = this.track.videos[id];
      if (!v) continue;
      v.t = now;
      v.m = (v.m || 0) + 1;
      if (v.m >= 3 && !v.g) { // deleted or private: keep its last count for now, stop asking
        v.g = 1;
        v.gt = now;
      }
    }
    this.checkedAt = now;
  }

  updateVideo(id, n, now) {
    const v = this.track.videos[id];
    v.m = 0;
    if (!v.k) {
      // First reading: no history yet, so guess its current pace from its lifetime average.
      const ageS = Math.max(3_600, (now - (v.p || now - 30 * 86_400_000)) / 1000);
      v.v = n;
      v.k = 1;
      v.t = now;
      v.r = (0.5 * n) / ageS;
      return;
    }
    const dt = Math.max(1, (now - v.t) / 1000);
    if (n >= v.v) {
      const a = 1 - Math.exp(-dt / RATE_TAU_S);
      v.r += a * ((n - v.v) / dt - v.r);
      v.v = n;
      delete v.l;
    } else if (!v.l || v.l < 1e12) {
      // A lower count is almost always an older copy from one of YouTube's servers, and they can keep
      // serving it for a minute or more. Ignore it. (Older saves kept a small counter here.)
      v.l = now;
    } else if (now - v.l >= LOWER_ACCEPT_MS) {
      // Every reading has been lower for hours: YouTube really removed views (spam clean-up, say).
      v.v = n;
      delete v.l;
    }
    v.t = now;
  }

  hasUnread() {
    return Object.values(this.track.videos).some((v) => !v.g && !v.k);
  }

  sum() {
    let s = 0;
    for (const v of Object.values(this.track.videos)) s += v.v || 0;
    return s;
  }

  expectedUnseen(now) {
    let s = 0;
    for (const v of Object.values(this.track.videos)) if (!v.g && v.k) s += Math.max(0, v.r) * Math.max(0, now - v.t) / 1000;
    return s;
  }

  // ---------- totals and history ----------
  record() {
    const t = this.track;
    if (!t) return;
    const now = Date.now();
    const total = Math.max(this.sum() + (t.offset || 0), t.total || 0); // the total never goes backwards
    if (t.total != null && total > t.total) {
      if (this.lastIncreaseAt) {
        const gap = now - this.lastIncreaseAt;
        this.changeGapMs = this.changeGapMs == null ? gap : this.changeGapMs * 0.75 + gap * 0.25;
      }
      this.lastIncreaseAt = now;
    }
    t.total = total;
    t.updatedAt = now;
    const h = t.history;
    const last = h[h.length - 1];
    if (!last || now - last[0] >= HISTORY_STEP_MS) h.push([now, total]);
    while (h.length > 2 && now - h[0][0] > HISTORY_KEEP_MS) h.shift();
  }

  valueAt(ms) {
    const t = this.track;
    const pts = t.history.concat(t.updatedAt && t.total != null ? [[t.updatedAt, t.total]] : []);
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

  windowStat(now, spanMs) {
    const t = this.track;
    if (!t || t.total == null || !t.history.length) return null;
    const start = Math.max(now - spanMs, t.history[0][0]);
    const span = now - start;
    if (span < 60_000) return null;
    const before = this.valueAt(start);
    return before == null ? null : { views: Math.max(0, Math.round(t.total - before)), spanMs: span };
  }

  // YouTube refreshes each video's count in bursts (a busy video can jump by minutes' worth of views
  // at once). The slope of a straight line fitted through the last 30 minutes of totals gives the
  // channel's steady pace, which the page counts up at between bursts.
  trend(now) {
    const t = this.track;
    if (!t || t.total == null) return null;
    const pts = t.history.filter((p) => p[0] >= now - TREND_WINDOW_MS);
    if (t.updatedAt && (!pts.length || pts[pts.length - 1][0] < t.updatedAt)) pts.push([t.updatedAt, t.total]);
    if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < 3 * 60_000) return null;
    const y0 = pts[0][1];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [ts, v] of pts) {
      const x = (ts - now) / 1000;
      const y = v - y0;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const n = pts.length;
    const den = n * sxx - sx * sx;
    if (den <= 0) return null;
    const slope = (n * sxy - sx * sy) / den;
    const atNow = (sy - slope * sx) / n;
    return { at: now, value: y0 + atNow, rate: Math.max(0, slope) };
  }

  rate(now) {
    const tr = this.trend(now);
    if (tr) return tr.rate;
    const w = this.windowStat(now, 30 * 60_000);
    return w ? w.views / (w.spanMs / 1000) : null;
  }

  // Totals over the last `spanMs`, one point a minute, for the page's chart.
  historyPoints(spanMs) {
    const t = this.track;
    if (!t) return [];
    const now = Date.now();
    const pts = t.history.filter((p) => p[0] >= now - spanMs);
    if (t.updatedAt && t.total != null && (!pts.length || pts[pts.length - 1][0] < t.updatedAt)) pts.push([t.updatedAt, t.total]);
    return pts;
  }

  // ---------- what the web page gets ----------
  publish() {
    this.emit('update', this.snapshot());
  }

  snapshot() {
    const t = this.track;
    const now = Date.now();
    const ch = t && t.channel;
    const vids = t ? Object.values(t.videos) : [];
    return {
      app: 'live-view-counter',
      status: this.status,
      error: this.error,
      channel: ch ? { id: ch.id, title: ch.title, handle: ch.handle, thumb: ch.thumb, subs: ch.subs, videoCount: ch.videoCount } : null,
      total: t && t.total != null ? t.total : null,
      official: t && t.official ? t.official.views : null,
      updatedAt: t ? t.updatedAt : null,
      checkedAt: this.checkedAt,
      serverTime: now,
      tickMs: Math.round(this.tickMs),
      spreadMs: Math.round(clamp(this.changeGapMs || this.tickMs, this.tickMs, 120_000)),
      rate: t ? this.rate(now) : null,
      lastHour: t ? this.windowStat(now, 3_600_000) : null,
      lastDay: t ? this.windowStat(now, 86_400_000) : null,
      videos: { tracked: vids.filter((v) => !v.g).length, total: vids.length },
      quota: {
        main: quotaUsed(this.state, 'main', now),
        stats: quotaUsed(this.state, 'stats', now),
        budget: this.budget,
        limit: DAILY_LIMIT,
        mode: this.statsMode,
        resetAt: now + msUntilQuotaReset(now),
      },
    };
  }
}

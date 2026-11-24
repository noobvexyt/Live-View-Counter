// Checks the list of counters the page sends before it's saved. Shared by the local app (server.js)
// and the website version (api/index.js).
import { PLATFORMS, normalizeHandle } from './social.js';

export const YT_METRICS = ['views', 'subs', 'videos'];
export const MAX_COUNTERS = 16;

// allowed: which platforms may be used (all of them when left out).
export function cleanCounters(list, allowed = null) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const c of list.slice(0, MAX_COUNTERS)) {
    if (!c || typeof c !== 'object') continue;
    if (allowed && !allowed.includes(c.platform)) continue;
    const id = String(c.id || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!id || ids.has(id)) continue;
    let entry;
    if (c.platform === 'youtube') {
      if (!YT_METRICS.includes(c.metric)) continue;
      entry = { id, platform: 'youtube', metric: c.metric };
    } else {
      const p = PLATFORMS[c.platform];
      const handle = p && normalizeHandle(c.platform, c.handle);
      if (!handle || !p.metrics.includes(c.metric)) continue;
      entry = { id, platform: c.platform, handle, metric: c.metric };
    }
    if (typeof c.label === 'string') entry.label = c.label.slice(0, 80);
    if (Number.isFinite(Number(c.goal)) && Number(c.goal) > 0) entry.goal = Math.min(1e15, Math.round(Number(c.goal)));
    if (c.hidden) entry.hidden = true;
    ids.add(id);
    out.push(entry);
  }
  return out;
}

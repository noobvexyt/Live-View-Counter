/* What the page knows about: platforms and their numbers, fonts, and the default settings. */
(function () {
  'use strict';

  const PLATFORMS = {
    youtube: { name: 'YouTube', color: '#ff3d3d', metrics: ['views', 'subs', 'videos'] },
    tiktok: { name: 'TikTok', color: '#2af0ea', metrics: ['followers', 'likes', 'videos'], placeholder: '@yourname or your profile link' },
    twitch: { name: 'Twitch', color: '#a970ff', metrics: ['followers', 'viewers'], placeholder: 'Your channel name or link' },
    kick: { name: 'Kick', color: '#53fc18', metrics: ['followers', 'viewers'], placeholder: 'Your channel name or link' },
    bluesky: { name: 'Bluesky', color: '#3a8bff', metrics: ['followers', 'posts'], placeholder: 'yourname.bsky.social' },
    instagram: { name: 'Instagram', color: '#ff4f8b', metrics: ['followers', 'posts'], token: true },
  };

  // estimate: count up smoothly between readings at the measured pace. monotonic: never goes down.
  const METRICS = {
    views: { name: 'Total views', label: 'Total views', unit: 'views', estimate: true, monotonic: true },
    subs: { name: 'Subscribers (YouTube rounds this)', label: 'Subscribers', unit: 'subscribers', estimate: false },
    videos: { name: 'Videos', label: 'Videos', unit: 'videos', estimate: false },
    followers: { name: 'Followers', label: 'Followers', unit: 'followers', estimate: true },
    likes: { name: 'Likes', label: 'Likes', unit: 'likes', estimate: true },
    posts: { name: 'Posts', label: 'Posts', unit: 'posts', estimate: false },
    viewers: { name: 'Live viewers (while streaming)', label: 'Watching now', unit: 'viewers', estimate: false },
  };

  // Google Fonts with the weights each one has. "system" fonts need no download.
  const FONTS = [
    { name: 'Roboto', weights: [300, 400, 500, 700, 900] },
    { name: 'Inter', weights: [300, 400, 500, 600, 700, 800, 900] },
    { name: 'Montserrat', weights: [300, 400, 500, 600, 700, 800, 900] },
    { name: 'Poppins', weights: [300, 400, 500, 600, 700, 800, 900] },
    { name: 'Nunito', weights: [300, 400, 600, 700, 800, 900] },
    { name: 'Space Grotesk', weights: [300, 400, 500, 600, 700] },
    { name: 'Oswald', weights: [300, 400, 500, 600, 700] },
    { name: 'Bebas Neue', weights: [400] },
    { name: 'Anton', weights: [400] },
    { name: 'Rajdhani', weights: [300, 400, 500, 600, 700] },
    { name: 'Orbitron', weights: [400, 500, 600, 700, 800, 900] },
    { name: 'Audiowide', weights: [400] },
    { name: 'Russo One', weights: [400] },
    { name: 'Bungee', weights: [400] },
    { name: 'Righteous', weights: [400] },
    { name: 'JetBrains Mono', weights: [300, 400, 500, 600, 700, 800] },
    { name: 'Press Start 2P', weights: [400] },
    { name: 'Playfair Display', weights: [400, 500, 600, 700, 800, 900] },
    { name: 'System', css: 'system-ui, "Segoe UI", -apple-system, sans-serif', system: true, weights: [300, 400, 600, 700, 900] },
  ];

  const SEPARATORS = {
    auto: null,       // this computer's region
    comma: ',',
    space: ' ',  // thin space
    dot: '.',
    apostrophe: '’',
    none: '',
  };

  const DEFAULTS = {
    counters: [{ id: 'yt-views', platform: 'youtube', metric: 'views' }],
    layout: { mode: 'single', rotateSec: 12 },
    text: {
      font: 'Roboto', weight: 700, size: 100, spacing: 0, color: 'white', color1: '#ffffff', color2: '#7aa2ff',
      glow: 0, shadow: false, sep: 'auto', fontAll: false, labelSize: 100, labelUpper: false, nameSize: 100,
    },
    look: {
      style: '3d', speed: 'normal', bg: 'aurora', bg1: '#0f0f0f', bg2: '#1b2550', bgAngle: 160, bgImage: '', bgDim: 35, bgBlur: 0,
      accent: 'logo', accentColor: '#608cff', avatar: true, avatarShape: 'circle', avatarSize: 100, ring: true, name: true,
      label: true, stats: false, chart: false, goal: true, status: true, scale: 100, autoHide: true, wakeLock: false,
    },
    effects: { glow: true, floaters: true, sparks: true, confetti: true, milestones: 'normal', toast: true },
    sound: { type: 'click', volume: 70, pitch: 100, every: 1, chime: true, chimeType: 'bells', chimeVolume: 70, customName: '', customAt: 0 },
    privacy: { analytics: false }, // website version: offer visitors Vercel Web Analytics (they still choose)
  };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  // Defaults with the saved settings laid over them (only keys the defaults know, with the right types).
  function merge(defaults, saved) {
    const out = {};
    for (const [k, dv] of Object.entries(defaults)) {
      const sv = saved ? saved[k] : undefined;
      if (isObj(dv)) out[k] = merge(dv, isObj(sv) ? sv : {});
      else if (Array.isArray(dv)) out[k] = Array.isArray(sv) ? sv : dv.map((x) => ({ ...x }));
      else if (typeof sv === typeof dv) out[k] = sv;
      else out[k] = dv;
    }
    return out;
  }

  window.LVC = window.LVC || {};
  Object.assign(window.LVC, { PLATFORMS, METRICS, FONTS, SEPARATORS, DEFAULTS, merge });
})();

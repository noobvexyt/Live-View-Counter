/* Sounds: a short tick each time the number goes up (several to choose from, or your own file) and
   a chime for milestones. Everything is made with Web Audio, so no sound files need downloading. */
(function () {
  'use strict';

  const TICKS = {
    click: 'Click',
    tick: 'Soft tick',
    pop: 'Pop',
    bubble: 'Bubble',
    coin: 'Coin',
    type: 'Typewriter',
    wood: 'Wood block',
    beep: 'Beep',
    custom: 'Your own sound',
  };
  const CHIMES = { bells: 'Bells', fanfare: 'Fanfare', arcade: 'Arcade', soft: 'Soft chord' };

  // ---------- synthesised tick sounds ----------
  function render(c, seconds, fn) {
    const sr = c.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buf = c.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const state = { phase: 0, phase2: 0, lp: 0 };
    let peak = 0;
    for (let i = 0; i < len; i++) {
      d[i] = fn(i / sr, state, sr);
      peak = Math.max(peak, Math.abs(d[i]));
    }
    if (peak > 0) for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;
    return buf;
  }
  const noise = () => Math.random() * 2 - 1;
  const TAU = Math.PI * 2;

  const SYNTH = {
    // A soft mechanical tick: filtered noise with a little body under it.
    click: (c) => render(c, 0.04, (t, s) => {
      const n = noise() * Math.exp(-t / 0.0011);
      const body = Math.sin(TAU * 1650 * t) * Math.exp(-t / 0.0032);
      const knock = Math.sin(TAU * 420 * t) * Math.exp(-t / 0.006) * 0.35;
      s.lp += (n * 0.7 + body * 0.55 + knock - s.lp) * 0.5;
      return s.lp * Math.min(1, t / 0.0003);
    }),
    tick: (c) => render(c, 0.03, (t) => {
      const hi = Math.sin(TAU * 3200 * t) * Math.exp(-t / 0.0018) * 0.6;
      const n = noise() * Math.exp(-t / 0.0005) * 0.35;
      return (hi + n) * Math.min(1, t / 0.0002);
    }),
    pop: (c) => render(c, 0.09, (t, s, sr) => {
      const f = 700 * Math.exp(-t / 0.02) + 240;
      s.phase += (TAU * f) / sr;
      return Math.sin(s.phase) * Math.exp(-t / 0.02) * Math.min(1, t / 0.001);
    }),
    bubble: (c) => render(c, 0.1, (t, s, sr) => {
      const f = 380 + 1100 * (1 - Math.exp(-t / 0.028));
      s.phase += (TAU * f) / sr;
      return Math.sin(s.phase) * Math.exp(-t / 0.03) * Math.min(1, t / 0.002);
    }),
    coin: (c) => render(c, 0.26, (t, s, sr) => {
      const f = t < 0.06 ? 988 : 1319;
      s.phase += (TAU * f) / sr;
      const sq = Math.sin(s.phase) + Math.sin(3 * s.phase) / 3 + Math.sin(5 * s.phase) / 5;
      const env = t < 0.06 ? 0.8 : Math.exp(-(t - 0.06) / 0.07);
      return sq * env * Math.min(1, t / 0.001);
    }),
    type: (c) => render(c, 0.05, (t, s) => {
      const n = noise();
      const hp = n - s.lp; // crude high-pass for the clack
      s.lp += (n - s.lp) * 0.2;
      const clack = hp * Math.exp(-t / 0.0035);
      const thump = Math.sin(TAU * 180 * t) * Math.exp(-t / 0.01) * 0.5;
      const ring = Math.sin(TAU * 2500 * t) * Math.exp(-t / 0.003) * 0.25;
      return (clack + thump + ring) * Math.min(1, t / 0.0002);
    }),
    wood: (c) => render(c, 0.07, (t) => {
      const a = Math.sin(TAU * 880 * t) * Math.exp(-t / 0.012);
      const b = Math.sin(TAU * 1850 * t) * Math.exp(-t / 0.006) * 0.4;
      const n = noise() * Math.exp(-t / 0.0007) * 0.3;
      return (a + b + n) * Math.min(1, t / 0.0004);
    }),
    beep: (c) => render(c, 0.075, (t) => {
      const env = Math.min(1, t / 0.003) * Math.min(1, (0.075 - t) / 0.025);
      return Math.sin(TAU * 1046.5 * t) * env;
    }),
  };

  function createSound({ overlay, params, onState }) {
    const KEY = 'lvc.sound';
    let on = !overlay;
    try {
      const saved = localStorage.getItem(KEY);
      if (saved != null && !overlay) on = saved === '1';
    } catch (e) { /* storage blocked: use the default */ }
    if (params.has('sound')) on = params.get('sound') !== '0';

    const cfg = { type: 'click', volume: 70, pitch: 100, chime: true, chimeType: 'bells', chimeVolume: 70, customAt: 0 };
    let ctx = null;
    let tickOut = null;
    let chimeOut = null;
    const buffers = {};
    let customLoadedAt = -1;
    let lastAt = 0;
    let active = true; // false while no counter is on screen

    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      tickOut = ctx.createGain();
      chimeOut = ctx.createGain();
      tickOut.connect(ctx.destination);
      chimeOut.connect(ctx.destination);
      applyVolume();
      ctx.onstatechange = () => onState();
      loadCustom();
      return ctx;
    }

    function applyVolume() {
      if (!ctx) return;
      tickOut.gain.value = Math.pow(cfg.volume / 100, 1.6) * 0.75;
      chimeOut.gain.value = Math.pow(cfg.chimeVolume / 100, 1.6) * 1.3;
    }

    function buffer(type) {
      if (type === 'custom') return buffers.custom || null;
      if (!buffers[type] && SYNTH[type]) buffers[type] = SYNTH[type](ctx);
      return buffers[type] || null;
    }

    function loadCustom() {
      if (!ctx || cfg.type !== 'custom' || customLoadedAt === cfg.customAt) return;
      customLoadedAt = cfg.customAt;
      fetch(`/api/files/sound?v=${encodeURIComponent(cfg.customAt || 0)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('none'))))
        .then((ab) => ctx.decodeAudioData(ab))
        .then((b) => { buffers.custom = b; })
        .catch(() => { buffers.custom = null; });
    }

    function unlock() {
      if (!on) return;
      const c = ensure();
      if (c && c.state !== 'running') c.resume().then(onState, () => {});
    }

    const ready = () => on && active && ctx && ctx.state === 'running' && !document.hidden;

    function play(type, delay, force) {
      if (!(force ? ctx && ctx.state === 'running' : ready())) return;
      const b = buffer(type) || buffer('click');
      if (!b) return;
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = (cfg.pitch / 100) * (type === 'custom' ? 1 : 0.95 + Math.random() * 0.1);
      src.connect(tickOut);
      src.start(ctx.currentTime + (delay || 0));
    }

    // delay (seconds) lines the click up with the moment the digit lands.
    function tick(delay = 0) {
      const now = performance.now();
      if (now - lastAt < 70) return; // a fast catch-up shouldn't turn into a buzz
      lastAt = now;
      play(cfg.type, delay);
    }

    // Milestone chime. level: 1 = every 1,000, 2 = every 10,000, 3 = 100,000 and goals.
    function chime(level, force, typeOverride) {
      if (!force && (!cfg.chime || !ready())) return;
      if (force && (!ctx || ctx.state !== 'running')) return;
      const type = typeOverride || cfg.chimeType;
      const t0 = ctx.currentTime + 0.12;
      const note = (freq, start, dur, wave, vol) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = wave;
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(vol, start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.connect(g);
        g.connect(chimeOut);
        o.start(start);
        o.stop(start + dur + 0.05);
      };
      if (type === 'fanfare') {
        const notes = level >= 3 ? [523.25, 659.25, 783.99, 1046.5] : level === 2 ? [659.25, 783.99, 1046.5] : [783.99, 1046.5];
        notes.forEach((f, i) => note(f, t0 + i * 0.13, i === notes.length - 1 ? 1.4 : 0.5, 'triangle', 0.16));
        if (level >= 3) notes.forEach((f) => note(f, t0 + notes.length * 0.13, 1.6, 'triangle', 0.07));
      } else if (type === 'arcade') {
        const base = level >= 3 ? [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568] : level === 2 ? [659.25, 830.6, 987.8, 1318.5] : [987.8, 1318.5];
        base.forEach((f, i) => note(f, t0 + i * 0.06, 0.12, 'square', 0.045));
      } else if (type === 'soft') {
        const chord = level >= 3 ? [261.6, 329.6, 392, 523.25, 659.25] : level === 2 ? [392, 493.9, 587.3] : [587.3, 784];
        chord.forEach((f) => note(f, t0, 2.2, 'sine', 0.07));
      } else {
        const notes = level >= 3 ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : level === 2 ? [783.99, 1046.5, 1318.5] : [1318.5, 1975.5];
        notes.forEach((freq, i) => {
          const t = t0 + i * 0.085;
          note(freq, t, 1.4, 'sine', 0.11);
          note(freq * 2.01, t, 1.4, 'sine', 0.03);
        });
      }
    }

    function setOn(value) {
      on = value;
      try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* not saved, still works */ }
      if (on) unlock();
      else if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
      onState();
    }

    function configure(next) {
      Object.assign(cfg, next);
      applyVolume();
      loadCustom();
    }

    // Try a sound from Settings (turns sound on for this device if it was off).
    function preview(type) {
      if (!on) setOn(true);
      unlock();
      const go = () => {
        if (type === 'custom') loadCustom();
        setTimeout(() => play(type || cfg.type, 0, true), type === 'custom' && !buffers.custom ? 300 : 0);
      };
      if (ctx && ctx.state === 'running') go();
      else setTimeout(go, 120);
    }
    function previewChime(type, level) {
      if (!on) setOn(true);
      unlock();
      setTimeout(() => chime(level || 2, true, type), ctx && ctx.state === 'running' ? 0 : 120);
    }

    // Browsers only allow sound after the first click or key press on the page.
    ['pointerdown', 'keydown', 'touchend'].forEach((t) => window.addEventListener(t, unlock, { passive: true }));
    // Start straight away where sound is allowed without a click (OBS browser sources, some browsers).
    let allowed = overlay;
    try { allowed = allowed || (navigator.getAutoplayPolicy && navigator.getAutoplayPolicy('audiocontext') === 'allowed'); } catch (e) { /* unknown */ }
    if (on && allowed) unlock();

    return {
      tick, chime, setOn, configure, preview, previewChime, unlock,
      reloadCustom() { customLoadedAt = -1; buffers.custom = null; loadCustom(); },
      get on() { return on; },
      get blocked() { return on && (!ctx || ctx.state !== 'running'); },
      set active(v) { active = !!v; },
    };
  }

  window.LVC = window.LVC || {};
  window.LVC.TICK_SOUNDS = TICKS;
  window.LVC.CHIME_SOUNDS = CHIMES;
  window.LVC.createSound = createSound;
})();

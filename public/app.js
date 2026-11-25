/* Live View Counter: browser side. Receives numbers from the server and animates them, one card per
   counter (YouTube views, Bluesky followers, …), laid out one at a time, in a grid, or taking turns.
   All the look-and-sound settings are applied here as they change.

   Two modes, decided by /api/config:
   - the local app (server.js on the owner's computer): live updates over Server-Sent Events, and the
     YouTube views count rolls on between readings at the measured pace;
   - the website version (api/index.js on Vercel): each account has a page at /u/<username>. It checks
     for new numbers every 20 to 30 seconds and shows each platform's official numbers only, with no
     estimates. Only the page's owner, signed in, can change it; everyone else just watches (and only
     if the owner has made the page public). */
(function () {
  'use strict';

  const L = window.LVC;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const OVERLAY = params.has('overlay');
  const ONLY = params.get('counter') || '';
  const STYLE_OVERRIDE = ['3d', 'classic', 'plain'].includes(params.get('style')) ? params.get('style') : '';
  const LAYOUT_OVERRIDE = ['single', 'grid', 'rotate'].includes(params.get('layout')) ? params.get('layout') : '';
  const SEE_THROUGH = OVERLAY && params.get('bg') !== 'show';
  if (OVERLAY) document.documentElement.classList.add('overlay');
  if (SEE_THROUGH) document.documentElement.classList.add('see-through');

  // Website version or local app? Known once /api/config answers (see boot() at the bottom).
  let HOSTED = false;
  let OWN = false;   // website: this is the signed-in person's own page
  let PAGE = '';     // website: whose page this is (from the address, /u/<name>)
  let CFG = {};
  const suspended = () => Boolean(CFG.user && CFG.user.suspended);
  const canEdit = () => !HOSTED || (OWN && !suspended());
  // The website's account API lives under /api/me/; the local app's is directly under /api/.
  const api = (path) => (HOSTED ? `/api/me/${path}` : `/api/${path}`);
  const signInUrl = () => `/signin?next=${encodeURIComponent(location.pathname)}`;

  // ---------- settings (shared by every browser and OBS; saved on the server) ----------
  let user = {};                       // what has been changed from the defaults
  let S = L.merge(L.DEFAULTS, user);   // defaults + changes
  let rev = 0;
  let localEditAt = 0;
  let saveTimer = 0;
  let settingsReady = false;
  const settingsListeners = [];
  const snapListeners = [];

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) {
      if (!isObj(o[k])) o[k] = {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = value;
  }
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  function recompute() {
    S = L.merge(L.DEFAULTS, user);
  }

  function update(path, value) {
    setPath(user, path, value);
    localEditAt = performance.now();
    recompute();
    applySettings();
    scheduleSave();
  }

  function setCounters(list) {
    user.counters = list.map((c) => ({ ...c }));
    localEditAt = performance.now();
    recompute();
    applySettings();
    scheduleSave();
  }

  function replaceAll(next) {
    user = isObj(next) ? JSON.parse(JSON.stringify(next)) : {};
    localEditAt = performance.now();
    recompute();
    applySettings();
    scheduleSave();
  }

  function scheduleSave() {
    if (!canEdit()) return;
    clearTimeout(saveTimer);
    setSaveState('Saving…');
    saveTimer = setTimeout(save, HOSTED ? 800 : 350); // (the website's database counts every save)
  }

  async function save() {
    const res = await postJson(api('settings'), { settings: user });
    if (res.ok) {
      rev = Math.max(rev, res.rev || 0);
      if (Array.isArray(res.counters) && JSON.stringify(res.counters) !== JSON.stringify(user.counters || null) && user.counters) {
        user.counters = res.counters;
        recompute();
        syncCards();
        notifySettings();
      }
      setSaveState('Saved');
      if (res.state) applySnapshot(res.state); // website: newly added accounts come back already read
    } else {
      setSaveState((res.error && res.error.message) || 'Not saved', true);
    }
  }

  let saveStateTimer = 0;
  function setSaveState(text, bad) {
    const el = $('save-state');
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    clearTimeout(saveStateTimer);
    if (text === 'Saved') saveStateTimer = setTimeout(() => { el.textContent = ''; }, 1600);
  }

  function onServerSettings(d) {
    if (!d || !isObj(d.settings)) return;
    if (settingsReady && (d.rev || 0) <= rev) return;              // our own save coming back, or an older copy
    if (settingsReady && performance.now() - localEditAt < 1500) return; // still editing here; ours wins
    rev = d.rev || rev;
    user = d.settings;
    recompute();
    settingsReady = true;
    applySettings();
    notifySettings();
  }

  function notifySettings() {
    for (const fn of settingsListeners) {
      try { fn(S); } catch (e) { console.error(e); }
    }
  }

  // ---------- number formatting ----------
  let SEP = ',';
  function sepChar() {
    const v = L.SEPARATORS[S.text.sep];
    if (v != null) return v;
    try {
      const p = new Intl.NumberFormat().formatToParts(1000).find((x) => x.type === 'group');
      return p ? p.value : ',';
    } catch (e) {
      return ',';
    }
  }
  function fmt(n) {
    const neg = n < 0;
    const s = String(Math.round(Math.abs(Number(n) || 0)));
    const g = SEP ? s.replace(/\B(?=(\d{3})+(?!\d))/g, SEP) : s;
    return (neg ? '−' : '') + g;
  }
  L.format = (n) => fmt(n);

  // ---------- connection to the server ----------
  let snap = null;
  let skew = 0;
  let lost = false;
  let lostTimer = 0;
  let stopped = false;
  let es = null;
  let view = null;

  // Local app: one long-lived stream that the server pushes every change down.
  function connect() {
    es = new EventSource('/api/stream');
    es.addEventListener('settings', (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      onServerSettings(d);
    });
    es.onmessage = (ev) => {
      clearTimeout(lostTimer);
      lostTimer = 0;
      if (lost) { lost = false; renderStatus(); renderBanner(); }
      let s;
      try { s = JSON.parse(ev.data); } catch (e) { return; }
      applySnapshot(s);
    };
    es.onerror = () => {
      if (!lostTimer && !lost) {
        lostTimer = setTimeout(() => { lost = true; lostTimer = 0; renderStatus(); renderBanner(); }, 4000);
      }
    };
  }

  // Website: ask every 20 seconds (once a minute while the tab is hidden). Visitors' answers can come
  // from Vercel's cache, so many visitors cost about the same as one. The owner's own page is never
  // cached (so changes show straight away); it asks every 30 seconds, as numbers change once a minute.
  let pollTimer = 0;
  let pollFails = 0;
  let polling = false;
  let lastPoll = 0;
  let missing = false; // website: this page is private or doesn't exist
  async function poll() {
    if (polling) return;
    polling = true;
    clearTimeout(pollTimer);
    lastPoll = Date.now();
    try {
      const r = OWN
        ? await fetch('/api/me/state', { cache: 'no-store', credentials: 'same-origin' })
        : await fetch(`/api/u/${encodeURIComponent(PAGE)}/state`, { credentials: 'omit' });
      if (OWN && r.status === 401) { location.replace(signInUrl()); return; }
      if (!OWN && r.status === 404) {
        pollFails = 0;
        if (lost) { lost = false; renderStatus(); renderBanner(); }
        showMissing();
      } else {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = await r.json();
        pollFails = 0;
        if (lost) { lost = false; renderStatus(); renderBanner(); }
        if (missing) {
          missing = false;
          $('controls').hidden = OVERLAY;
          if (HOSTED && !OWN && !OVERLAY) $('report-link').hidden = false;
          renderEmpty();
        }
        applySnapshot(s);
      }
    } catch (e) {
      pollFails++;
      if (pollFails >= 2 && !lost) { lost = true; renderStatus(); renderBanner(); }
    }
    polling = false;
    const every = missing ? 60_000 : OWN ? 30_000 : 20_000;
    pollTimer = setTimeout(poll, document.hidden ? 60_000 : pollFails ? Math.min(60_000, 10_000 * pollFails) : every);
  }

  // A visitor opened a page that's private, suspended or doesn't exist. (It's checked again now and
  // then, in case the owner makes it public.)
  function showMissing() {
    if (!missing) {
      missing = true;
      snap = null;
      for (const card of cards.values()) card.destroy();
      cards.clear();
      order = [];
      activeId = null;
      applyLayout();
    }
    if (!settingsReady) { settingsReady = true; applySettings(); }
    show('counter');
    $('controls').hidden = true; // nothing to play or enlarge
    if ($('report-link')) $('report-link').hidden = true;
    refreshSoundUi();
    renderEmpty();
    renderStatus();
    renderBanner();
    document.title = 'Nothing to see here · Live View Counter';
  }

  // The message shown when there are no counters on screen.
  function renderEmpty() {
    const box = $('empty');
    const text = $('empty-text');
    const branded = missing && !OVERLAY;
    if (missing) {
      text.textContent = OVERLAY
        ? 'Nothing to show. If this is your page, make it public on your account page to use it in OBS.'
        : 'This page is private, or there’s no account with this name. If it’s yours, sign in and make it public on your account page.';
    } else {
      text.textContent = 'No counters to show yet.';
    }
    $('empty-logo').hidden = !branded;
    $('empty-title').hidden = !branded;
    box.classList.toggle('branded', branded);
    $('empty-links').hidden = !HOSTED || OVERLAY || canEdit();
    const ytBtn = $('btn-empty-youtube');
    ytBtn.hidden = missing || OVERLAY || !canEdit() || ytReady();
    $('btn-empty-add').classList.toggle('primary', ytBtn.hidden); // the YouTube button comes first when it's there
    $('btn-empty-add').classList.toggle('ghost', !ytBtn.hidden);
    box.hidden = !missing && (order.length > 0 || view !== 'counter');
  }
  document.addEventListener('visibilitychange', () => {
    if (HOSTED && !document.hidden && Date.now() - lastPoll > 10_000) poll();
  });

  let newestSnap = 0;
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return;
    // Website: answers can come from a cache, so one can be older than what this page already shows
    // (for example right after the owner saves). Skip those.
    if (HOSTED) {
      const t = Number(s.serverTime) || 0;
      if (t && t < newestSnap) return;
      newestSnap = Math.max(newestSnap, t);
    }
    snap = s;
    // (The website's answer may come from a cache, so its clock can be behind: trust this device's.)
    if (s.serverTime && !HOSTED) skew = s.serverTime - Date.now();
    if (HOSTED && s.settings) onServerSettings(s.settings);
    if (!settingsReady) return; // wait for the settings, which arrive first
    syncCards();
    decideView();
    renderStatus();
    renderBanner();
    for (const fn of snapListeners) {
      try { fn(snap); } catch (e) { console.error(e); }
    }
  }

  const ytReady = () => Boolean(snap && snap.status !== 'setup');
  // "Count other platforms instead": remembered on this device (on the website, for each page).
  let skipSetup = false;
  const skipKey = () => (HOSTED ? `lvc.skipSetup.${PAGE}` : 'lvc.skipSetup');
  try { skipSetup = localStorage.getItem('lvc.skipSetup') === '1'; } catch (e) { /* default */ }

  function decideView() {
    const others = S.counters.some((c) => c.platform !== 'youtube');
    show(!ytReady() && !others && !skipSetup && !OVERLAY && canEdit() ? 'setup' : 'counter');
  }

  function show(which) {
    if (view === which) return;
    view = which;
    $('counter-view').hidden = which !== 'counter';
    $('setup-view').hidden = which !== 'setup';
    $('controls').hidden = which !== 'counter' || OVERLAY;
    document.body.classList.toggle('counting', which === 'counter');
    if (which === 'setup') {
      if (L.settingsUI) L.settingsUI.close();
      prefillSetup();
      document.title = 'Live View Counter';
    }
    renderStatus();
    refreshSoundUi();
    refitSoon();
  }

  // ---------- one counter on screen ----------
  const LEAN_S = 240;       // how gently the number leans toward the latest reading
  const AHEAD_SOFT_S = 150; // past this many seconds' worth ahead of the reading, it slows right down
  const AHEAD_MAX_S = 240;  // ...and stops here until the next reading
  const estimating = (R) => R * AHEAD_SOFT_S >= 1;
  function catchUp(backlog) {
    if (backlog <= 0) return 0;
    if (backlog > 40) return backlog / 3;
    return Math.max(backlog / 4, Math.min(backlog, 3) / 1.5);
  }

  const cards = new Map(); // id -> Card
  const celebrated = new Set(); // website: goals already celebrated while this page is open
  let order = [];          // ids on screen, in order
  let activeId = null;

  const fx = L.createFX({
    canvas: $('fx'),
    floaters: $('floaters'),
    toast: $('milestone'),
    chime: (level) => sound.chime(level),
  });

  const sound = L.createSound({ overlay: OVERLAY, params, onState: () => refreshSoundUi() });

  const safeHref = (u) => (/^https:\/\//.test(String(u || '')) ? u : null);

  class Card {
    constructor(cfg) {
      this.cfg = cfg;
      this.id = cfg.id;
      const el = $('card-tpl').content.firstElementChild.cloneNode(true);
      this.el = el;
      el.dataset.id = cfg.id;
      const q = (s) => el.querySelector(s);
      this.link = q('.avatar-link');
      this.avatar = q('.avatar');
      this.nameEl = q('.channel-name');
      this.number = q('.number');
      this.halo = q('.halo');
      this.labelEl = q('.count-label');
      this.statsEl = q('.stats-line');
      this.goalEl = q('.goal');
      this.goalFill = q('.goal-fill');
      this.goalLeft = q('.goal-left');
      this.goalPct = q('.goal-pct');
      this.chart = q('.chart');
      this.note = q('.card-note');
      this.sourceEl = q('.card-source');
      this.checkedAt = 0;
      this.reset();
      this.accent = L.makeAccent(null);
      this.logoUrl = '';
      this.title = '';
      this.history = [];
      this.historyAt = 0;
      this.r = null;
      this.rKey = '';
      this.binding = fx.bind({
        number: this.number,
        halo: this.halo,
        renderer: () => this.r,
        unit: () => this.meta.unit,
        accent: () => this.accent,
        visible: () => this.visible(),
      });
      this.avatar.addEventListener('error', () => {
        if (!this.avatar.src.startsWith('data:')) this.avatar.src = initialAvatar(this.title || '?');
      });
      $('cards').appendChild(el);
      this.makeRenderer();
      this.refreshAccent();
    }

    reset() {
      this.shown = null;
      this.real = null;
      this.rate = 0;
      this.status = 'starting';
      this.lastInt = null;
      this.lastSetAt = 0;
      this.identity = null;
      this.day = null;
      this.daySpan = 0;
      if (this.number) this.number.classList.remove('ready');
    }

    get meta() { return L.METRICS[this.cfg.metric] || L.METRICS.views; }
    style() { return STYLE_OVERRIDE || S.look.style; }
    visible() { return view === 'counter' && !this.el.hidden && (layoutMode() === 'grid' || this.id === activeId); }

    setConfig(cfg) {
      const same = cfg.platform === this.cfg.platform && cfg.handle === this.cfg.handle && cfg.metric === this.cfg.metric;
      this.cfg = cfg;
      if (!same) {
        this.reset();
        this.history = [];
        this.historyAt = 0;
        if (this.r) { this.r.destroy(); this.r = null; this.rKey = ''; }
        this.makeRenderer();
      }
    }

    makeRenderer() {
      const style = this.style();
      const speed = { slow: 0.65, normal: 1, fast: 1.6 }[S.look.speed] || 1;
      const key = `${style}|${SEP}|${speed}`;
      if (key === this.rKey && this.r) return;
      const value = this.lastInt;
      if (this.r) this.r.destroy();
      this.rKey = key;
      const onLayout = () => fitCard(this);
      this.r = style === 'classic'
        ? new window.Odometer(this.number, { onLayout, sep: SEP, speed })
        : style === 'plain'
          ? new window.PlainCounter(this.number, { onLayout, sep: SEP })
          : new window.DrumCounter(this.number, { onLayout, sep: SEP, speed, onLand: () => { if (this.visible()) sound.tick(0); } });
      if (value != null) this.r.set(value, style === '3d' ? { intro: true } : { instant: true });
    }

    // What the server says about this counter right now.
    reading() {
      const c = this.cfg;
      const s = snap || {};
      if (c.platform === 'youtube') {
        const ch = s.channel;
        if (!ytReady() || !ch) {
          return { ready: false, status: s.status || 'starting', note: ytReady() || !snap || !canEdit() ? '' : 'Connect your YouTube channel under Settings → App.' };
        }
        const link = ch.handle
          ? `https://www.youtube.com/${encodeURIComponent(ch.handle).replace(/^%40/, '@')}`
          : `https://www.youtube.com/channel/${encodeURIComponent(ch.id)}`;
        const base = {
          ready: true, identity: `yt:${ch.id}:${c.metric}`, name: ch.title, avatar: ch.thumb, link, status: s.status,
          source: 'YouTube', checkedAt: s.checkedAt,
        };
        if (c.metric === 'views') {
          if (HOSTED) return { ...base, value: s.total, rate: 0, day: null, daySpan: 0 };
          return { ...base, value: s.total, rate: s.rate, day: s.lastDay ? s.lastDay.views : null, daySpan: s.lastDay ? s.lastDay.spanMs : 0 };
        }
        if (c.metric === 'subs') {
          return {
            ...base, value: ch.subs, rate: 0, source: 'YouTube, which rounds subscriber counts',
            note: ch.subs == null ? 'This channel hides its subscriber count.' : '',
          };
        }
        return { ...base, value: ch.videoCount, rate: 0 };
      }
      const key = `${c.platform}:${String(c.handle || '').toLowerCase()}`;
      const src = s.sources && s.sources[key];
      if (!src) return { ready: false, status: 'starting', name: c.handle };
      const m = src.metrics && src.metrics[c.metric];
      let note = '';
      if (src.error && HOSTED && !canEdit()) note = m ? 'Couldn’t get the latest number, so this is the last one we got. Trying again soon.' : 'Couldn’t get this number right now. Trying again soon.';
      else if (src.error) note = `${src.error.message}${src.status === 'offline' && src.error.retryAt ? ` Trying again ${until(src.error.retryAt)}.` : ''}`;
      else if (c.metric === 'viewers' && !src.live) note = 'Not live right now.';
      return {
        source: (L.PLATFORMS[c.platform] || {}).name || '',
        checkedAt: src.checkedAt,
        ready: Boolean(m),
        identity: `${key}:${c.metric}`,
        name: src.name,
        avatar: src.avatar,
        link: src.url,
        status: src.status,
        value: m ? m.value : null,
        rate: m ? m.rate : 0,
        day: m && m.day ? m.day.change : null,
        daySpan: m && m.day ? m.day.spanMs : 0,
        note,
      };
    }

    update() {
      const r = this.reading();
      this.status = r.status;
      this.checkedAt = r.checkedAt || 0;
      if (r.name != null) this.title = r.name;
      this.renderHeader(r);
      this.setNote(r.note || '');
      const source = HOSTED && r.ready && r.source ? `Source: ${r.source}` : '';
      if (this.sourceEl.textContent !== source) this.sourceEl.textContent = source;
      this.sourceEl.hidden = !source;
      if (!r.ready || r.value == null) return;
      this.rate = r.rate > 0 ? r.rate : 0;
      this.day = r.day;
      this.daySpan = r.daySpan;
      if (this.shown == null || r.identity !== this.identity) {
        this.identity = r.identity;
        this.real = this.shown = r.value;
        if (this.meta.monotonic) {
          // Refreshing the page picks up where the last one left off, so the count never steps back.
          const saved = loadShown(this.id);
          if (saved && saved.identity === r.identity && Date.now() - saved.at < 120_000 && saved.shown > r.value
            && saved.shown - r.value <= (this.rate || 0) * AHEAD_MAX_S) this.shown = saved.shown;
        }
        this.lastInt = Math.floor(this.shown);
        this.r.set(this.lastInt, this.style() === '3d' ? { intro: true } : { instant: true });
        this.number.classList.add('ready');
        this.lastSetAt = performance.now();
        this.renderExtras();
        this.loadHistory(true);
        updateTitle(true);
        return;
      }
      if (this.meta.monotonic) {
        if (r.value > this.real) this.real = r.value; // never count backwards
      } else {
        this.real = r.value;
      }
      this.renderStats();
    }

    renderHeader(r) {
      this.nameEl.textContent = this.title || ' ';
      const href = safeHref(r.link);
      if (href) this.link.href = href;
      else this.link.removeAttribute('href');
      const platform = L.PLATFORMS[this.cfg.platform];
      this.link.title = platform ? `Open on ${platform.name}` : '';
      this.avatar.alt = this.title ? `${this.title} logo` : 'Logo';
      const label = this.cfg.label || this.defaultLabel();
      if (this.labelEl.textContent !== label) this.labelEl.textContent = label;
      this.number.setAttribute('aria-label', `${label}${this.lastInt != null ? `: ${fmt(this.lastInt)}` : ''}`);
      if (r.avatar && r.avatar !== this.logoUrl) {
        this.logoUrl = r.avatar;
        this.avatar.src = r.avatar;
        this.refreshAccent();
      } else if (!r.avatar && !this.logoUrl && this.title) {
        this.avatar.src = initialAvatar(this.title);
      }
    }

    defaultLabel() {
      const m = this.meta;
      if (this.cfg.platform === 'youtube') return m.label;
      const p = L.PLATFORMS[this.cfg.platform];
      return p ? `${m.label} on ${p.name}` : m.label;
    }

    setNote(text) {
      if (this.note.textContent !== text) this.note.textContent = text;
      this.note.hidden = !text;
    }

    refreshAccent() {
      if (S.look.accent === 'custom') {
        this.setAccent(L.makeAccent(null, L.hexToRgb(S.look.accentColor) || [96, 140, 255]));
        return;
      }
      const url = this.logoUrl;
      if (!url) { this.setAccent(L.makeAccent(null)); return; }
      L.readLogo(url, (hs) => {
        if (this.logoUrl === url && S.look.accent !== 'custom') this.setAccent(L.makeAccent(hs));
      });
    }

    setAccent(acc) {
      this.accent = acc;
      this.el.style.setProperty('--accent', acc.a.join(' '));
      this.el.style.setProperty('--accent-2', acc.b.join(' '));
      if (this.id === focusId()) setRootAccent(acc);
      this.drawChart();
    }

    pace() {
      // The website shows official numbers only, so it never counts on ahead of them.
      return !HOSTED && !lost && !stopped && this.status === 'live' && this.meta.estimate && this.rate > 0 ? this.rate : 0;
    }

    // Units per second to move at right now. YouTube refreshes view counts in bursts (and other sites
    // only every half a minute or so), so the number rolls steadily at the measured pace and leans
    // gently toward each new reading. It never runs more than a few minutes' worth ahead of the reading.
    speed() {
      const R = this.pace();
      const behind = this.real - this.shown;
      if (!estimating(R)) {
        if (behind >= 0) return catchUp(behind);
        return this.meta.monotonic ? 0 : -catchUp(-behind);
      }
      if (!this.meta.monotonic && behind < 0 && -behind > R * AHEAD_SOFT_S) return -catchUp(-behind - R * AHEAD_SOFT_S * 0.5);
      const s = behind / R; // how many seconds' worth the latest reading is ahead of the screen
      let f = Math.min(2.2, Math.max(0.35, 1 + s / LEAN_S));
      if (-s > AHEAD_SOFT_S) f = Math.min(f, (0.35 * Math.max(0, AHEAD_MAX_S + s)) / (AHEAD_MAX_S - AHEAD_SOFT_S));
      let v = R * f + Math.max(0, behind - R * 300) / 20; // far behind (new upload found, back online): catch up in ~20 s
      if (R < 0.3 && behind >= 1) v = Math.max(v, Math.min(behind, 3) / 1.5); // quiet: show each new one promptly
      return v;
    }

    step(now, dt) {
      if (this.shown == null || this.real == null) return;
      const before = this.shown;
      for (let left = Math.min(dt, 120_000); left > 0; left -= 100) this.shown += (this.speed() * Math.min(100, left)) / 1000;
      const R = this.pace();
      const ceiling = estimating(R) ? this.real + R * AHEAD_MAX_S : this.real;
      if (this.shown >= before) this.shown = Math.min(this.shown, Math.max(ceiling, before));
      else this.shown = Math.max(this.shown, Math.min(this.real, before)); // going down: never below the reading
      if (this.meta.monotonic) this.shown = Math.max(this.shown, before);

      const n = Math.floor(this.shown + 1e-9);
      if (n === this.lastInt || now - this.lastSetAt < 60) return;
      const since = now - this.lastSetAt;
      this.r.set(n, { duration: Math.max(140, Math.min(520, since * 0.9)) });
      const prev = this.lastInt;
      this.lastInt = n;
      this.lastSetAt = now;
      if (n > prev && this.visible()) {
        const every = Number(S.sound.every) || 1;
        if (every <= 1 || Math.floor(n / every) > Math.floor(prev / every)) sound.tick(this.style() === '3d' ? 0.1 : 0);
        this.binding.tick(prev, n);
      }
      this.checkGoal(prev, n);
      this.renderGoal();
      if (this.id === focusId()) updateTitle();
    }

    renderExtras() {
      this.renderStats();
      this.renderGoal();
      this.drawChart();
    }

    renderStats() {
      const parts = [];
      if (S.look.stats && this.lastInt != null) {
        if (this.meta.estimate && this.rate > 0) parts.push(rateText(this.rate, this.meta.unit));
        if (this.day != null) parts.push(`${this.day >= 0 ? '+' : '−'}${fmt(Math.abs(this.day))} in ${spanText(this.daySpan)}`);
      }
      const text = parts.join('   ·   ');
      if (this.statsEl.textContent !== text) this.statsEl.textContent = text;
      this.statsEl.hidden = !text;
    }

    // On the website, YouTube counters show only YouTube's own numbers: no goal bar, chart or changes,
    // which would be figures calculated from YouTube's data (not allowed by its API policies).
    officialOnly() { return HOSTED && this.cfg.platform === 'youtube'; }

    renderGoal() {
      const g = Number(this.cfg.goal) || 0;
      const showIt = S.look.goal && g > 0 && this.lastInt != null && !this.officialOnly();
      this.goalEl.hidden = !showIt;
      if (!showIt) return;
      const v = this.lastInt;
      const pct = Math.max(0, Math.min(100, (v / g) * 100));
      this.goalFill.style.width = `${pct.toFixed(3)}%`;
      this.goalLeft.textContent = v >= g ? `Goal reached: ${fmt(g)}` : `${fmt(g - v)} to go · goal ${fmt(g)}`;
      this.goalPct.textContent = v < g && pct > 99.99 ? '99.99%' : `${pct.toFixed(pct >= 99.95 || pct < 10 ? 2 : 1)}%`;
    }

    checkGoal(prev, next) {
      const g = Number(this.cfg.goal) || 0;
      if (!(g > 0 && prev < g && next >= g) || this.officialOnly()) return;
      const key = `lvc.goal.${this.id}.${g}`;
      if (HOSTED) {
        // The website stores nothing on visitors' devices for this: it's remembered until the page closes.
        if (celebrated.has(key)) return;
        celebrated.add(key);
      } else {
        try {
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, '1');
        } catch (e) { /* celebrate anyway */ }
      }
      if (this.visible()) this.binding.goal(g);
    }

    async loadHistory(force) {
      if (HOSTED || !S.look.chart || this.id == null) return; // (the website keeps no history)
      const now = Date.now();
      if (!force && now - this.historyAt < 60_000) return;
      this.historyAt = now;
      try {
        const r = await fetch(`/api/history?counter=${encodeURIComponent(this.id)}`, { cache: 'no-store' });
        const j = await r.json();
        this.history = Array.isArray(j.points) ? j.points : [];
      } catch (e) { /* keep the old chart */ }
      this.drawChart();
    }

    drawChart() {
      const showIt = !HOSTED && S.look.chart && this.history.length >= 2 && this.lastInt != null;
      this.chart.hidden = !showIt;
      if (!showIt) return;
      const c = this.chart;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const pts = this.history.slice();
      pts.push([Date.now() + skew, this.lastInt]);
      const t0 = pts[0][0];
      const t1 = pts[pts.length - 1][0];
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
      if (hi - lo < 2) { hi += 1; lo -= 1; }
      const pad = 3;
      const X = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - 2 * pad);
      const Y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
      const acc = this.accent.a.join(',');
      const path = () => {
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      };
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `rgba(${acc},0.32)`);
      grad.addColorStop(1, `rgba(${acc},0)`);
      path();
      g.lineTo(X(t1), h);
      g.lineTo(X(t0), h);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      path();
      g.strokeStyle = `rgb(${acc})`;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.stroke();
    }

    destroy() {
      if (this.r) this.r.destroy();
      this.el.remove();
    }
  }

  // ---------- layout: one at a time, a grid, or taking turns ----------
  const layoutMode = () => (ONLY ? 'single' : LAYOUT_OVERRIDE || S.layout.mode);
  const focusId = () => (layoutMode() === 'grid' ? order[0] : activeId);

  function wantedCounters() {
    let list = ONLY ? S.counters.filter((c) => c.id === ONLY) : S.counters.filter((c) => !c.hidden);
    list = list.filter((c) => c.platform !== 'youtube' || ytReady());
    return list;
  }

  function syncCards() {
    const list = wantedCounters();
    const ids = list.map((c) => c.id);
    for (const [id, card] of cards) {
      if (!ids.includes(id)) {
        card.destroy();
        cards.delete(id);
      }
    }
    for (const c of list) {
      const card = cards.get(c.id);
      if (card) card.setConfig(c);
      else cards.set(c.id, new Card(c));
    }
    for (const id of ids) $('cards').appendChild(cards.get(id).el);
    const changed = ids.join('|') !== order.join('|');
    order = ids;
    if (!ids.includes(activeId)) activeId = ids[0] || null;
    if (changed) applyLayout();
    for (const card of cards.values()) card.update();
    renderEmpty();
  }

  function gridCols(n) {
    const wide = window.innerWidth >= window.innerHeight;
    if (n <= 1) return 1;
    if (!wide) return n <= 3 ? 1 : 2;
    if (n <= 3) return n;
    if (n === 4) return 2;
    if (n <= 6) return 3;
    return 4;
  }

  let rotateTimer = 0;
  function applyLayout() {
    const mode = layoutMode();
    const n = order.length;
    const box = $('cards');
    const eff = n > 1 ? mode : 'single';
    box.className = `cards layout-${eff}`;
    box.style.setProperty('--cols', gridCols(n));
    for (const id of order) cards.get(id).el.classList.toggle('active', eff === 'grid' || id === activeId);
    $('pager').hidden = OVERLAY || n < 2 || eff === 'grid';
    renderDots();
    clearInterval(rotateTimer);
    if (eff === 'rotate') rotateTimer = setInterval(() => go(1, true), Math.max(4, S.layout.rotateSec) * 1000);
    const f = cards.get(focusId());
    if (f) setRootAccent(f.accent);
    updateTitle(true);
    renderStatus();
    refitSoon();
  }

  function renderDots() {
    const dots = $('dots');
    dots.textContent = '';
    order.forEach((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `dot${id === activeId ? ' on' : ''}`;
      const card = cards.get(id);
      b.setAttribute('aria-label', card && card.title ? card.title : 'Counter');
      b.addEventListener('click', () => { activeId = id; applyLayout(); });
      dots.appendChild(b);
    });
  }

  function go(delta, auto) {
    if (order.length < 2 || layoutMode() === 'grid') return;
    const i = Math.max(0, order.indexOf(activeId));
    activeId = order[(i + delta + order.length) % order.length];
    if (auto) {
      for (const id of order) cards.get(id).el.classList.toggle('active', id === activeId);
      renderDots();
      const f = cards.get(activeId);
      if (f) setRootAccent(f.accent);
      updateTitle(true);
      renderStatus();
    } else {
      applyLayout();
    }
  }
  $('btn-prev').addEventListener('click', () => go(-1));
  $('btn-next').addEventListener('click', () => go(1));

  function setRootAccent(acc) {
    const root = document.documentElement.style;
    root.setProperty('--accent', acc.a.join(' '));
    root.setProperty('--accent-2', acc.b.join(' '));
  }

  // ---------- sizing ----------
  function fitCard(card) {
    const el = card.el;
    if (!el.isConnected || view !== 'counter') return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const scale = S.look.scale / 100;
    const grid = $('cards').classList.contains('layout-grid');
    const k = Math.max(0.36, Math.min(1.6, Math.min(w / 700, h / 760))) * scale;
    el.style.setProperty('--k', k.toFixed(3));
    const num = card.number;
    if (!num.firstChild) return;
    num.style.fontSize = '100px';
    const r = num.getBoundingClientRect();
    const nw = num.scrollWidth || r.width || 1;
    const nh = r.height || 80;
    const size = S.text.size / 100;
    const maxW = Math.min(w - 32, 1700) * 0.94;
    const share = OVERLAY && !grid ? 0.42 : grid ? 0.24 : 0.2;
    const maxH = h * share * (card.style() === '3d' ? 1.25 : 1) * size * scale;
    const px = Math.max(18, Math.min((100 * maxW) / nw, (100 * maxH) / nh, 340 * size * scale));
    num.style.fontSize = `${px.toFixed(1)}px`;
  }
  function fitAll() {
    for (const card of cards.values()) {
      fitCard(card);
      card.drawChart();
    }
  }
  let fitRaf = 0;
  function refitSoon() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      fitAll();
    });
  }
  window.addEventListener('resize', () => {
    const box = $('cards');
    if (box.classList.contains('layout-grid')) box.style.setProperty('--cols', gridCols(order.length));
    refitSoon();
  });
  if (window.ResizeObserver) new ResizeObserver(refitSoon).observe($('counter-view'));
  if (document.fonts) {
    document.fonts.ready.then(refitSoon);
    document.fonts.addEventListener('loadingdone', refitSoon);
  }

  // ---------- the animation loop ----------
  let lastFrame = performance.now();
  function step(now) {
    const dt = Math.max(0, now - lastFrame);
    lastFrame = now;
    for (const card of cards.values()) card.step(now, dt);
  }
  function frame(now) {
    step(now);
    requestAnimationFrame(frame);
  }
  // Browsers pause animation frames in background or covered tabs; keep counting (and the tab title) anyway.
  setInterval(() => {
    const now = performance.now();
    if (now - lastFrame > 900) step(now);
  }, 1000);

  // Local app: remember where each count was, so a refresh never steps back. (The website never runs
  // ahead of the official numbers, so it doesn't need this and stores nothing.)
  function loadShown(id) {
    if (HOSTED) return null;
    try { return JSON.parse(localStorage.getItem(`lvc.shown.${id}`) || 'null'); } catch (e) { return null; }
  }
  setInterval(() => {
    if (HOSTED) return;
    for (const card of cards.values()) {
      if (!card.meta.monotonic || card.lastInt == null) continue;
      try { localStorage.setItem(`lvc.shown.${card.id}`, JSON.stringify({ identity: card.identity, shown: card.lastInt, at: Date.now() })); } catch (e) { /* fine */ }
    }
  }, 2000);

  // Slower things: stats text, charts, notes with countdowns.
  setInterval(() => {
    if (view !== 'counter') return;
    for (const card of cards.values()) {
      card.renderStats();
      card.drawChart();
      card.loadHistory(false);
      if (card.note.textContent.includes('Trying again')) card.update();
    }
    if (snap && (snap.status === 'offline' || snap.status === 'quota')) renderBanner();
    if (HOSTED) renderStatus(); // "Checked 20s ago"
  }, 5000);

  let titleAt = 0;
  function updateTitle(force) {
    const t = performance.now();
    if (!force && t - titleAt < 1000) return;
    titleAt = t;
    if (view !== 'counter') return;
    const card = cards.get(focusId());
    if (!card || card.lastInt == null) { document.title = 'Live View Counter'; return; }
    document.title = `${fmt(card.lastInt)} ${card.meta.unit}${card.title ? ` · ${card.title}` : ''}`;
  }

  // ---------- applying settings ----------
  // Fonts come from Google Fonts. On the website they load only if the visitor allows it (Cookie
  // settings); until then the page uses a similar font already on the device.
  const UI_FONT = { name: 'Roboto', weights: [300, 400, 500, 700, 900] };
  const loadedFonts = new Set();
  function loadFont(font) {
    if (font.system || loadedFonts.has(font.name)) return;
    if (L.site && !L.site.allows('fonts')) return;
    loadedFonts.add(font.name);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.name).replace(/%20/g, '+')}:wght@${font.weights.join(';')}&display=swap`;
    link.onload = refitSoon;
    document.head.appendChild(link);
  }
  const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  const safeColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : d);

  function backgroundUrl() {
    if (HOSTED) return ''; // the website has no background pictures, so visitors never load other sites
    const v = String(S.look.bgImage || '').trim();
    if (v.startsWith('upload:')) return `/api/files/background?v=${encodeURIComponent(v.slice(7))}`;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  let wakeLock = null;
  async function setWakeLock(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* not allowed here */ }
  }
  document.addEventListener('visibilitychange', () => { if (S.look.wakeLock) setWakeLock(true); });

  function applySettings() {
    const root = document.documentElement.style;
    const b = document.body.classList;
    const t = S.text;
    const lk = S.look;
    SEP = sepChar();

    const style = STYLE_OVERRIDE || lk.style;
    for (const s of ['3d', 'classic', 'plain']) b.toggle(`style-${s}`, style === s);

    const font = L.FONTS.find((f) => f.name === t.font) || L.FONTS[0];
    loadFont(UI_FONT);
    loadFont(font);
    const family = font.system ? font.css : `"${font.name}", ${/Mono|Press Start/.test(font.name) ? 'monospace' : 'sans-serif'}`;
    root.setProperty('--num-font', family);
    root.setProperty('--num-weight', String(nearest(font.weights, t.weight)));
    root.setProperty('--ui-font', t.fontAll ? family : 'var(--font)');
    root.setProperty('--ui-weight', t.fontAll ? String(nearest(font.weights, 700)) : '700');
    root.setProperty('--num-spacing', `${(t.spacing / 100).toFixed(2)}em`);
    root.setProperty('--c1', safeColor(t.color1, '#ffffff'));
    root.setProperty('--c2', safeColor(t.color2, '#7aa2ff'));
    for (const c of ['white', 'accent', 'custom', 'gradient']) b.toggle(`num-${c}`, t.color === c);
    root.setProperty('--glow', String(t.glow / 100));
    b.toggle('has-glow', t.glow > 0);
    b.toggle('num-shadow', !!t.shadow);
    root.setProperty('--name-scale', String(t.nameSize / 100));
    root.setProperty('--label-scale', String(t.labelSize / 100));
    b.toggle('label-upper', !!t.labelUpper);

    const bg = SEE_THROUGH ? 'transparent' : lk.bg;
    for (const v of ['aurora', 'solid', 'gradient', 'image', 'transparent']) b.toggle(`bgm-${v}`, bg === v);
    // In OBS a "Transparent" look means see-through; a normal browser shows plain black instead of white.
    if (OVERLAY) document.documentElement.classList.toggle('see-through', bg === 'transparent');
    root.setProperty('--bg1', safeColor(lk.bg1, '#0f0f0f'));
    root.setProperty('--bg2', safeColor(lk.bg2, '#1b2550'));
    root.setProperty('--bg-angle', `${Number(lk.bgAngle) || 0}deg`);
    root.setProperty('--bg-dim', String(lk.bgDim / 100));
    root.setProperty('--bg-blur', `${Number(lk.bgBlur) || 0}px`);
    const url = bg === 'image' ? backgroundUrl() : '';
    $('bg').querySelector('.bg-image').style.backgroundImage = url ? `url("${url.replace(/["\\\n\r]/g, encodeURIComponent)}")` : '';

    b.toggle('no-avatar', !lk.avatar);
    b.toggle('no-ring', !lk.ring);
    b.toggle('no-name', !lk.name);
    b.toggle('no-label', !lk.label);
    for (const s of ['circle', 'rounded', 'square']) b.toggle(`avatar-${s}`, lk.avatarShape === s);
    root.setProperty('--avatar-scale', String(lk.avatarSize / 100));

    Object.assign(fx.options, S.effects);
    b.toggle('fx-glow', !!S.effects.glow);

    sound.configure({
      type: S.sound.type, volume: S.sound.volume, pitch: S.sound.pitch, chime: S.sound.chime,
      chimeType: S.sound.chimeType, chimeVolume: S.sound.chimeVolume, customAt: S.sound.customAt,
    });

    setWakeLock(!!lk.wakeLock && !OVERLAY);
    if (!lk.autoHide) document.body.classList.remove('idle');

    for (const card of cards.values()) {
      card.makeRenderer();
      card.refreshAccent();
      card.renderExtras();
      if (lk.chart) card.loadHistory(false);
    }
    syncCards();
    applyLayout();
    if (snap) decideView();
    renderStatus();
  }

  // ---------- status, banner, sound button ----------
  function renderStatus() {
    const box = $('status');
    const visible = layoutMode() === 'grid' ? order.map((id) => cards.get(id)) : [cards.get(activeId)];
    const statuses = visible.filter(Boolean).map((c) => c.status);
    // (Nothing to report on an empty page.)
    box.hidden = view !== 'counter' || OVERLAY || !S.look.status || (!statuses.length && !lost && !stopped);
    if (box.hidden) return;
    let cls = 'live';
    let text = 'Updating live';
    const checked = Math.max(0, ...visible.filter(Boolean).map((c) => c.checkedAt || 0));
    if (stopped) { cls = 'paused'; text = 'Stopped'; }
    else if (lost) { cls = 'offline'; text = 'Reconnecting…'; }
    else if (!statuses.length || statuses.every((s) => s === 'starting')) { cls = 'starting'; text = 'Connecting…'; }
    else if (statuses.includes('live')) { cls = 'live'; text = HOSTED ? (checked ? `Checked ${ago(checked)}` : 'Official numbers') : 'Updating live'; }
    else if (statuses.includes('offline')) { cls = 'offline'; text = 'Reconnecting…'; }
    else if (statuses.includes('quota')) { cls = 'paused'; text = 'Paused until the daily reset'; }
    else { cls = 'paused'; text = 'Paused'; }
    box.className = `status ${cls}`;
    $('status-text').textContent = text;
  }

  function rateText(r, unit) {
    if (r == null) return '–';
    if (r >= 1) return `≈ ${r >= 10 ? Math.round(r) : r.toFixed(1)} ${unit}/sec`;
    const m = r * 60;
    if (m >= 1) return `≈ ${m >= 10 ? Math.round(m) : m.toFixed(1)} ${unit}/min`;
    const h = r * 3600;
    if (h >= 0.5) return `≈ ${Math.round(h)} ${unit}/hour`;
    return 'quiet right now';
  }
  function spanText(ms) {
    if (!ms || ms >= 23.5 * 3_600_000) return '24 hours';
    if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
    return `${Math.max(1, Math.round(ms / 60_000))} min`;
  }
  function ago(ms) {
    if (ms == null) return '';
    const s = Math.max(0, Math.round((Date.now() + skew - ms) / 1000));
    if (s < 3) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }
  function until(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((ms - (Date.now() + skew)) / 1000));
    if (s < 60) return `in ${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `in ${m} min`;
    return `in ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function renderBanner() {
    const box = $('banner');
    const actions = $('banner-actions');
    actions.textContent = '';
    let text = '';
    let tone = '';
    const s = snap;
    const err = (s && s.error) || {};
    const ytShown = order.some((id) => cards.get(id) && cards.get(id).cfg.platform === 'youtube');
    const visitor = !canEdit(); // website visitors get plain messages; the owner gets the details
    if (HOSTED && OWN && suspended()) {
      text = 'Your account is suspended, so your page is hidden from everyone else and can’t be changed. To ask about it, email noobvexbusiness@gmail.com.';
      tone = 'error';
    } else if (missing) {
      text = '';
    } else if (stopped) {
      text = 'The counter is stopped. Start it again with the “Live View Counter” icon on your desktop.';
      tone = 'warn';
    } else if (lost) {
      text = HOSTED
        ? 'Can’t reach the website right now, so these may not be the latest numbers. Trying again…'
        : 'Lost connection to the counter on this computer. It may still be starting up, or it was stopped. Open the “Live View Counter” icon on your desktop to start it again. Reconnecting…';
      tone = 'error';
    } else if (ytShown && s && s.status === 'starting') {
      text = HOSTED ? 'Getting the latest numbers from YouTube…' : s.total == null ? 'Connecting to YouTube and reading your videos…' : 'Reconnecting to YouTube…';
    } else if (ytShown && s && s.status === 'offline') {
      text = visitor
        ? 'Can’t reach YouTube right now, so these are the last numbers it sent. Trying again soon.'
        : `${err.message || 'Can’t reach YouTube.'} Trying again ${until(err.retryAt)}.${HOSTED ? '' : ' The count carries on from where it stopped.'}`;
      tone = 'warn';
    } else if (ytShown && s && s.status === 'quota') {
      text = HOSTED
        ? 'This site has used up today’s YouTube API allowance, so these are the last numbers YouTube sent. They update again after midnight Pacific time.'
        : `Today’s free YouTube API allowance is used up. Counting resumes at midnight Pacific time (${until(err.resetAt || (s.quota && s.quota.resetAt))}).`;
      tone = 'warn';
    } else if (ytShown && s && s.status === 'error' && visitor) {
      text = 'YouTube isn’t sending this channel’s numbers right now, so these are the last ones it sent.';
      tone = 'warn';
    } else if (ytShown && s && s.status === 'error') {
      text = err.message || 'Something went wrong talking to YouTube.';
      tone = 'error';
      if (err.link) {
        const a = document.createElement('a');
        a.href = err.link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open Google Cloud';
        actions.appendChild(a);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Settings';
      btn.addEventListener('click', () => openSettings('app'));
      actions.appendChild(btn);
    }
    box.className = `banner${tone ? ` ${tone}` : ''}`;
    $('banner-text').textContent = text;
    box.hidden = !text || OVERLAY;
  }

  function refreshSoundUi() {
    const btn = $('btn-sound');
    btn.classList.toggle('muted', !sound.on);
    btn.setAttribute('aria-pressed', String(sound.on));
    btn.title = sound.on ? 'Sound on (M)' : 'Sound off (M)';
    $('sound-hint').hidden = !sound.blocked || view !== 'counter' || OVERLAY || missing;
    sound.active = view === 'counter';
    if ($('sound-on')) $('sound-on').checked = sound.on;
  }
  $('btn-sound').addEventListener('click', () => sound.setOn(!sound.on));
  $('sound-hint').addEventListener('click', () => refreshSoundUi());

  function initialAvatar(name) {
    const letter = (String(name || '?').trim()[0] || '?').toUpperCase().replace(/[<>&"']/g, '?');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#3f3f3f"/><text x="50" y="50" dy=".35em" text-anchor="middle" font-family="Roboto, Segoe UI, Arial, sans-serif" font-size="46" font-weight="700" fill="#f1f1f1">${letter}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  // ---------- helpers shared with the settings panel ----------
  async function getConfig() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      return await r.json();
    } catch (e) {
      return {};
    }
  }

  async function postJson(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json();
      // Website: signed out (on another device, or the sign-in ran out). Sign in again, then come back.
      if (HOSTED && r.status === 401 && j && j.error && j.error.signIn) location.replace(signInUrl());
      return j;
    } catch (e) {
      return {
        ok: false,
        error: { message: HOSTED ? 'Couldn’t reach the website. Check your connection and try again.' : 'Couldn’t reach the counter app on this computer. Is it running?' },
      };
    }
  }

  function showError(el, err, inputs) {
    el.textContent = '';
    el.appendChild(document.createTextNode(err.message || 'Something went wrong.'));
    if (err.link) {
      el.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = err.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open Google Cloud';
      el.appendChild(a);
    }
    el.hidden = false;
    for (const [field, input] of Object.entries(inputs || {})) input.classList.toggle('invalid', err.field === field);
    const bad = inputs && inputs[err.field];
    if (bad) bad.focus();
  }

  // ---------- first-time setup ----------
  async function prefillSetup() {
    const c = await getConfig();
    if (c.channelInput && !$('in-channel').value) $('in-channel').value = c.channelInput;
    renderKeyField(c);
  }

  // Website: everyone can paste their own free API key. It's needed unless they saved one already or
  // the site owner added a key everyone can use.
  const keyNeeded = () => HOSTED && !CFG.keyHint && !CFG.ytAvailable;
  function renderKeyField(c) {
    if (!HOSTED || !c || typeof c !== 'object') return;
    if (typeof c.ytAvailable === 'boolean') CFG.ytAvailable = c.ytAvailable;
    if (typeof c.keyHint === 'string') CFG.keyHint = c.keyHint;
    const input = $('in-key');
    if (CFG.keyHint) {
      $('in-key-label').textContent = 'YouTube Data API key (saved)';
      input.placeholder = `Saved key ${CFG.keyHint}`;
      $('in-key-hint').textContent = 'Leave this empty to keep using your saved key, or paste a new one to replace it.';
    } else if (CFG.ytAvailable) {
      $('in-key-label').textContent = 'YouTube Data API key (optional)';
      input.placeholder = 'AIza…';
      $('in-key-hint').textContent = 'Leave this empty to use this site’s key, or paste your own free key (steps below). Yours is kept with your account, never shown on any page, and only used to read your channel’s public numbers.';
    } else {
      $('in-key-label').textContent = 'YouTube Data API key';
      input.placeholder = 'AIza…';
      $('in-key-hint').textContent = 'Free from Google: the steps below show how to get one (about 3 minutes). It’s kept with your account in this site’s private database, never shown on any page, and only used to read your channel’s public numbers.';
    }
    $('key-guide').open = keyNeeded();
    const status = $('in-key-status');
    status.hidden = !CFG.keyHint;
    if (CFG.keyHint) status.textContent = `Your API key is saved (ending ${CFG.keyHint.replace(/^…/, '')}).`;
  }
  // A short "it worked" pulse on a key status line.
  function flashStatus(el) {
    el.classList.remove('flash');
    void el.offsetWidth; // (restarts the animation)
    el.classList.add('flash');
  }

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-connect');
    const inputs = { channel: $('in-channel'), apiKey: $('in-key') };
    const body = { channel: inputs.channel.value.trim() };
    const key = inputs.apiKey.value.replace(/\s+/g, '');
    if (key) body.apiKey = key;
    $('setup-error').hidden = true;
    if (!body.channel) return showError($('setup-error'), { field: 'channel', message: 'Enter your channel’s @handle or a link to it.' }, inputs);
    if ((!HOSTED || keyNeeded()) && !body.apiKey) {
      $('key-guide').open = true;
      return showError($('setup-error'), { field: 'apiKey', message: 'Paste your YouTube Data API key. It’s free from Google, and the steps below show how to get one.' }, inputs);
    }
    btn.disabled = true;
    btn.textContent = 'Checking with YouTube…';
    const res = await postJson(api('connect'), body);
    btn.disabled = false;
    btn.textContent = 'Start counting';
    if (!res.ok) {
      if (res.error && res.error.field === 'apiKey') $('key-guide').open = true;
      if (HOSTED && res.error && res.error.keySaved) {
        // The key worked and was kept: only the channel needs fixing.
        renderKeyField({ keyHint: res.error.keyHint || '' });
        inputs.apiKey.value = '';
        flashStatus($('in-key-status'));
        return showError($('setup-error'), { ...res.error, message: `${res.error.message} Your API key was saved, so just fix the channel.` }, inputs);
      }
      return showError($('setup-error'), res.error || {}, inputs);
    }
    if (HOSTED && typeof res.keyHint === 'string') { renderKeyField({ keyHint: res.keyHint }); if (key) flashStatus($('in-key-status')); }
    inputs.apiKey.value = '';
    for (const i of Object.values(inputs)) i.classList.remove('invalid');
    if (res.state) applySnapshot(res.state); // website: show the channel straight away
    if (!S.counters.some((c) => c.platform === 'youtube')) {
      setCounters([{ id: 'yt-views', platform: 'youtube', metric: 'views' }, ...S.counters]);
    }
  });

  $('btn-skip-youtube').addEventListener('click', () => {
    skipSetup = true;
    try { localStorage.setItem(skipKey(), '1'); } catch (e) { /* fine */ }
    decideView();
    syncCards();
    openSettings('counters');
  });
  $('btn-empty-add').addEventListener('click', () => openSettings('counters'));
  // Back to the YouTube setup from an empty page (for example after choosing "Bluesky instead").
  $('btn-empty-youtube').addEventListener('click', () => {
    skipSetup = false;
    try { localStorage.removeItem(skipKey()); } catch (e) { /* fine */ }
    show('setup');
  });

  document.querySelectorAll('[data-toggle-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.getAttribute('data-toggle-key'));
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    });
  });

  // ---------- full screen, keys, auto-hiding controls ----------
  function openSettings(tab) {
    if (L.settingsUI) L.settingsUI.open(tab);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }
  $('btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('btn-settings').addEventListener('click', () => {
    if (!canEdit()) return;
    if (L.settingsUI && L.settingsUI.isOpen()) L.settingsUI.close();
    else openSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (view !== 'counter' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.target && e.target.closest && e.target.closest('dialog')) return;
    const k = e.key.toLowerCase();
    if (k === 'f') toggleFullscreen();
    else if (k === 'm') sound.setOn(!sound.on);
    else if (k === 's' && canEdit()) openSettings();
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  });
  document.addEventListener('fullscreenchange', () => setTimeout(refitSoon, 50));

  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (S.look.autoHide && !(L.settingsUI && L.settingsUI.isOpen())) document.body.classList.add('idle');
    }, 2500);
  }
  ['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach((t) => window.addEventListener(t, wake, { passive: true }));
  wake();

  // ---------- what the settings panel can use ----------
  L.app = {
    get S() { return S; },
    get user() { return user; },
    get snap() { return snap; },
    get skew() { return skew; },
    get order() { return order.slice(); },
    get overlay() { return OVERLAY; },
    get hosted() { return HOSTED; },
    get admin() { return canEdit(); },
    get own() { return OWN; },
    get page() { return PAGE; },
    get config() { return CFG; },
    api,
    cards,
    sound,
    fx,
    update,
    setCounters,
    replaceAll,
    getPath,
    postJson,
    getConfig,
    applySnapshot,
    showError,
    rateText,
    ago,
    until,
    fmt,
    refitSoon,
    refreshSoundUi,
    focusCard: () => cards.get(focusId()) || null,
    showCounter(id) {
      if (!order.includes(id)) return;
      activeId = id;
      applyLayout();
    },
    onSettings(fn) { settingsListeners.push(fn); },
    onSnapshot(fn) { snapListeners.push(fn); },
    markStopped() {
      stopped = true;
      if (es) es.close();
      clearTimeout(lostTimer);
      renderStatus();
      renderBanner();
    },
  };

  // ---------- start: find out which version this is, then connect ----------
  async function boot() {
    let cfg = null;
    for (let tries = 0; !cfg; tries++) {
      try {
        const r = await fetch('/api/config', { cache: 'no-store' });
        if (r.ok) cfg = await r.json();
      } catch (e) { /* not reachable yet */ }
      if (cfg && typeof cfg === 'object') break;
      cfg = null;
      if (tries === 1) { lost = true; renderBanner(); }
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 2_000 * (tries + 1))));
    }
    if (lost) { lost = false; renderBanner(); }
    CFG = cfg;
    HOSTED = cfg.hosted === true;
    if (HOSTED) {
      // Whose page is this? /u/<username>. Anything else goes to your own page, or the home page.
      const m = location.pathname.match(/^\/u\/([A-Za-z0-9_-]{3,24})\/?$/);
      if (!m) {
        location.replace(cfg.user && cfg.user.page ? cfg.user.page : '/');
        return;
      }
      PAGE = m[1].toLowerCase();
      if (location.pathname !== `/u/${PAGE}`) history.replaceState(null, '', `/u/${PAGE}${location.search}${location.hash}`);
      try {
        localStorage.removeItem('lvc.skipSetup'); // (older versions remembered this for every page at once)
        skipSetup = localStorage.getItem(skipKey()) === '1';
      } catch (e) { skipSetup = false; }
      OWN = Boolean(cfg.user && cfg.user.name === PAGE);
      document.documentElement.classList.toggle('admin', canEdit());
      if (!OWN && !OVERLAY) {
        const report = $('report-link');
        report.href = `mailto:noobvexbusiness@gmail.com?subject=${encodeURIComponent(`Report: page /u/${PAGE}`)}`;
        report.hidden = false;
      }
    }
    if (L.site) {
      L.site.init(cfg, { overlay: OVERLAY, fonts: true });
      L.site.onChange(applySettings); // e.g. fonts allowed: load them now
    }
    applySettings();
    if (HOSTED) poll();
    else connect();
  }

  refreshSoundUi();
  boot();
  requestAnimationFrame(frame);
})();

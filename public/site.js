/* Website version only (the local app never turns this on): privacy choices (the cookie banner),
   the header and footer links that change when you're signed in, and signing out. Used on every page.

   Nothing optional loads until the visitor allows it:
   - fonts: the counter's typeface from Google Fonts (Google receives the visitor's IP address). Only
     counter pages use them, so only they ask straight away;
   - analytics: Vercel Web Analytics, and only if the site has it turned on (WEB_ANALYTICS in Vercel). */
(function () {
  'use strict';

  const L = (window.LVC = window.LVC || {});
  const $ = (id) => document.getElementById(id);
  document.documentElement.classList.add('js');
  const KEY = 'lvc.consent';
  const VERSION = 1;
  const ASK_AGAIN_MS = 365 * 86_400_000; // choices are asked for again after a year

  let hosted = false;
  let overlay = false;
  let usesFonts = false;
  let analyticsOffered = false;
  let analyticsLoaded = false;
  let config = {};
  let choice = loadChoice();
  const listeners = [];

  function loadChoice() {
    try {
      const c = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (c && c.v === VERSION && typeof c.at === 'number' && Date.now() - c.at < ASK_AGAIN_MS) return c;
    } catch (e) { /* nothing saved, or storage is blocked */ }
    return null;
  }

  // The local app runs on the owner's own computer and has no analytics; its fonts always load.
  function allows(what) {
    if (!hosted) return what === 'fonts';
    if (!choice) return false;
    if (what === 'analytics') return analyticsOffered && choice.analytics === true;
    return choice[what] === true;
  }

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  function decide(next) {
    const hadFonts = allows('fonts');
    choice = { v: VERSION, at: Date.now(), fonts: Boolean(next.fonts), analytics: analyticsOffered ? Boolean(next.analytics) : null };
    try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch (e) { /* remembered for this visit only */ }
    closeBanner();
    // Taking permission back: reload, so whatever was already loaded stops.
    if ((hadFonts && usesFonts && !allows('fonts')) || (analyticsLoaded && !allows('analytics'))) {
      location.reload();
      return;
    }
    if (allows('analytics')) loadAnalytics();
    notify();
  }

  function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    const s = document.createElement('script');
    s.defer = true;
    s.src = '/_vercel/insights/script.js';
    document.head.appendChild(s);
  }

  function needsAsking() {
    if (!hosted || overlay) return false;
    if (!choice) return usesFonts || analyticsOffered;
    return analyticsOffered && typeof choice.analytics !== 'boolean';
  }

  // The banner's markup. The counter page has it in its HTML; other pages get it from here.
  function ensureBanner() {
    if ($('consent')) return;
    const box = document.createElement('section');
    box.id = 'consent';
    box.className = 'consent';
    box.hidden = true;
    box.setAttribute('aria-labelledby', 'consent-title');
    // Fixed text only (never anything a user typed).
    box.innerHTML = `
      <h2 id="consent-title">Your privacy choices</h2>
      <p>This site only stores what it needs to work, like the choices you make here. With your permission it can also:</p>
      <label class="check">
        <input id="consent-fonts" type="checkbox">
        <span><b>Load fonts from Google Fonts on counter pages.</b> Google receives your IP address and browser details. Without this, counters use a similar font from your device.</span>
      </label>
      <label id="consent-analytics-row" class="check" hidden>
        <input id="consent-analytics" type="checkbox">
        <span><b>Count visits with Vercel Web Analytics.</b> No cookies. It records the page, the site you came from, your country, and your type of device, browser and operating system.</span>
      </label>
      <div class="consent-actions">
        <button id="consent-reject" class="ghost" type="button">Reject all</button>
        <button id="consent-save" class="ghost" type="button">Save choices</button>
        <button id="consent-accept" class="ghost" type="button">Accept all</button>
      </div>
      <p class="consent-links"><a href="/cookies">Cookie policy</a> · <a href="/privacy">Privacy policy</a> · You can change these choices any time with “Cookie settings” at the bottom of the page.</p>`;
    document.body.appendChild(box);
  }

  function openBanner(focus) {
    if (!hosted || overlay) return;
    ensureBanner();
    $('consent-analytics-row').hidden = !analyticsOffered;
    $('consent-fonts').checked = allows('fonts');
    $('consent-analytics').checked = allows('analytics');
    $('consent').hidden = false;
    if (focus) $('consent-reject').focus();
  }
  function closeBanner() {
    if ($('consent')) $('consent').hidden = true;
  }

  async function signOut(to) {
    try {
      await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { /* the cookie ends by itself */ }
    location.href = to || '/';
  }

  // Header and footer bits that depend on whether someone is signed in.
  function applyUser() {
    const user = config.user || null;
    for (const el of document.querySelectorAll('[data-when-user]')) el.hidden = !user;
    for (const el of document.querySelectorAll('[data-when-guest]')) el.hidden = Boolean(user);
    for (const el of document.querySelectorAll('[data-when-moderator]')) el.hidden = !config.moderator;
    if (user) {
      for (const el of document.querySelectorAll('[data-user-page]')) el.setAttribute('href', user.page);
      for (const el of document.querySelectorAll('[data-user-name]')) el.textContent = user.name;
    }
    const owner = typeof config.owner === 'string' ? config.owner.trim() : '';
    if (owner) for (const el of document.querySelectorAll('[data-owner]')) el.textContent = owner;
    const here = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/';
    for (const a of document.querySelectorAll('.head-nav a, .head-actions a.head-link')) {
      if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
    }
  }

  // The header's menu on small screens.
  function wireMenu() {
    const head = document.querySelector('.site-head');
    const btn = head && head.querySelector('[data-menu-toggle]');
    if (!btn) return;
    const set = (open) => {
      head.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', () => set(!head.classList.contains('open')));
    head.addEventListener('click', (e) => { if (e.target.closest('.head-menu a')) set(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && head.classList.contains('open')) { set(false); btn.focus(); }
    });
    document.addEventListener('click', (e) => { if (!head.contains(e.target)) set(false); });
    window.matchMedia('(min-width: 821px)').addEventListener('change', (m) => { if (m.matches) set(false); });
  }

  const still = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const seen = (els, fn, margin = '0px 0px -8% 0px') => {
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { for (const el of els) fn(el); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { fn(e.target); io.unobserve(e.target); }
    }, { rootMargin: margin });
    for (const el of els) io.observe(el);
  };

  // Sections that rise in as they scroll into view; children of [data-stagger] follow one by one.
  function wireReveal() {
    for (const group of document.querySelectorAll('[data-stagger]')) {
      [...group.children].forEach((c, i) => c.style.setProperty('--i', String(i)));
    }
    seen(document.querySelectorAll('.reveal'), (el) => el.classList.add('in'));
  }

  // Numbers that count up (or down, with data-from) when they come into view.
  function wireCounts() {
    const fmt = (n) => Math.round(n).toLocaleString('en-GB');
    const els = [...document.querySelectorAll('[data-count]')];
    for (const el of els) el.textContent = fmt(still ? Number(el.dataset.count) : Number(el.dataset.from || 0));
    if (still) return;
    seen(els, (el) => {
      const to = Number(el.dataset.count);
      const from = Number(el.dataset.from || 0);
      const ms = Number(el.dataset.ms || 1800);
      const t0 = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - t0) / ms);
        el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 4)));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, '0px 0px -12% 0px');
  }

  // Small example numbers that tick up now and then ([data-tick]="step size").
  function wireTickers() {
    if (still) return;
    for (const el of document.querySelectorAll('[data-tick]')) {
      let v = Number(String(el.textContent).replace(/[^\d]/g, '')) || 0;
      const step = Math.max(1, Number(el.dataset.tick) || 1);
      const go = () => {
        if (!document.hidden) {
          v += step + Math.floor(Math.random() * step * 2);
          el.textContent = v.toLocaleString('en-GB');
          el.classList.remove('bump');
          void el.offsetWidth;
          el.classList.add('bump');
        }
        setTimeout(go, 1600 + Math.random() * 1800);
      };
      setTimeout(go, 1200 + Math.random() * 1000);
    }
  }

  // The moving background, a scroll bar, the header's look once you scroll, the light that follows the
  // cursor over cards, and the 3D tilt of the example page.
  function wireMotion() {
    if (!document.querySelector('.bg-fx')) {
      const fx = document.createElement('div');
      fx.className = 'bg-fx';
      fx.setAttribute('aria-hidden', 'true');
      fx.innerHTML = '<span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span><span class="grid-floor"></span><span class="noise"></span>';
      document.body.prepend(fx);
    }
    const bar = document.createElement('div');
    bar.className = 'scroll-bar';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    const head = document.querySelector('.site-head');
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
        if (head) head.classList.toggle('scrolled', window.scrollY > 8);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
    if (still) return;

    document.addEventListener('pointermove', (e) => {
      const el = e.target && e.target.closest && e.target.closest('.card, .acct-section, .bento-card');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });

    for (const el of document.querySelectorAll('[data-tilt]')) {
      const area = el.closest('[data-tilt-area]') || el.parentElement;
      let frame = 0;
      area.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const r = area.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width - 0.5;
          const y = (e.clientY - r.top) / r.height - 0.5;
          el.style.setProperty('--rx', `${(x * 14).toFixed(2)}deg`);
          el.style.setProperty('--ry', `${(-y * 10).toFixed(2)}deg`);
        });
      });
      area.addEventListener('pointerleave', () => {
        cancelAnimationFrame(frame);
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
    }
  }

  if (document.body && document.body.dataset.page) { wireMenu(); wireMotion(); wireReveal(); wireCounts(); wireTickers(); }

  function wire() {
    ensureBanner();
    $('consent-reject').addEventListener('click', () => decide({ fonts: false, analytics: false }));
    $('consent-accept').addEventListener('click', () => decide({ fonts: true, analytics: true }));
    $('consent-save').addEventListener('click', () => decide({ fonts: $('consent-fonts').checked, analytics: $('consent-analytics').checked }));
    for (const el of document.querySelectorAll('[data-cookie-settings]')) {
      el.addEventListener('click', (e) => { e.preventDefault(); openBanner(true); });
    }
    for (const el of document.querySelectorAll('[data-signout]')) {
      el.addEventListener('click', (e) => { e.preventDefault(); signOut('/signin?out=1'); });
    }
    // The counter page's links bar sits over the page, so the page needs to know its height.
    const foot = $('site-footer');
    if (foot) {
      foot.hidden = false;
      const measure = () => document.documentElement.style.setProperty('--foot', `${foot.offsetHeight}px`);
      measure();
      if (window.ResizeObserver) new ResizeObserver(measure).observe(foot);
    }
  }

  // cfg: what /api/config said. Only the website version answers with hosted: true.
  // opts.overlay: OBS (no links, no banner, nothing optional). opts.fonts: this page uses Google Fonts.
  function init(cfg, opts) {
    hosted = Boolean(cfg && cfg.hosted === true);
    if (!hosted) return;
    config = cfg;
    overlay = Boolean(opts && opts.overlay);
    usesFonts = Boolean(opts && opts.fonts);
    analyticsOffered = Boolean(cfg.analytics);
    const root = document.documentElement.classList;
    root.add('hosted');
    root.toggle('signed-in', Boolean(cfg.user));
    if (overlay) return;
    applyUser();
    wire();
    if (new URLSearchParams(location.search).has('cookies')) openBanner(true);
    else if (needsAsking()) openBanner(false);
    if (allows('analytics')) loadAnalytics();
  }

  // Pages other than the counter (which starts this itself, in app.js) ask for the config here.
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  async function boot() {
    let cfg = null;
    try {
      const r = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
      if (r.ok) cfg = await r.json();
    } catch (e) { /* offline: the page says so when it needs the site */ }
    const known = Boolean(cfg && typeof cfg === 'object');
    if (!known) cfg = { hosted: true, offline: true, user: null };
    init(cfg, {});
    resolveReady(cfg);
  }

  L.site = {
    init,
    allows,
    onChange: (fn) => listeners.push(fn),
    openBanner,
    signOut,
    ready,
    get config() { return config; },
  };

  if (document.body && document.body.dataset.page) boot();
})();

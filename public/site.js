/* Website version only (the local app never turns this on): privacy choices (the cookie banner),
   the legal links along the bottom, and the site owner's sign-in.

   Nothing optional loads until the visitor allows it:
   - fonts: the counter's typeface from Google Fonts (Google receives the visitor's IP address);
   - analytics: Vercel Web Analytics, and only if the owner has turned it on in Settings → App. */
(function () {
  'use strict';

  const L = (window.LVC = window.LVC || {});
  const $ = (id) => document.getElementById(id);
  const KEY = 'lvc.consent';
  const VERSION = 1;
  const ASK_AGAIN_MS = 365 * 86_400_000; // choices are asked for again after a year

  let hosted = false;
  let overlay = false;
  let admin = false;
  let config = {};
  let analyticsOffered = false; // the owner has turned on Vercel Web Analytics
  let settingsSeen = false;
  let analyticsLoaded = false;
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
    if ((hadFonts && !allows('fonts')) || (analyticsLoaded && !allows('analytics'))) {
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
    if (!choice) return true;
    return analyticsOffered && typeof choice.analytics !== 'boolean';
  }

  function openBanner(focus) {
    if (!hosted || overlay) return;
    $('consent-analytics-row').hidden = !analyticsOffered;
    $('consent-fonts').checked = allows('fonts');
    $('consent-analytics').checked = allows('analytics');
    $('consent').hidden = false;
    if (focus) $('consent-reject').focus();
  }
  function closeBanner() {
    $('consent').hidden = true;
  }

  // Called whenever the owner's settings arrive or change: they say whether analytics is on.
  function setOwnerSettings(S) {
    if (!hosted) return;
    const on = Boolean(S && S.privacy && S.privacy.analytics);
    const first = !settingsSeen;
    settingsSeen = true;
    if (!first && on === analyticsOffered) return;
    analyticsOffered = on;
    if (needsAsking()) openBanner(false);
    else if (!$('consent').hidden) $('consent-analytics-row').hidden = !analyticsOffered;
    if (allows('analytics')) loadAnalytics();
  }

  // ---------- the owner's sign-in ----------
  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: { message: 'Couldn’t reach the website. Check your connection and try again.' } };
    }
  }

  function openSignIn() {
    let problem = '';
    if (!config.signIn) problem = 'Owner sign-in isn’t set up yet. The site owner needs to add an ADMIN_PASSWORD (at least 12 characters) in Vercel → Settings → Environment Variables, then redeploy.';
    else if (!config.db) problem = 'No database is connected yet, so changes can’t be saved. The site owner needs to connect an Upstash Redis database in Vercel → Storage, then redeploy.';
    $('owner-setup').textContent = problem;
    $('owner-setup').hidden = !problem;
    $('owner-error').hidden = true;
    $('owner-password').value = '';
    $('owner-password').classList.remove('invalid');
    $('owner-dialog').showModal();
    $('owner-password').focus();
  }

  async function signOut() {
    await post('/api/admin/logout', {});
    location.reload();
  }

  function wire() {
    $('consent-reject').addEventListener('click', () => decide({ fonts: false, analytics: false }));
    $('consent-accept').addEventListener('click', () => decide({ fonts: true, analytics: true }));
    $('consent-save').addEventListener('click', () => decide({ fonts: $('consent-fonts').checked, analytics: $('consent-analytics').checked }));
    $('btn-cookie-settings').addEventListener('click', () => openBanner(true));

    const ownerBtn = $('btn-owner');
    ownerBtn.textContent = admin ? 'Sign out' : 'Owner sign-in';
    ownerBtn.addEventListener('click', () => (admin ? signOut() : openSignIn()));
    $('btn-owner-cancel').addEventListener('click', () => $('owner-dialog').close());
    $('owner-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('owner-password');
      const err = $('owner-error');
      err.hidden = true;
      if (!input.value) {
        err.textContent = 'Enter the password.';
        err.hidden = false;
        input.focus();
        return;
      }
      const btn = $('btn-owner-signin');
      btn.disabled = true;
      const res = await post('/api/admin/login', { password: input.value });
      btn.disabled = false;
      if (res.ok) {
        location.reload();
        return;
      }
      err.textContent = (res.error && res.error.message) || 'Couldn’t sign in.';
      err.hidden = false;
      input.classList.toggle('invalid', Boolean(res.error && res.error.field === 'password'));
      input.select();
    });

    const foot = $('site-footer');
    foot.hidden = false;
    const measure = () => document.documentElement.style.setProperty('--foot', `${foot.offsetHeight}px`);
    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(foot);
  }

  // cfg: what /api/config said. Only the website version answers with hosted: true.
  function init(cfg, opts) {
    hosted = Boolean(cfg && cfg.hosted === true);
    if (!hosted) return;
    config = cfg;
    overlay = Boolean(opts && opts.overlay);
    admin = cfg.admin === true;
    const root = document.documentElement.classList;
    root.add('hosted');
    root.toggle('admin', admin);
    if (overlay) return; // OBS: no footer and no banner, so nothing optional ever loads there
    wire();
    if (new URLSearchParams(location.search).has('cookies')) openBanner(true);
  }

  L.site = {
    init,
    allows,
    onChange: (fn) => listeners.push(fn),
    setOwnerSettings,
    openBanner,
    signOut,
  };
})();

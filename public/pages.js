/* The website's own pages: home, sign up, sign in, forgotten password, account, and the site owner's
   tools. Each page says which it is with <body data-page="…">. site.js runs first and fetches the
   site's settings (including who's signed in); everything here waits for that. */
(function () {
  'use strict';

  const L = window.LVC || {};
  const $ = (id) => document.getElementById(id);
  const PAGE = document.body.dataset.page;
  const params = new URLSearchParams(location.search);
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;
  const OFFLINE = 'Couldn’t reach the website. Check your connection and try again.';

  // ---------- talking to the server ----------
  async function call(method, url, body) {
    try {
      const r = await fetch(url, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await r.json(); } catch (e) { /* not JSON */ }
      if (!data || typeof data !== 'object') {
        data = { ok: false, error: { message: `Something went wrong (error ${r.status}). Try again in a moment.` } };
      }
      return { status: r.status, data };
    } catch (e) {
      return { status: 0, data: { ok: false, error: { message: OFFLINE } } };
    }
  }
  const post = (url, body) => call('POST', url, body || {});
  const get = (url) => call('GET', url);

  // ---------- forms ----------
  // Shows an error under a form, and marks the field it's about (inputs: field name -> element).
  function showError(box, err, inputs) {
    const e = err || {};
    box.textContent = e.message || 'Something went wrong. Try again.';
    box.hidden = false;
    for (const [field, input] of Object.entries(inputs || {})) {
      const bad = e.field === field;
      const mark = input.type === 'checkbox' ? input.closest('.check') : input;
      mark.classList.toggle('invalid', bad);
      if (input.type !== 'checkbox') input.setAttribute('aria-invalid', String(bad));
    }
    const target = inputs && inputs[e.field];
    if (target) target.focus();
  }
  function clearError(box, inputs) {
    box.hidden = true;
    box.textContent = '';
    for (const input of Object.values(inputs || {})) {
      (input.type === 'checkbox' ? input.closest('.check') : input).classList.remove('invalid');
      input.removeAttribute('aria-invalid');
    }
  }
  function busy(btn, on, text) {
    if (on) {
      btn.dataset.text = btn.textContent;
      btn.textContent = text || 'Please wait…';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.text || btn.textContent;
      btn.disabled = false;
    }
  }

  // "Show" buttons next to passwords
  for (const btn of document.querySelectorAll('[data-toggle-pw]')) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.togglePw);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
    });
  }
  // "Caps Lock is on" hints
  for (const hint of document.querySelectorAll('[data-caps-for]')) {
    const input = $(hint.dataset.capsFor);
    const check = (e) => { if (e.getModifierState) hint.hidden = !e.getModifierState('CapsLock'); };
    input.addEventListener('keydown', check);
    input.addEventListener('keyup', check);
    input.addEventListener('blur', () => { hint.hidden = true; });
  }

  const cleanName = (v) => String(v || '').trim().replace(/^@/, '').toLowerCase();
  // Where to go after signing in: only this site's own pages.
  const safeNext = (v) => (/^\/(u\/[a-z0-9_-]{3,24}|account|admin)?$/.test(String(v || '')) ? String(v) : '');
  const when = (ms) => {
    if (!ms) return '–';
    try {
      return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return new Date(ms).toISOString();
    }
  };

  async function copyText(text, btn) {
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch (e) {
      btn.textContent = 'Select it and copy';
    }
    setTimeout(() => { btn.textContent = old; }, 1800);
  }

  // ---------- the recovery code screen (sign up, forgotten password, account) ----------
  function showCode(code, name, continueTo) {
    // Now signed in: the header's "Sign in" / "Sign up" links no longer apply.
    if (continueTo) for (const el of document.querySelectorAll('[data-when-guest]')) el.hidden = true;
    $('code-value').textContent = code;
    const copy = $('btn-copy-code');
    const download = $('btn-download-code');
    copy.onclick = () => copyText(code, copy);
    download.onclick = () => {
      const text = [
        'Live View Counter: recovery code',
        '',
        `Username:      ${name}`,
        `Recovery code: ${code}`,
        `Made:          ${when(Date.now())}`,
        '',
        'If you forget your password, use this code on the "Forgotten your password?" page',
        `(${location.origin}/forgot) to choose a new one. Each code works once.`,
        'Keep it somewhere safe and don’t share it with anyone.',
        '',
      ].join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      a.download = `live-view-counter-recovery-code-${name}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    const saved = $('code-saved');
    const next = $('btn-continue');
    if (saved && next) {
      next.href = continueTo;
      const sync = () => next.setAttribute('aria-disabled', String(!saved.checked));
      saved.checked = false;
      saved.onchange = sync;
      sync();
      next.onclick = (e) => {
        if (!saved.checked) {
          e.preventDefault();
          saved.focus();
        }
      };
    }
  }

  // ---------- home ----------
  function home() {
    const el = $('demo-number');
    if (!el) return;
    let n = 1284519;
    const fmt = (v) => v.toLocaleString('en-GB');
    const tick = () => {
      if (!document.hidden) {
        n += 1 + Math.floor(Math.random() * 3);
        el.textContent = fmt(n);
      }
      setTimeout(tick, 900 + Math.random() * 1600);
    };
    setTimeout(tick, 1200);
  }

  // ---------- sign up ----------
  function signup(cfg) {
    const form = $('signup-form');
    const err = $('signup-error');
    const inputs = { username: $('su-username'), password: $('su-password'), age: $('su-age'), agree: $('su-agree') };
    if (cfg.user) $('signed-in-note').hidden = false;
    if (!cfg.signUp) {
      const note = $('closed-note');
      note.textContent = cfg.offline
        ? OFFLINE
        : cfg.db === false
          ? 'Accounts aren’t available on this site right now. Please try again later.'
          : 'New accounts are paused right now. Please try again later.';
      note.hidden = false;
      for (const el of form.elements) el.disabled = true;
    }
    inputs.username.addEventListener('input', () => {
      const v = cleanName(inputs.username.value);
      $('su-preview').textContent = v || 'yourname';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(err, inputs);
      const name = cleanName(inputs.username.value);
      const password = inputs.password.value;
      if (!name) return showError(err, { field: 'username', message: 'Choose a username.' }, inputs);
      if (!NAME_RE.test(name)) return showError(err, { field: 'username', message: 'Use 3 to 24 lowercase letters, numbers, dashes (-) or underscores (_), starting and ending with a letter or number.' }, inputs);
      if (password.length < 10) return showError(err, { field: 'password', message: 'Use at least 10 characters. Three random words together works well.' }, inputs);
      if (!inputs.age.checked) return showError(err, { field: 'age', message: 'You need to be 13 or older to make an account.' }, inputs);
      if (!inputs.agree.checked) return showError(err, { field: 'agree', message: 'Tick the box to agree to the Terms.' }, inputs);
      const btn = $('btn-signup');
      busy(btn, true, 'Making your account…');
      const { data } = await post('/api/auth/signup', {
        username: name,
        password,
        website: $('su-website').value,
        remember: $('su-remember').checked,
        age: true,
        agree: true,
      });
      busy(btn, false);
      if (!data.ok) return showError(err, data.error, inputs);
      inputs.password.value = '';
      $('signup-panel').hidden = true;
      $('code-panel').hidden = false;
      showCode(data.recoveryCode, data.name, data.page);
      $('code-title').focus();
      document.title = 'Save your recovery code · Live View Counter';
    });
  }

  // ---------- sign in ----------
  function signin(cfg) {
    const next = safeNext(params.get('next'));
    if (cfg.user && next && !params.has('out')) {
      location.replace(next);
      return;
    }
    if (params.has('out')) $('out-note').hidden = false;
    else if (params.has('deleted')) $('deleted-note').hidden = false;
    else if (next) $('next-note').hidden = false;
    if (cfg.user && !params.has('out')) $('signed-in-note').hidden = false;
    if (params.has('out') || params.has('deleted')) history.replaceState(null, '', '/signin');

    const form = $('signin-form');
    const err = $('signin-error');
    const inputs = { username: $('si-username'), password: $('si-password') };
    if (cfg.db === false) showError(err, { message: 'Signing in isn’t available on this site right now. Please try again later.' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(err, inputs);
      const name = cleanName(inputs.username.value);
      if (!name) return showError(err, { field: 'username', message: 'Enter your username.' }, inputs);
      if (!inputs.password.value) return showError(err, { field: 'password', message: 'Enter your password.' }, inputs);
      const btn = $('btn-signin');
      busy(btn, true, 'Signing in…');
      const { data } = await post('/api/auth/signin', { username: name, password: inputs.password.value, remember: $('si-remember').checked });
      if (!data.ok) {
        busy(btn, false);
        inputs.password.value = '';
        return showError(err, data.error, inputs);
      }
      location.href = next || data.page || '/account';
    });
  }

  // ---------- forgotten password ----------
  function forgot() {
    const form = $('forgot-form');
    const err = $('forgot-error');
    const inputs = { username: $('fo-username'), code: $('fo-code'), password: $('fo-password') };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(err, inputs);
      const name = cleanName(inputs.username.value);
      const code = inputs.code.value.trim();
      if (!name) return showError(err, { field: 'username', message: 'Enter your username.' }, inputs);
      if (!code) return showError(err, { field: 'code', message: 'Enter your recovery code.' }, inputs);
      if (inputs.password.value.length < 10) return showError(err, { field: 'password', message: 'Use at least 10 characters. Three random words together works well.' }, inputs);
      const btn = $('btn-forgot');
      busy(btn, true, 'Checking…');
      const { data } = await post('/api/auth/recover', { username: name, code, password: inputs.password.value });
      busy(btn, false);
      if (!data.ok) return showError(err, data.error, inputs);
      inputs.password.value = '';
      inputs.code.value = '';
      $('forgot-panel').hidden = true;
      $('code-panel').hidden = false;
      showCode(data.recoveryCode, data.name, data.page);
      $('code-title').focus();
    });
  }

  // ---------- account ----------
  async function account(cfg) {
    const toSignIn = () => location.replace('/signin?next=/account');
    if (!cfg.offline && !cfg.user) return toSignIn();
    const { status, data } = await get('/api/me');
    if (status === 401) return toSignIn();
    $('loading').hidden = true;
    if (!data.ok) {
      showError($('load-error'), data.error);
      return;
    }
    let me = data;
    $('account').hidden = false;
    const pageUrl = `${location.origin}${me.page}`;
    $('page-url').textContent = pageUrl;
    $('btn-open-page').href = me.page;
    $('btn-copy-url').addEventListener('click', () => copyText(pageUrl, $('btn-copy-url')));
    $('f-name').textContent = me.name;
    $('pw-username').value = me.name;
    $('f-created').textContent = when(me.createdAt);
    $('f-signin').textContent = when(me.signInAt);
    $('f-pw').textContent = when(me.pwAt);
    $('f-youtube').textContent = me.youtube ? me.youtube.input : 'Not connected';
    $('f-counters').textContent = String(me.counters || 0);
    $('f-session').textContent = me.remembered ? when(me.sessionEnds) : 'You close your browser (or 12 hours at most)';

    if (me.suspended) {
      const note = $('suspended-note');
      note.textContent = `Your account is suspended${me.suspended.reason ? ` (${me.suspended.reason})` : ''}. Your page is hidden from everyone else and can’t be changed. You can still download your data or delete your account. To ask about it or appeal, email noobvexbusiness@gmail.com.`;
      note.hidden = false;
    }

    // Who can see the page
    const visBtn = $('btn-visibility');
    const renderVis = () => {
      const pill = $('vis-pill');
      pill.textContent = me.public ? 'Public' : 'Private';
      pill.classList.toggle('on', me.public);
      $('vis-text').textContent = me.public
        ? 'Anyone with the address can see your page. Only you can change it.'
        : 'Only you can see your page, while you’re signed in.';
      visBtn.textContent = me.public ? 'Make my page private' : 'Make my page public';
      visBtn.disabled = Boolean(me.suspended);
    };
    renderVis();
    visBtn.addEventListener('click', async () => {
      const makePublic = !me.public;
      if (makePublic && !window.confirm('Make your page public?\n\nAnyone who has its address will be able to see your counters, your channel’s name and picture, and your username. You can make it private again at any time.')) return;
      $('vis-error').hidden = true;
      busy(visBtn, true, 'Saving…');
      const res = await post('/api/me/visibility', { public: makePublic });
      busy(visBtn, false);
      if (!res.data.ok) {
        if (res.status === 401) return toSignIn();
        return showError($('vis-error'), res.data.error);
      }
      me = { ...me, public: res.data.public };
      renderVis();
    });

    // Change password
    $('pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('pw-error');
      const inputs = { current: $('pw-current'), password: $('pw-new') };
      clearError(err, inputs);
      $('pw-done').hidden = true;
      if (!inputs.current.value) return showError(err, { field: 'current', message: 'Enter your current password.' }, inputs);
      if (inputs.password.value.length < 10) return showError(err, { field: 'password', message: 'Use at least 10 characters. Three random words together works well.' }, inputs);
      const btn = $('btn-pw');
      busy(btn, true, 'Changing…');
      const res = await post('/api/me/password', { current: inputs.current.value, password: inputs.password.value });
      busy(btn, false);
      if (!res.data.ok) {
        if (res.status === 401) return toSignIn();
        return showError(err, res.data.error, inputs);
      }
      inputs.current.value = '';
      inputs.password.value = '';
      $('pw-done').hidden = false;
      $('f-pw').textContent = when(Date.now());
    });

    // New recovery code
    $('rc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('rc-error');
      const inputs = { password: $('rc-password') };
      clearError(err, inputs);
      if (!inputs.password.value) return showError(err, { field: 'password', message: 'Enter your password.' }, inputs);
      const btn = $('btn-rc');
      busy(btn, true, 'Making a new code…');
      const res = await post('/api/me/recovery-code', { password: inputs.password.value });
      busy(btn, false);
      if (!res.data.ok) {
        if (res.status === 401) return toSignIn();
        return showError(err, res.data.error, inputs);
      }
      inputs.password.value = '';
      $('rc-result').hidden = false;
      showCode(res.data.recoveryCode, me.name, '');
    });

    // Sign out everywhere
    $('btn-signout-all').addEventListener('click', async () => {
      if (!window.confirm('Sign out on every device, including this one?')) return;
      const res = await post('/api/me/signout-all');
      if (!res.data.ok && res.status !== 401) return showError($('sessions-error'), res.data.error);
      location.href = '/signin?out=1';
    });

    // Delete
    const dlg = $('delete-dialog');
    $('dd-name').textContent = me.name;
    $('btn-delete').addEventListener('click', () => {
      $('dd-error').hidden = true;
      $('dd-confirm').value = '';
      $('dd-password').value = '';
      dlg.showModal();
      $('dd-confirm').focus();
    });
    $('btn-dd-cancel').addEventListener('click', () => dlg.close());
    $('delete-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('dd-error');
      const inputs = { confirm: $('dd-confirm'), password: $('dd-password') };
      clearError(err, inputs);
      if (cleanName(inputs.confirm.value) !== me.name) return showError(err, { field: 'confirm', message: `Type ${me.name} to confirm.` }, inputs);
      if (!inputs.password.value) return showError(err, { field: 'password', message: 'Enter your password.' }, inputs);
      const btn = $('btn-dd-delete');
      busy(btn, true, 'Deleting…');
      const res = await post('/api/me/delete', { confirm: me.name, password: inputs.password.value });
      busy(btn, false);
      if (!res.data.ok) {
        if (res.status === 401) return toSignIn();
        return showError(err, res.data.error, inputs);
      }
      location.href = '/signin?deleted=1';
    });
  }

  // ---------- the site owner's tools ----------
  function admin(cfg) {
    const login = $('admin-login');
    const tools = $('admin-tools');
    const out = $('btn-admin-out');
    let current = '';

    const showLogin = () => {
      tools.hidden = true;
      out.hidden = true;
      login.hidden = false;
      $('ad-password').focus();
    };
    const showTools = () => {
      login.hidden = true;
      tools.hidden = false;
      out.hidden = false;
      overview();
    };

    async function overview() {
      const { status, data } = await get('/api/admin/overview');
      if (status === 403) return showLogin();
      if (!data.ok) {
        $('yt-status').textContent = 'Couldn’t load the site’s settings. Reload the page to try again.';
        return showError($('ov-error'), data.error);
      }
      $('ov-error').hidden = true;
      $('ov-users').textContent = `${data.users} of ${data.maxUsers}`;
      $('ov-signups').textContent = data.signUpsOpen ? (data.users >= data.maxUsers ? 'Paused: the site is full' : 'Open') : 'Paused (SIGNUPS=closed)';
      $('ov-analytics').textContent = data.analytics ? 'Offered to visitors (they choose)' : 'Off';
      $('ov-watched').textContent = `${data.watched.youtube} YouTube, ${data.watched.bluesky} Bluesky`;
      renderYouTube(data.youtube || {});
    }

    // ---------- step 1: the site's YouTube API key ----------
    const GOOGLE_LINK = /^https:\/\/console\.(cloud|developers)\.google\.com\//;
    function addLink(box, link) {
      if (!link || !GOOGLE_LINK.test(link)) return;
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open Google Cloud';
      box.append(' ', a);
    }

    function renderYouTube(yt) {
      const status = $('yt-status');
      const on = Boolean(yt.using);
      status.className = `notice${on ? (yt.issue ? ' warn' : ' good') : ''}`;
      if (yt.using === 'site') {
        const added = yt.saved.addedAt ? `, added ${when(yt.saved.addedAt)}` : '';
        status.textContent = `A shared key is saved: the one ending in “${yt.saved.last4}”${added}${yt.saved.earlier ? ' (on the earlier version of the site)' : ''}. Channels added without a key of their own use it.`;
      } else if (yt.using === 'vercel') {
        status.textContent = 'A shared key is set in Vercel (YOUTUBE_API_KEY). Channels added without a key of their own use it. Paste a key here to use that one instead.';
      } else {
        status.textContent = 'No shared key, and that’s fine: everyone pastes their own free key when they add their channel. Add one here only if you want people to be able to skip that step.';
      }
      $('ov-yt').textContent = on ? (yt.issue ? 'People’s own keys, and a shared key with a problem (see above)' : 'People’s own keys, and a shared key') : 'People’s own keys (no shared key)';

      const issue = $('yt-issue');
      issue.textContent = '';
      issue.hidden = !yt.issue;
      if (yt.issue) {
        const what = yt.issue.kind === 'quota' ? 'Today’s free YouTube allowance ran out' : 'Google refused the key';
        issue.append(`${what} (${when(yt.issue.at)}): ${yt.issue.message}`);
        addLink(issue, yt.issue.link);
      }

      $('yt-key-label').textContent = yt.using === 'site' ? 'Replace the shared key' : 'Paste a shared YouTube API key';
      $('btn-yt-remove').hidden = yt.using !== 'site';
    }

    $('yt-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('yt-error');
      const inputs = { key: $('yt-key') };
      clearError(err, inputs);
      $('yt-done').hidden = true;
      const key = inputs.key.value.replace(/\s+/g, '');
      if (!key) return showError(err, { field: 'key', message: 'Paste the API key first. The steps below show how to get one.' }, inputs);
      const btn = $('btn-yt-save');
      busy(btn, true, 'Checking with Google…');
      const { status, data } = await post('/api/admin/youtube-key', { action: 'save', key });
      busy(btn, false);
      if (status === 403) return showLogin();
      if (!data.ok) {
        showError(err, data.error, inputs);
        addLink(err, data.error && data.error.link);
        return;
      }
      inputs.key.value = '';
      inputs.key.type = 'password';
      const toggle = document.querySelector('[data-toggle-pw="yt-key"]');
      toggle.textContent = 'Show';
      toggle.setAttribute('aria-pressed', 'false');
      renderYouTube(data.youtube || {});
      done($('yt-done'), data.note
        ? `Saved. ${data.note}`
        : 'Google accepted the key and it’s saved. Channels added without a key of their own now use it, and pages that were waiting update within a minute.');
    });

    $('btn-yt-remove').addEventListener('click', async () => {
      if (!window.confirm('Remove the shared YouTube API key? Pages that use their owner’s own key keep going. Pages that relied on this one stop updating until their owner pastes their own key, or you add a shared key again.')) return;
      const err = $('yt-error');
      clearError(err, { key: $('yt-key') });
      $('yt-done').hidden = true;
      const { status, data } = await post('/api/admin/youtube-key', { action: 'remove' });
      if (status === 403) return showLogin();
      if (!data.ok) return showError(err, data.error);
      renderYouTube(data.youtube || {});
      done($('yt-done'), 'The shared key has been removed.');
    });

    $('admin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('ad-error');
      const inputs = { password: $('ad-password') };
      clearError(err, inputs);
      if (!inputs.password.value) return showError(err, { field: 'password', message: 'Enter the owner password.' }, inputs);
      const btn = $('btn-ad-signin');
      busy(btn, true, 'Signing in…');
      const { data } = await post('/api/admin/login', { password: inputs.password.value });
      busy(btn, false);
      inputs.password.value = '';
      if (!data.ok) return showError(err, data.error, inputs);
      showTools();
    });

    out.addEventListener('click', async () => {
      await post('/api/admin/logout');
      showLogin();
    });

    function renderFound(acc) {
      current = acc.username;
      $('found').hidden = false;
      $('fd-name').textContent = acc.username;
      const link = $('fd-page');
      link.href = acc.page;
      link.textContent = acc.page;
      $('fd-public').textContent = acc.public ? 'Yes' : 'No (private)';
      $('fd-created').textContent = when(acc.createdAt);
      $('fd-signin').textContent = when(acc.signInAt);
      $('fd-yt').textContent = acc.youtubeChannel || 'None';
      $('fd-key').textContent = acc.ownKey ? 'Yes (never shown)' : 'No';
      $('fd-counters').textContent = String(acc.counters);
      $('fd-suspended').textContent = acc.suspended ? `Yes, since ${when(acc.suspended.at)}${acc.suspended.reason ? `: ${acc.suspended.reason}` : ''}` : 'No';
      $('btn-suspend').hidden = Boolean(acc.suspended);
      $('btn-unsuspend').hidden = !acc.suspended;
    }

    function done(box, text) {
      box.textContent = text;
      box.hidden = false;
    }

    async function act(action, extra) {
      const err = $('fd-error');
      err.hidden = true;
      $('fd-done').hidden = true;
      const { status, data } = await post('/api/admin/user', { username: current, action, ...extra });
      if (status === 403) return showLogin();
      if (!data.ok) return showError(err, data.error);
      if (data.deleted) {
        $('found').hidden = true;
        $('find-name').value = '';
        done($('find-done'), `The account ${data.deleted} has been deleted.`);
        overview();
        return;
      }
      renderFound(data.account);
      if (action === 'suspend') done($('fd-done'), 'Suspended. The page is hidden from everyone else.');
      if (action === 'unsuspend') done($('fd-done'), 'Suspension lifted.');
    }

    $('find-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('find-error');
      err.hidden = true;
      $('find-done').hidden = true;
      $('fd-done').hidden = true;
      let raw = $('find-name').value.trim();
      const m = raw.match(/\/u\/([A-Za-z0-9_-]{3,24})/);
      if (m) raw = m[1];
      const name = cleanName(raw);
      if (!NAME_RE.test(name)) return showError(err, { message: 'Enter a username, or paste the page’s address.' });
      current = name;
      const { status, data } = await post('/api/admin/user', { username: name, action: 'find' });
      if (status === 403) return showLogin();
      if (!data.ok) {
        $('found').hidden = true;
        return showError(err, data.error);
      }
      renderFound(data.account);
    });
    $('btn-suspend').addEventListener('click', () => act('suspend', { reason: $('fd-reason').value.trim() }));
    $('btn-unsuspend').addEventListener('click', () => act('unsuspend'));
    $('btn-remove').addEventListener('click', () => {
      if (!window.confirm(`Delete the account “${current}” and its page for good? This can’t be undone.`)) return;
      act('delete');
    });

    if (cfg.moderator) showTools();
    else showLogin();
  }

  // ---------- start ----------
  const pages = { home, signup, signin, forgot, account, admin };
  const start = pages[PAGE];
  if (!start) return;
  const ready = L.site && L.site.ready ? L.site.ready : Promise.resolve({ hosted: true, user: null });
  ready.then((cfg) => start(cfg || {})).catch((e) => console.error(e));
})();

/* The Settings panel: counters for each platform, text, look, effects, sound, streaming and app
   settings. Every control is tied to a setting by its data-k attribute, and changes show on the
   counter straight away (the panel sits beside it rather than over it). */
(function () {
  'use strict';

  const L = window.LVC;
  const A = L.app;
  const $ = (id) => document.getElementById(id);
  const dlg = $('settings');
  const expanded = new Set();
  let tab = 'counters';
  try { tab = localStorage.getItem('lvc.tab') || 'counters'; } catch (e) { /* default */ }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const ICON = {
    play: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l10.5-6.5L8 5.5Z"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/></svg>',
  };
  const iconBtn = (svg, label) => {
    const b = el('button', 'icon-btn small');
    b.type = 'button';
    b.innerHTML = svg; // fixed icon markup above, never user text
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  };
  const familyOf = (f) => (f.system ? f.css : `"${f.name}", sans-serif`);
  const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

  // ---------- generated choices: fonts, tick sounds, chimes, platforms ----------
  const fontGrid = $('font-grid');
  for (const f of L.FONTS) {
    const lab = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = 'text.font';
    input.value = f.name;
    input.dataset.k = 'text.font';
    const box = el('span');
    const sample = el('span', 'sample', '1,234');
    sample.style.fontFamily = familyOf(f);
    sample.style.fontWeight = String(nearest(f.weights, 700));
    box.append(sample, el('span', 'fname', f.name));
    lab.append(input, box);
    fontGrid.appendChild(lab);
  }
  let previewsLoaded = false;
  function loadFontPreviews() {
    if (previewsLoaded) return;
    if (L.site && !L.site.allows('fonts')) return; // website: only after "Fonts from Google" is allowed
    previewsLoaded = true;
    const fams = L.FONTS.filter((f) => !f.system)
      .map((f) => `family=${encodeURIComponent(f.name).replace(/%20/g, '+')}:wght@${nearest(f.weights, 700)}`)
      .join('&');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${fams}&text=${encodeURIComponent('0123456789,')}&display=swap`;
    document.head.appendChild(link);
  }

  function soundGrid(box, choices, key, onPlay) {
    for (const [value, name] of Object.entries(choices)) {
      const row = el('div', 'snd');
      const lab = el('label');
      const input = el('input');
      input.type = 'radio';
      input.name = key;
      input.value = value;
      input.dataset.k = key;
      lab.append(input, el('span', null, name));
      const play = iconBtn(ICON.play, `Play ${name}`);
      play.addEventListener('click', () => onPlay(value));
      row.append(lab, play);
      box.appendChild(row);
    }
  }
  soundGrid($('tick-grid'), L.TICK_SOUNDS, 'sound.type', (type) => A.sound.preview(type));
  soundGrid($('chime-grid'), L.CHIME_SOUNDS, 'sound.chimeType', (type) => A.sound.previewChime(type, 2));

  const platformBox = $('add-platforms');
  for (const [key, p] of Object.entries(L.PLATFORMS)) {
    const lab = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = 'add-platform';
    input.value = key;
    const chip = el('span');
    chip.style.setProperty('--pc', p.color);
    chip.append(el('i', 'pdot'), document.createTextNode(p.name));
    lab.append(input, chip);
    platformBox.appendChild(lab);
  }

  // ---------- website version: fewer platforms, no uploads, no API keys ----------
  let modeApplied = false;
  function applyMode() {
    if (modeApplied) return;
    modeApplied = true;
    if (!A.hosted) return;
    const allowed = (A.config && A.config.platforms) || ['youtube', 'bluesky'];
    for (const input of platformBox.querySelectorAll('input')) input.closest('label').hidden = !allowed.includes(input.value);
    if (!allowed.includes(addPlatform)) setAddPlatform(allowed.find((p) => p !== 'youtube') || allowed[0]);
    $('set-key-env').hidden = true; // (the website: everyone can paste their own key)
    // No uploaded sounds on the website.
    const custom = $('tick-grid').querySelector('input[value="custom"]');
    if (custom) custom.closest('.snd').hidden = true;
  }
  if (L.site) L.site.onChange(() => { if (dlg.open && tab === 'text') loadFontPreviews(); });

  // ---------- open, close, tabs ----------
  function open(which) {
    applyMode();
    if (which) tab = which;
    selectTab(tab);
    if (!dlg.open) dlg.show();
    document.body.classList.add('drawer-open');
    document.body.classList.remove('idle');
    syncInputs();
    renderCounterList();
    renderOverlay();
    renderFacts();
    loadAutostart();
    loadConfig();
    A.refitSoon();
  }
  function close() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    document.body.classList.remove('drawer-open');
    A.refitSoon();
  });
  $('btn-close-settings').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dlg.open) {
      e.preventDefault();
      close();
    }
  });

  const tabs = [...dlg.querySelectorAll('[data-tab]')];
  function selectTab(name) {
    if (!tabs.some((b) => b.dataset.tab === name)) name = 'counters';
    tab = name;
    for (const b of tabs) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of dlg.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
    try { localStorage.setItem('lvc.tab', name); } catch (e) { /* fine */ }
    if (name === 'text') loadFontPreviews();
    if (name === 'app') { renderFacts(); loadConfig(); }
    dlg.querySelector('.panels').scrollTop = 0;
  }
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => selectTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      selectTab(next.dataset.tab);
      next.focus();
    });
  });

  // ---------- controls tied to settings ----------
  const bound = [...dlg.querySelectorAll('[data-k]')];
  const read = (input) => {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'range' || input.hasAttribute('data-num')) return Number(input.value);
    return input.value;
  };
  for (const input of bound) {
    const evt = input.type === 'range' || input.type === 'color' || input.type === 'text' ? 'input' : 'change';
    input.addEventListener(evt, () => {
      if (input.type === 'radio' && !input.checked) return;
      A.update(input.dataset.k, read(input));
      syncDynamic();
    });
  }

  const WEIGHTS = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
  function outText(key, v) {
    if (key === 'text.weight') {
      const f = L.FONTS.find((x) => x.name === A.S.text.font) || L.FONTS[0];
      const w = nearest(f.weights, v);
      return f.weights.length === 1 ? 'Only one' : WEIGHTS[w] || String(w);
    }
    if (key === 'text.spacing') return v === 0 ? 'Normal' : `${v > 0 ? '+' : ''}${v}`;
    return String(v);
  }

  function syncInputs() {
    const S = A.S;
    for (const input of bound) {
      let v = A.getPath(S, input.dataset.k);
      if (input.dataset.k === 'look.bgImage' && String(v).startsWith('upload:')) v = '';
      if (input.type === 'checkbox') input.checked = !!v;
      else if (input.type === 'radio') input.checked = String(v) === input.value;
      else if (document.activeElement !== input) input.value = v == null ? '' : String(v);
    }
    $('sound-on').checked = A.sound.on;
    $('sound-file-name').textContent = S.sound.customName ? `Using “${S.sound.customName}”` : 'No file chosen yet';
    syncDynamic();
  }

  function syncDynamic() {
    const S = A.S;
    for (const o of dlg.querySelectorAll('output[data-out]')) {
      o.textContent = outText(o.dataset.out, A.getPath(S, o.dataset.out)) + (o.dataset.out === 'text.weight' || o.dataset.out === 'text.spacing' ? '' : o.dataset.suffix || '');
    }
    for (const node of dlg.querySelectorAll('[data-when]')) {
      const [k, vals] = node.dataset.when.split('=');
      node.hidden = !vals.split(',').includes(String(A.getPath(S, k)));
    }
  }

  // ---------- counters ----------
  const rows = new Map(); // id -> elements to refresh with live values

  function counterInfo(c) {
    const snap = A.snap || {};
    const p = L.PLATFORMS[c.platform] || { name: c.platform };
    const m = L.METRICS[c.metric] || { label: c.metric };
    const out = { name: c.handle || p.name, avatar: '', status: 'starting', value: null, error: '', sub: `${p.name} · ${m.label}` };
    if (c.platform === 'youtube') {
      const ch = snap.channel;
      if (snap.status === 'setup') {
        out.status = 'error';
        out.error = !A.hosted
          ? 'YouTube isn’t connected yet (see the App tab).'
          : 'Not connected yet. Add your channel under the Channel tab.';
        out.name = 'YouTube';
      } else if (ch) {
        out.name = ch.title;
        out.avatar = ch.thumb;
        out.status = snap.status;
        out.value = c.metric === 'views' ? snap.total : c.metric === 'subs' ? ch.subs : ch.videoCount;
        if (snap.status !== 'live' && snap.error) out.error = snap.error.message || '';
      }
    } else {
      const src = snap.sources && snap.sources[`${c.platform}:${String(c.handle).toLowerCase()}`];
      if (src) {
        out.name = src.name;
        out.avatar = src.avatar;
        out.status = src.status;
        const mm = src.metrics && src.metrics[c.metric];
        out.value = mm ? mm.value : null;
        out.error = src.error ? src.error.message : '';
      }
    }
    const card = A.cards.get(c.id);
    if (card && card.lastInt != null) out.value = card.lastInt;
    return out;
  }

  function editCounter(id, patch) {
    const list = A.S.counters.map((c) => (c.id === id ? { ...c, ...patch } : c));
    for (const c of list) {
      if (c.label === '') delete c.label;
      if (!c.goal) delete c.goal;
      if (!c.hidden) delete c.hidden;
    }
    A.setCounters(list);
  }

  function renderCounterList() {
    const list = $('counter-list');
    list.textContent = '';
    rows.clear();
    const counters = A.S.counters;
    if (!counters.length) {
      list.appendChild(el('li', 'ci-empty', 'No counters yet. Add one below.'));
      return;
    }
    counters.forEach((c, i) => {
      const info = counterInfo(c);
      const li = el('li', `ci${c.hidden ? ' is-hidden' : ''}`);
      const head = el('div', 'ci-head');
      const img = el('img', 'ci-avatar');
      img.alt = '';
      if (info.avatar) img.src = info.avatar;
      const text = el('div', 'ci-text');
      const name = el('div', 'ci-name', info.name);
      const sub = el('div', 'ci-sub');
      const dot = el('i', `ci-dot ${info.status}`);
      const subText = el('span', null, info.sub);
      const val = el('span', 'ci-val', info.value != null ? ` · ${A.fmt(info.value)}` : '');
      sub.append(dot, subText, val);
      text.append(name, sub);
      const err = el('div', 'ci-err', info.error);
      err.hidden = !info.error;
      text.appendChild(err);
      const up = iconBtn(ICON.up, 'Move up');
      const down = iconBtn(ICON.down, 'Move down');
      up.disabled = i === 0;
      down.disabled = i === counters.length - 1;
      const edit = iconBtn(ICON.edit, 'Edit');
      edit.setAttribute('aria-expanded', String(expanded.has(c.id)));
      head.append(img, text, up, down, edit);
      li.appendChild(head);
      rows.set(c.id, { img, name, dot, val, err });

      const move = (d) => {
        const next = counters.slice();
        const [it] = next.splice(i, 1);
        next.splice(i + d, 0, it);
        A.setCounters(next);
        renderCounterList();
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      edit.addEventListener('click', () => {
        if (expanded.has(c.id)) expanded.delete(c.id);
        else expanded.add(c.id);
        renderCounterList();
      });

      if (expanded.has(c.id)) {
        const body = el('div', 'ci-body');
        const m = L.METRICS[c.metric];
        const p = L.PLATFORMS[c.platform];

        const labelField = el('label', 'field');
        labelField.appendChild(el('span', 'field-label', 'Label under the number'));
        const label = el('input');
        label.type = 'text';
        label.maxLength = 80;
        label.value = c.label || '';
        label.placeholder = c.platform === 'youtube' ? m.label : `${m.label} on ${p.name}`;
        label.addEventListener('input', () => editCounter(c.id, { label: label.value }));
        labelField.appendChild(label);

        const metricField = el('label', 'field');
        metricField.appendChild(el('span', 'field-label', 'Number to show'));
        const metric = el('select');
        for (const key of p.metrics) {
          const o = el('option', null, L.METRICS[key].name);
          o.value = key;
          metric.appendChild(o);
        }
        metric.value = c.metric;
        metric.addEventListener('change', () => {
          if (A.S.counters.some((x) => x.id !== c.id && x.platform === c.platform && x.handle === c.handle && x.metric === metric.value)) {
            metric.value = c.metric;
            return;
          }
          editCounter(c.id, { metric: metric.value });
          renderCounterList();
        });
        metricField.appendChild(metric);

        const goalField = el('label', 'field');
        goalField.appendChild(el('span', 'field-label', 'Goal'));
        const goal = el('input');
        goal.type = 'text';
        goal.inputMode = 'numeric';
        goal.placeholder = 'For example 1,000,000';
        goal.value = c.goal ? A.fmt(c.goal) : '';
        goal.addEventListener('input', () => {
          const n = Number(goal.value.replace(/[^\d]/g, ''));
          editCounter(c.id, { goal: n > 0 ? n : 0 });
        });
        goal.addEventListener('blur', () => { const n = Number(goal.value.replace(/[^\d]/g, '')); goal.value = n > 0 ? A.fmt(n) : ''; });
        goalField.appendChild(goal);
        goalField.appendChild(el('span', 'field-hint', 'Shows a progress bar and celebrates when it’s reached.'));

        const vis = el('label', 'check');
        const visBox = el('input');
        visBox.type = 'checkbox';
        visBox.checked = !c.hidden;
        visBox.addEventListener('change', () => { editCounter(c.id, { hidden: !visBox.checked }); renderCounterList(); });
        vis.append(visBox, el('span', null, 'Show on screen'));

        const actions = el('div', 'row');
        const showBtn = el('button', 'ghost small', 'Show it now');
        showBtn.type = 'button';
        showBtn.addEventListener('click', () => A.showCounter(c.id));
        const remove = el('button', 'ghost small danger', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (!window.confirm(`Remove the ${info.name} ${m.label.toLowerCase()} counter?`)) return;
          expanded.delete(c.id);
          A.setCounters(A.S.counters.filter((x) => x.id !== c.id));
          renderCounterList();
          renderOverlay();
        });
        actions.append(showBtn, remove);

        body.append(labelField, metricField, goalField, vis, actions);
        li.appendChild(body);
      }
      list.appendChild(li);
    });
  }

  function refreshRows() {
    for (const c of A.S.counters) {
      const r = rows.get(c.id);
      if (!r) continue;
      const info = counterInfo(c);
      if (r.name.textContent !== info.name) r.name.textContent = info.name;
      if (info.avatar && r.img.getAttribute('src') !== info.avatar) r.img.src = info.avatar;
      r.dot.className = `ci-dot ${info.status}`;
      r.val.textContent = info.value != null ? ` · ${A.fmt(info.value)}` : '';
      r.err.textContent = info.error;
      r.err.hidden = !info.error;
    }
  }

  // Adding a counter
  let addPlatform = 'tiktok';
  function setAddPlatform(p) {
    addPlatform = p;
    const meta = L.PLATFORMS[p];
    for (const r of platformBox.querySelectorAll('input')) r.checked = r.value === p;
    $('add-handle-field').hidden = p === 'youtube' || p === 'instagram';
    $('add-token-field').hidden = p !== 'instagram';
    $('add-yt-note').hidden = p !== 'youtube';
    $('add-handle').placeholder = meta.placeholder || '';
    const sel = $('add-metric');
    sel.textContent = '';
    for (const key of meta.metrics) {
      const o = el('option', null, L.METRICS[key].name);
      o.value = key;
      sel.appendChild(o);
    }
    $('add-error').hidden = true;
  }
  platformBox.addEventListener('change', (e) => { if (e.target.name === 'add-platform') setAddPlatform(e.target.value); });
  setAddPlatform('tiktok');

  function newId(base) {
    const clean = base.toLowerCase().replace(/[^\w-]/g, '').slice(0, 34) || 'counter';
    let id = clean;
    let n = 2;
    while (A.S.counters.some((c) => c.id === id)) id = `${clean}-${n++}`;
    return id;
  }

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('add-error');
    errBox.hidden = true;
    const metric = $('add-metric').value;
    const btn = $('btn-add');
    let counter;
    if (addPlatform === 'youtube') {
      if (A.S.counters.some((c) => c.platform === 'youtube' && c.metric === metric)) {
        return A.showError(errBox, { message: 'That YouTube counter is already on the list.' });
      }
      if (!A.snap || A.snap.status === 'setup') {
        return A.showError(errBox, { message: A.hosted ? 'Connect your YouTube channel under the Channel tab first.' : 'Connect your YouTube channel under the App tab first.' });
      }
      counter = { id: newId(`yt-${metric}`), platform: 'youtube', metric };
    } else {
      const inputs = { handle: $('add-handle'), token: $('add-token') };
      const body = { platform: addPlatform, handle: inputs.handle.value.trim(), token: inputs.token.value.trim() };
      if (addPlatform !== 'instagram' && !body.handle) return A.showError(errBox, { field: 'handle', message: 'Enter the account name or paste its link.' }, inputs);
      btn.disabled = true;
      btn.textContent = `Looking it up on ${L.PLATFORMS[addPlatform].name}…`;
      const res = await A.postJson(A.api('accounts/check'), body);
      btn.disabled = false;
      btn.textContent = 'Add counter';
      if (!res.ok) return A.showError(errBox, res.error || {}, inputs);
      const acc = res.account;
      if (A.S.counters.some((c) => c.platform === acc.platform && String(c.handle).toLowerCase() === String(acc.handle).toLowerCase() && c.metric === metric)) {
        return A.showError(errBox, { message: 'That counter is already on the list.' });
      }
      counter = { id: newId(`${acc.platform}-${acc.handle}-${metric}`), platform: acc.platform, handle: acc.handle, metric };
      inputs.handle.value = '';
      inputs.token.value = '';
      for (const i of Object.values(inputs)) i.classList.remove('invalid');
    }
    A.setCounters([...A.S.counters, counter]);
    renderCounterList();
    renderOverlay();
    A.showCounter(counter.id);
  });

  // ---------- uploads (background picture, own sound) ----------
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  const AUDIO_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
  const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
  // Biggest files allowed. The website's are smaller: Vercel accepts at most 4.5 MB per request.
  const maxUpload = (kind) => (kind === 'sound' ? (A.hosted ? 2_000_000 : 2_100_000) : (A.hosted ? 3_000_000 : 8_000_000));
  async function upload(kind, file, errBox) {
    errBox.hidden = true;
    if (file.size > maxUpload(kind)) {
      A.showError(errBox, { message: kind === 'sound' ? 'That file is too big. Use a short sound under 2 MB.' : `That picture is too big. Use one under ${A.hosted ? 3 : 8} MB.` });
      return null;
    }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const type = file.type || (kind === 'sound' ? AUDIO_EXT[ext] : IMAGE_EXT[ext]) || '';
    const data = await readFile(file);
    const res = await A.postJson(`/api/files/${kind}`, { type, name: file.name, data });
    if (!res.ok) {
      A.showError(errBox, res.error || {});
      return null;
    }
    return res;
  }

  $('sound-file').addEventListener('change', async () => {
    const file = $('sound-file').files[0];
    $('sound-file').value = '';
    if (!file) return;
    const res = await upload('sound', file, $('sound-upload-error'));
    if (!res) return;
    A.update('sound.customName', res.name);
    A.update('sound.customAt', res.at);
    A.update('sound.type', 'custom');
    A.sound.reloadCustom();
    syncInputs();
    setTimeout(() => A.sound.preview('custom'), 400);
  });

  $('bg-file').addEventListener('change', async () => {
    const file = $('bg-file').files[0];
    $('bg-file').value = '';
    if (!file) return;
    const res = await upload('background', file, $('bg-upload-error'));
    if (!res) return;
    A.update('look.bgImage', `upload:${res.at}`);
    A.update('look.bg', 'image');
    syncInputs();
  });
  $('btn-bg-remove').addEventListener('click', async () => {
    if (String(A.S.look.bgImage).startsWith('upload:')) await A.postJson('/api/files/background', { remove: true });
    A.update('look.bgImage', '');
    syncInputs();
  });

  // ---------- sound on this device, and trying milestones ----------
  $('sound-on').addEventListener('change', () => A.sound.setOn($('sound-on').checked));
  for (const b of dlg.querySelectorAll('[data-try]')) {
    b.addEventListener('click', () => {
      const card = A.focusCard();
      if (!card || card.lastInt == null) return;
      A.sound.unlock();
      const what = b.dataset.try;
      if (what === 'goal') {
        const g = Number(card.cfg.goal) || Math.ceil((card.lastInt + 1) / 1000) * 1000;
        card.binding.goal(g);
      } else {
        const level = Number(what);
        card.binding.celebrate(level, Math.max(level, Math.ceil(card.lastInt / level) * level));
      }
    });
  }

  // ---------- stream ----------
  function renderOverlay() {
    const sel = $('ov-counter');
    const cur = sel.value;
    sel.textContent = '';
    const all = el('option', null, 'All counters, laid out like here');
    all.value = '';
    sel.appendChild(all);
    for (const c of A.S.counters) {
      const info = counterInfo(c);
      const m = L.METRICS[c.metric];
      const o = el('option', null, `${info.name} · ${(L.PLATFORMS[c.platform] || {}).name || ''} ${m ? m.label.toLowerCase() : ''}`);
      o.value = c.id;
      sel.appendChild(o);
    }
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
    updateOverlayUrl();
  }
  function updateOverlayUrl() {
    let url = A.hosted ? `${location.origin}/u/${A.page}?overlay` : `${location.origin}/?overlay`;
    if ($('ov-counter').value) url += `&counter=${encodeURIComponent($('ov-counter').value)}`;
    if ($('ov-style').value) url += `&style=${$('ov-style').value}`;
    if (!$('ov-transparent').checked) url += '&bg=show';
    if ($('ov-sound').checked) url += '&sound';
    $('overlay-url').textContent = url;
  }
  for (const id of ['ov-counter', 'ov-style', 'ov-transparent', 'ov-sound']) $(id).addEventListener('change', updateOverlayUrl);
  $('btn-copy').addEventListener('click', async () => {
    const text = $('overlay-url').textContent;
    try {
      await navigator.clipboard.writeText(text);
      $('btn-copy').textContent = 'Copied';
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents($('overlay-url'));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      $('btn-copy').textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { $('btn-copy').textContent = 'Copy'; }, 1800);
  });

  // ---------- app: YouTube connection, details, background, backup ----------
  let keyNeeded = false; // website: no saved key of their own, and no site key to fall back on
  async function loadConfig() {
    const c = await A.getConfig();
    if (document.activeElement !== $('set-channel')) {
      const snap = A.snap || {};
      $('set-channel').value = c.channelInput || (snap.channel && (snap.channel.handle || snap.channel.id)) || '';
    }
    $('set-key').placeholder = c.keyHint ? `Saved key ${c.keyHint}` : 'Paste your API key';
    if (A.hosted) {
      // Everyone can paste their own free key; it's optional when they saved one or the site has one.
      keyNeeded = !c.keyHint && !c.ytAvailable;
      $('set-key-label').textContent = c.keyHint ? 'Your API key (saved)' : keyNeeded ? 'Your API key' : 'Your API key (optional)';
      $('set-key-hint').textContent = c.keyHint
        ? 'Leave this empty to keep using your saved key, or paste a new one to replace it. It’s never shown on any page.'
        : keyNeeded
          ? 'Free from Google (steps below). It’s kept with your account, never shown on any page, and only used to read your channel’s public numbers.'
          : 'Leave this empty to use this site’s key, or paste your own free key (steps below). It’s never shown on any page.';
      if (keyNeeded && !c.configured) $('set-key-guide').open = true;
    }
    $('btn-disconnect').hidden = !c.configured && !c.keyHint;
    if (A.hosted && c.user) {
      const pub = Boolean(c.user.public);
      $('page-visibility').textContent = pub
        ? `Your page is public: anyone with the address ${location.origin}${c.user.page} can see it.`
        : 'Your page is private: only you can see it, while signed in. You can make it public on your account page.';
      $('ov-private').hidden = pub;
    }
  }

  function renderFacts() {
    if (A.hosted) return; // these details are about the local app's live tracking
    const s = A.snap || {};
    const num = (n) => (n == null ? '–' : A.fmt(Math.round(n)));
    $('f-total').textContent = num(s.total);
    $('f-official').textContent = num(s.official);
    $('f-rate').textContent = A.rateText(s.rate, 'views');
    $('f-videos').textContent = s.videos ? A.fmt(s.videos.tracked) : '–';
    $('f-tick').textContent = s.tickMs
      ? `every ${Math.max(1, Math.round(s.tickMs / 1000))}s${s.checkedAt ? ` · last ${A.ago(s.checkedAt)}` : ''}`
      : '–';
    const span = s.lastDay ? s.lastDay.spanMs : 0;
    const tracked = span >= 86_000_000 ? '' : span >= 3_600_000 ? ` (${Math.round(span / 3_600_000)} h tracked)` : ` (${Math.max(1, Math.round(span / 60_000))} min tracked)`;
    $('f-day').textContent = s.lastDay ? `+${A.fmt(s.lastDay.views)}${tracked}` : '–';
    if (s.quota) {
      const pct = (u) => Math.round((u / s.quota.limit) * 100);
      $('f-quota').textContent = s.quota.mode === 'batch'
        ? `${pct(s.quota.main)}% + ${pct(s.quota.stats)}% (resets ${A.until(s.quota.resetAt)})`
        : `${pct(s.quota.main)}% (resets ${A.until(s.quota.resetAt)})`;
    } else {
      $('f-quota').textContent = '–';
    }
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputs = { channel: $('set-channel'), apiKey: $('set-key') };
    const body = { channel: inputs.channel.value.trim() };
    const key = A.hosted ? inputs.apiKey.value.replace(/\s+/g, '') : inputs.apiKey.value.trim();
    if (key) body.apiKey = key;
    if (A.hosted && !body.channel) return A.showError($('settings-error'), { field: 'channel', message: 'Enter your channel’s @handle or a link to it.' }, inputs);
    if (A.hosted && keyNeeded && !key) {
      $('set-key-guide').open = true;
      return A.showError($('settings-error'), { field: 'apiKey', message: 'Paste your YouTube Data API key. It’s free from Google, and the steps below show how to get one.' }, inputs);
    }
    const btn = $('btn-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const res = await A.postJson(A.api('connect'), body);
    btn.disabled = false;
    btn.textContent = 'Save';
    if (!res.ok) return A.showError($('settings-error'), res.error || {}, inputs);
    $('settings-error').hidden = true;
    inputs.apiKey.value = '';
    if (res.state) A.applySnapshot(res.state);
    if (!A.S.counters.some((c) => c.platform === 'youtube')) {
      A.setCounters([{ id: newId('yt-views'), platform: 'youtube', metric: 'views' }, ...A.S.counters]);
      renderCounterList();
    }
    loadConfig();
  });

  $('btn-disconnect').addEventListener('click', async () => {
    const where = A.hosted ? 'your channel from your page, and deletes your saved API key' : 'the saved API key from this computer';
    if (!window.confirm(`Disconnect YouTube? This removes ${where}. Your other counters keep going, and you can connect again any time.`)) return;
    const res = await A.postJson(A.api('disconnect'));
    if (!res.ok) return A.showError($('settings-error'), res.error || {}, {});
    if (res.state) A.applySnapshot(res.state);
    loadConfig();
  });

  $('btn-signout').addEventListener('click', () => { if (L.site) L.site.signOut(); });

  async function loadAutostart() {
    if (A.hosted) return;
    try {
      const r = await fetch('/api/autostart', { cache: 'no-store' });
      const a = await r.json();
      $('autostart-row').hidden = !a.supported;
      $('set-autostart').checked = Boolean(a.enabled);
    } catch (e) {
      $('autostart-row').hidden = true;
    }
  }
  $('set-autostart').addEventListener('change', async () => {
    const box = $('set-autostart');
    box.disabled = true;
    const res = await A.postJson('/api/autostart', { enabled: box.checked });
    box.disabled = false;
    if (typeof res.enabled === 'boolean') box.checked = res.enabled;
    if (!res.ok) A.showError($('bg-error'), res.error || {}, {});
    else $('bg-error').hidden = true;
  });
  $('btn-stop').addEventListener('click', async () => {
    if (!window.confirm('Stop the counter? It stops checking until you start it again from the desktop icon (or the next time you sign in to Windows, if that’s turned on).')) return;
    const res = await A.postJson('/api/shutdown');
    if (!res.ok) return A.showError($('bg-error'), res.error || {}, {});
    close();
    A.markStopped();
  });

  function backupMsg(text) {
    const m = $('backup-msg');
    m.textContent = text;
    m.hidden = !text;
  }
  $('btn-export').addEventListener('click', () => {
    const data = { app: 'live-view-counter', version: 1, savedAt: new Date().toISOString(), settings: A.user };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'live-view-counter-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    backupMsg('Saved as live-view-counter-settings.json in your downloads.');
  });
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    $('import-file').value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const next = data && typeof data.settings === 'object' ? data.settings : data;
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('bad');
      A.replaceAll(next);
      syncInputs();
      renderCounterList();
      renderOverlay();
      backupMsg('Settings loaded.');
    } catch (e) {
      backupMsg('That file isn’t a Live View Counter settings file.');
    }
  });
  $('btn-reset').addEventListener('click', () => {
    if (!window.confirm('Put the text, look, effects and sound back to how they started? Your counters stay.')) return;
    const keep = {};
    if (A.user.counters) keep.counters = A.user.counters;
    if (A.user.layout) keep.layout = A.user.layout;
    A.replaceAll(keep);
    syncInputs();
    backupMsg('The look is back to how it started.');
  });

  // ---------- staying in step with the counter ----------
  A.onSettings(() => {
    if (!dlg.open) return;
    syncInputs();
    renderCounterList();
    renderOverlay();
  });
  A.onSnapshot(() => {
    if (!dlg.open) return;
    refreshRows();
    if (tab === 'app') renderFacts();
  });
  setInterval(() => { if (dlg.open && tab === 'app') renderFacts(); }, 1000);

  L.settingsUI = { open, close, isOpen: () => dlg.open };
})();

/* Effects around the counters: a glow behind the number that breathes with every view, "+1"s that
   float up off the last digit, sparks when a hundred or a thousand rolls over, confetti for every
   10,000, and a celebration when a goal is reached. Colours come from each account's logo (or the
   accent colour chosen in Settings). One shared canvas draws the particles for every counter. */
(function () {
  'use strict';

  const DEFAULT_ACCENT = [96, 140, 255];
  const LEVELS = { normal: [1e6, 1e5, 1e4, 1e3, 100], big: [1e6, 1e5, 1e4], off: [] };

  // ---------- colour helpers ----------
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (t) => {
      t = (t + 1) % 1;
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((x) => Math.round(x * 255));
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // The logo's strongest colour, made bright enough to glow on black. null if the logo is grey.
  function logoColour(img) {
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 40, 40);
    const d = g.getImageData(0, 0, 40, 40).data;
    const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      if (s < 0.25 || l < 0.12 || l > 0.92) continue;
      const w = s * s * (1 - Math.abs(l - 0.5));
      const bin = bins[Math.floor(h / 15) % 24];
      bin.w += w; bin.r += d[i] * w; bin.g += d[i + 1] * w; bin.b += d[i + 2] * w;
    }
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w < 8) return null;
    const [h, s] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
    return { h, s: Math.min(0.95, Math.max(0.62, s)) };
  }

  // Accent pair + particle palette from a hue/saturation (or from an exact colour the user picked).
  function makeAccent(hs, exact) {
    let h, s, a;
    if (exact) {
      [h, s] = rgbToHsl(...exact);
      s = Math.max(0.5, s);
      a = exact;
    } else {
      h = hs ? hs.h : rgbToHsl(...DEFAULT_ACCENT)[0];
      s = hs ? hs.s : 0.9;
      a = hslToRgb(h, s, 0.62);
    }
    const b = hslToRgb(h + 38, s, 0.64);
    return {
      a, b,
      palette: [`rgb(${a})`, `rgb(${b})`, '#ffffff', '#ffd166', '#ff6b9a', '#7bd88f', `rgb(${hslToRgb(h + 180, 0.8, 0.66)})`],
    };
  }

  // Reads the dominant colour of an image URL (same-origin or CORS-enabled). Calls back with {h, s} or null.
  const logoCache = new Map();
  function readLogo(url, done) {
    if (!url) return done(null);
    if (logoCache.has(url)) return done(logoCache.get(url));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      let hs = null;
      try { hs = logoColour(img); } catch (e) { /* can't be read */ }
      logoCache.set(url, hs);
      done(hs);
    };
    img.onerror = () => done(null);
    img.src = url;
  }

  function createFX({ canvas, floaters, toast, chime }) {
    const opts = { glow: true, floaters: true, sparks: true, confetti: true, milestones: 'normal', toast: true };
    let enabled = true;
    let toastTimer = 0;
    const parts = [];
    const ctx = canvas.getContext('2d');
    let dpr = 1;
    let raf = 0;
    let last = 0;
    const fmt = () => window.LVC && window.LVC.format ? window.LVC.format : (n) => new Intl.NumberFormat().format(n);

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    const live = () => enabled && !document.hidden;

    // One counter on screen. card: { number, halo, renderer(), unit(), accent() -> {palette} , visible() }
    function bind(card) {
      let pending = 0;
      let pendingTimer = 0;
      let lastBurstAt = 0;

      function tick(prev, next) {
        if (!live() || !card.visible() || !(next > prev)) return;
        if (opts.glow) pulse();
        if (opts.floaters) {
          pending += next - prev;
          if (!pendingTimer) pendingTimer = setTimeout(floatUp, 80);
        }
        milestone(prev, next);
      }

      function pulse() {
        if (!card.halo.animate) return;
        card.halo.animate(
          [{ opacity: 0.5, transform: 'scale(1)' }, { opacity: 0.85, transform: 'scale(1.035)', offset: 0.2 }, { opacity: 0.5, transform: 'scale(1)' }],
          { duration: 700, easing: 'ease-out' },
        );
      }

      function floatUp() {
        pendingTimer = 0;
        const n = pending;
        pending = 0;
        if (!n || !live()) return;
        const ones = card.renderer().columns()[0];
        if (!ones) return;
        while (floaters.childElementCount > 16) floaters.firstChild.remove();
        const r = ones.getBoundingClientRect();
        if (!r.width) return;
        const fs = parseFloat(card.number.style.fontSize) || 100;
        const el = document.createElement('span');
        el.className = 'floater';
        el.textContent = `+${fmt()(n)}`;
        el.style.fontSize = `${Math.max(14, fs * 0.19).toFixed(1)}px`;
        el.style.left = `${(r.left + r.width / 2 + (Math.random() - 0.5) * r.width * 1.4).toFixed(1)}px`;
        el.style.top = `${(r.top - fs * 0.05).toFixed(1)}px`;
        const acc = card.accent();
        el.style.setProperty('--accent', acc.a.join(' '));
        floaters.appendChild(el);
        const drift = (Math.random() - 0.5) * fs * 0.3;
        const rise = fs * (0.62 + Math.random() * 0.2);
        el.animate(
          [
            { transform: 'translate(-50%, 0) scale(0.55)', opacity: 0 },
            { transform: `translate(calc(-50% + ${(drift * 0.25).toFixed(1)}px), ${(-rise * 0.22).toFixed(1)}px) scale(1)`, opacity: 1, offset: 0.16 },
            { transform: `translate(calc(-50% + ${drift.toFixed(1)}px), ${(-rise).toFixed(1)}px) scale(0.9)`, opacity: 0 },
          ],
          { duration: 1600, easing: 'cubic-bezier(.15,.7,.3,1)' },
        ).onfinish = () => el.remove();
      }

      function milestone(prev, next) {
        const level = (LEVELS[opts.milestones] || []).find((L) => Math.floor(next / L) > Math.floor(prev / L));
        if (!level) return;
        const now = performance.now();
        if (level < 1e4 && now - lastBurstAt < 1200) return; // a fast catch-up shouldn't fire a burst every frame
        lastBurstAt = now;
        celebrate(level, Math.floor(next / level) * level);
      }

      function where(level) {
        const cols = card.renderer().columns();
        const place = Math.min(Math.round(Math.log10(level)), cols.length - 1);
        const col = cols[place] || card.number;
        const r = col.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }

      function celebrate(level, value) {
        if (!live() || !card.visible()) return;
        const [x, y] = where(level);
        const pal = card.accent().palette;
        if (level === 100) {
          if (opts.sparks) sparks(x, y, 22, 0.85, pal);
          return;
        }
        const r = card.renderer();
        if (r.wave) r.wave();
        if (level === 1e3) {
          if (opts.sparks) sparks(x, y, 56, 1.2, pal);
          chime(1);
          return;
        }
        if (opts.sparks) sparks(x, y, 90, 1.5, pal);
        if (opts.confetti) confetti(level >= 1e6 ? 340 : level >= 1e5 ? 240 : 150, x, y, pal);
        chime(level >= 1e5 ? 3 : 2);
        if (opts.toast) showToast(`${fmt()(value)} ${card.unit()}`, card.accent());
      }

      function goal(value) {
        if (!live() || !card.visible()) return;
        const r = card.number.getBoundingClientRect();
        const pal = card.accent().palette;
        const rr = card.renderer();
        if (rr.wave) rr.wave();
        sparks(r.left + r.width / 2, r.top + r.height / 2, 120, 1.7, pal);
        confetti(360, r.left + r.width / 2, r.top + r.height / 2, pal);
        chime(3);
        showToast(`Goal reached: ${fmt()(value)} ${card.unit()}`, card.accent());
      }

      return { tick, celebrate, goal };
    }

    function showToast(text, acc) {
      toast.textContent = '';
      if (acc) toast.style.setProperty('--accent', acc.a.join(' '));
      const star = document.createElement('span');
      star.className = 'toast-star';
      star.textContent = '✦';
      toast.append(star, document.createTextNode(text));
      toast.hidden = false;
      toast.classList.remove('show');
      void toast.offsetWidth;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastTimer = setTimeout(() => { toast.hidden = true; }, 700);
      }, 4500);
    }

    // ---------- particles ----------
    function sparks(x, y, n, power, pal) {
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = (140 + Math.random() * 420) * power;
        parts.push({
          kind: 0, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 160 * power,
          life: 0, max: 0.5 + Math.random() * 0.7, size: 1.3 + Math.random() * 2.4,
          color: Math.random() < 0.55 ? pal[0] : Math.random() < 0.5 ? pal[2] : pal[1],
        });
      }
      run();
    }

    function confetti(n, x, y, pal) {
      const W = window.innerWidth;
      for (let i = 0; i < n; i++) {
        const burst = i % 5 < 2; // some shoot up out of the number, the rest rain down from the top
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
        const sp = 520 + Math.random() * 520;
        parts.push({
          kind: 1,
          x: burst ? x + (Math.random() - 0.5) * 60 : Math.random() * W,
          y: burst ? y : -20 - Math.random() * window.innerHeight * 0.5,
          vx: burst ? Math.cos(ang) * sp : (Math.random() - 0.5) * 140,
          vy: burst ? Math.sin(ang) * sp : 90 + Math.random() * 180,
          rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 14, wob: Math.random() * 6.3,
          w: 7 + Math.random() * 7, h: 4 + Math.random() * 5,
          color: pal[i % pal.length], life: 0, max: 4 + Math.random() * 2.5,
        });
      }
      run();
    }

    function run() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const W = window.innerWidth;
      const H = window.innerHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        if (p.life >= p.max || p.y > H + 40) parts.splice(i, 1);
      }
      ctx.globalCompositeOperation = 'source-over';
      for (const p of parts) {
        if (p.kind !== 1) continue;
        p.vy = Math.min(p.vy + 520 * dt, 240);
        p.vx *= Math.pow(0.35, dt);
        p.wob += dt * 5;
        p.rot += p.vr * dt;
        p.x += (p.vx + Math.sin(p.wob) * 40) * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = Math.min(1, (p.max - p.life) / 0.8);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.wob * 1.3));
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const p of parts) {
        if (p.kind !== 0) continue;
        const drag = Math.pow(0.12, dt);
        p.vx *= drag;
        p.vy = p.vy * drag + 700 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const k = 1 - p.life / p.max;
        ctx.globalAlpha = k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * (0.6 + 0.4 * k);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      raf = parts.length ? requestAnimationFrame(frame) : 0;
      if (!raf) ctx.clearRect(0, 0, W, H);
    }

    function clear() {
      parts.length = 0;
      floaters.textContent = '';
      toast.hidden = true;
    }

    return {
      bind,
      options: opts,
      set enabled(v) {
        enabled = !!v;
        if (!enabled) clear();
      },
      get enabled() { return enabled; },
      clear,
    };
  }

  window.LVC = window.LVC || {};
  window.LVC.createFX = createFX;
  window.LVC.readLogo = readLogo;
  window.LVC.makeAccent = makeAccent;
  window.LVC.hexToRgb = hexToRgb;
})();

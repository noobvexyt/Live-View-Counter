/* 3D rolling counter. Every digit is a ten-sided drum, like a mechanical tally counter seen up close.
   When a digit changes, its drum rolls on a spring and lands with a small mechanical bounce, faces
   darken as they turn away, and fast spins smear with motion blur. Big jumps (and the opening spin)
   roll smoothly and settle without wobbling. Counts that go down (followers can) roll backwards.
   Same interface as Odometer. */
(function () {
  'use strict';

  // The rolling is the whole point of this page (the user asked for it), so it runs even when the
  // system asks for reduced motion. Windows turns that on whenever "Animation effects" is off.
  const STEP = 36;                              // degrees per digit
  const RADIUS = 0.5 / Math.tan(Math.PI / 10);   // drum radius for faces 1em tall (≈ 1.539em)
  const OMEGA = 17;                              // spring stiffness (rad/s) at normal speed
  const ZETA = 0.42;                             // spring damping: a little overshoot, then settles
  const LAND_KICK = 190;                         // deg/s nudge when a long roll lands, for a soft clunk
  const easeOut = (p) => 1 - Math.pow(1 - p, 4);
  const FLASH = [0.32, 0.5, 0.75, 1];            // glow strength by place: ones, tens, hundreds, thousands+

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  class Drum {
    constructor(digit, speed) {
      this.speed = speed;
      this.el = span('drum-col');
      this.el.appendChild(span('drum-sizer', '0'));
      this.glow = span('drum-glow');
      this.el.appendChild(this.glow);
      this.win = span('drum-window');
      this.drum = span('drum');
      this.faces = [];
      for (let k = 0; k < 10; k++) {
        const f = span('drum-face', String(k));
        f.style.transform = `rotateX(${-k * STEP}deg) translateZ(${RADIUS.toFixed(4)}em)`;
        this.faces.push(f);
        this.drum.appendChild(f);
      }
      this.win.appendChild(this.drum);
      this.el.appendChild(this.win);
      this.a = this.target = digit * STEP; // current and target angle, unbounded
      this.v = 0;                          // angular velocity, deg/s
      this.tween = null;
      this.moving = false;
      this.onLand = null;
      this.blurOn = false;
      this.draw();
    }

    digit() {
      return ((Math.round(this.target / STEP) % 10) + 10) % 10;
    }

    // Roll to `digit` (forwards, or backwards when `down`). spin: add a full turn (the opening spin).
    to(digit, { spin = false, delay = 0, dur = 0, place = 0, down = false, flash = true } = {}) {
      const fwd = (digit - this.digit() + 10) % 10;
      let steps = down ? -((this.digit() - digit + 10) % 10) : fwd;
      if (spin) steps += 10;
      if (!steps) return false;
      this.target += steps * STEP;
      const now = performance.now();
      const n = Math.abs(steps);
      if (this.tween) {
        this.tween.to = this.target; // already rolling a long way: just roll a little further
      } else if (spin || n >= 3) {
        this.tween = { from: this.a, to: this.target, t0: now + delay, dur: (dur || 260 + n * 45) / this.speed, spin, dir: Math.sign(steps) };
      }
      if (!spin && flash) this.flash(FLASH[Math.min(place, 3)], place >= 2);
      this.moving = true;
      return true;
    }

    flash(strength, bump) {
      if (!this.glow.animate) return;
      if (this.glowAnim) this.glowAnim.cancel();
      this.glowAnim = this.glow.animate(
        [{ opacity: 0 }, { opacity: strength, offset: 0.22 }, { opacity: 0 }],
        { duration: 760, easing: 'ease-out' },
      );
      if (bump) {
        this.win.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.045)', offset: 0.32 }, { transform: 'scale(1)' }],
          { duration: 420, easing: 'cubic-bezier(.2,.7,.3,1)' },
        );
      }
    }

    // Advance one animation frame. Returns false once the drum is at rest.
    update(now, dt) {
      const tw = this.tween;
      if (tw) {
        const p = (now - tw.t0) / tw.dur;
        if (p < 0) return true;
        if (p >= 1) {
          this.a = tw.to;
          this.v = LAND_KICK * Math.sign(tw.to - tw.from || 1);
          this.tween = null;
          if (tw.spin) {
            this.flash(0.8, true);
            if (this.onLand) this.onLand();
          }
        } else {
          const prev = this.a;
          this.a = tw.from + (tw.to - tw.from) * easeOut(p);
          this.v = dt > 0 ? (this.a - prev) / dt : this.v;
        }
      } else {
        // Damped spring toward the target, integrated in small steps so it stays stable.
        const w = OMEGA * this.speed;
        for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 240) {
          const h = Math.min(left, 1 / 240);
          const acc = w * w * (this.target - this.a) - 2 * ZETA * w * this.v;
          this.v += acc * h;
          this.a += this.v * h;
        }
        if (Math.abs(this.target - this.a) < 0.04 && Math.abs(this.v) < 0.8) {
          this.a = this.target;
          this.v = 0;
          if (Math.abs(this.target) >= 3600) { // keep the numbers small; a whole number of turns looks identical
            const turns = Math.trunc(this.target / 360) * 360;
            this.a -= turns;
            this.target -= turns;
          }
          this.draw();
          return false;
        }
      }
      this.draw();
      return true;
    }

    draw() {
      this.drum.style.transform = `translateZ(${(-RADIUS).toFixed(4)}em) rotateX(${this.a.toFixed(3)}deg)`;
      // Light falls off as a face turns away from you.
      for (let k = 0; k < 10; k++) {
        const th = ((((this.a - k * STEP) % 360) + 540) % 360) - 180;
        const c = Math.cos((th * Math.PI) / 180);
        this.faces[k].style.opacity = c > 0.05 ? (0.18 + 0.82 * c * c * c).toFixed(3) : '0';
      }
      // Motion blur: a short vertical smear when the drum spins fast (not on an ordinary +1).
      const speed = Math.abs(this.v) / STEP; // digits per second
      if (speed > 14) {
        const len = Math.min(0.16, (speed - 10) * 0.005) * Math.sign(this.v);
        // (text-shadow, not a filter: a filter would flatten the 3D drum)
        this.drum.style.textShadow =
          `0 ${(len * 0.35).toFixed(3)}em 0 rgba(255,255,255,.26), 0 ${(len * 0.7).toFixed(3)}em 0 rgba(255,255,255,.14), 0 ${len.toFixed(3)}em 0 rgba(255,255,255,.06)`;
        this.blurOn = true;
      } else if (this.blurOn) {
        this.drum.style.textShadow = '';
        this.blurOn = false;
      }
    }
  }

  class DrumCounter {
    // sep: the thousands separator ('' for none). speed: 1 = normal, higher rolls faster.
    constructor(el, { onLayout, onLand, sep = ',', speed = 1 } = {}) {
      this.el = el;
      this.el.classList.add('drums');
      this.cols = []; // ones digit first
      this.value = null;
      this.sep = sep;
      this.speed = speed;
      this.onLayout = onLayout || (() => {});
      this.onLand = onLand || null;
      this.raf = 0;
      this.last = 0;
      this.loop = this.loop.bind(this);
    }

    // instant: show it straight away. intro: every drum spins up and lands, left to right.
    set(n, { instant = false, intro = false } = {}) {
      n = Math.max(0, Math.floor(Number(n) || 0));
      if (n === this.value && !instant && !intro) return;
      const down = this.value != null && n < this.value;
      const digits = String(n).split('').reverse().map(Number);
      const len = digits.length;
      if (instant || intro) {
        this.cols = digits.map((d) => new Drum(intro ? 0 : d, this.speed));
        this.render();
      } else if (len !== this.cols.length) {
        while (this.cols.length < len) this.cols.push(new Drum(0, this.speed)); // a new leading digit rolls in
        this.cols.length = len;
        this.render();
      }
      if (intro) {
        for (let i = 0; i < len; i++) {
          const fromLeft = len - 1 - i;
          const col = this.cols[i];
          col.onLand = this.onLand;
          col.to(digits[i], { spin: true, delay: 80, dur: 1050 + fromLeft * 130 });
        }
      } else if (!instant) {
        for (let i = 0; i < len; i++) this.cols[i].to(digits[i], { place: i, down });
      }
      this.value = n;
      this.start();
    }

    // A wave of light across the digits, left to right (milestones).
    wave() {
      const n = this.cols.length;
      this.cols.forEach((c, i) => setTimeout(() => c.flash(1, true), (n - 1 - i) * 70));
    }

    columns() {
      return this.cols.map((c) => c.el); // ones digit first
    }

    start() {
      if (this.raf) return;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.loop);
    }

    loop(now) {
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      let busy = false;
      for (const c of this.cols) {
        if (!c.moving) continue;
        c.moving = c.update(now, dt);
        busy = busy || c.moving;
      }
      this.raf = busy ? requestAnimationFrame(this.loop) : 0;
    }

    render() {
      this.el.textContent = '';
      for (let i = this.cols.length - 1; i >= 0; i--) {
        this.el.appendChild(this.cols[i].el);
        if (i > 0 && i % 3 === 0 && this.sep) this.el.appendChild(span('drum-sep', this.sep));
      }
      void this.el.offsetWidth;
      this.onLayout();
    }

    destroy() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.el.classList.remove('drums');
      this.el.textContent = '';
    }
  }

  window.DrumCounter = DrumCounter;
})();

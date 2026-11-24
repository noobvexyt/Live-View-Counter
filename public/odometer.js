/* Rolling digit counter, styled like a live subscriber count: when a digit changes, the old digit
   slides up out of a tight window and the new one slides in from below, with a little space between.
   Only the digits that change move, and a count that goes down slides the other way. Each column is a
   strip of 0–9 three times over, so a digit can keep rolling even when a new number arrives part-way
   through a slide.

   Also here: PlainCounter, which just shows the number with no animation. */
(function () {
  'use strict';

  const CELLS = 30;

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  class Column {
    constructor(digit) {
      this.el = span('odo-col');
      this.strip = span('odo-strip');
      for (let k = 0; k < CELLS; k++) this.strip.appendChild(span('odo-glyph', String(k % 10)));
      this.el.appendChild(span('odo-glyph odo-sizer', '0')); // gives the window its exact size
      this.el.appendChild(this.strip);
      this.endAt = 0;
      this.timer = 0;
      this.place(10 + digit, 0); // rest in the middle set of digits
    }

    place(pos, ms) {
      this.pos = pos;
      this.strip.style.transitionDuration = `${ms}ms`;
      this.strip.style.transform = `translateY(${(-pos * 100) / CELLS}%)`;
      if (!ms) void this.strip.offsetHeight; // apply now, before any next slide starts
    }

    // Where the strip is right now, in cells. Part-way through a slide this is fractional.
    current(now) {
      if (now >= this.endAt) return this.pos;
      const h = this.strip.offsetHeight;
      const m = getComputedStyle(this.strip).transform;
      if (!h || !m || m === 'none') return this.pos;
      try {
        return (-new DOMMatrixReadOnly(m).m42 / h) * CELLS;
      } catch (e) {
        return this.pos;
      }
    }

    to(digit, ms, down) {
      const now = performance.now();
      const moving = now < this.endAt;
      let cur = this.current(now);
      if (!moving && ((Math.round(cur) % 10) + 10) % 10 === digit) return;
      clearTimeout(this.timer);
      // Bring the strip back to the middle set without any visible change (the sets look identical).
      if (cur >= 20 || cur < 10) cur = (((cur - 10) % 10) + 10) % 10 + 10;
      if (moving || cur !== this.pos) this.place(cur, 0);
      let target = 10 + digit;
      if (down) while (target > cur + 0.3) target -= 10; // roll downward
      else while (target < cur - 0.3) target += 10;      // roll upward
      if (ms <= 0) {
        this.endAt = 0;
        this.place(10 + digit, 0);
        return;
      }
      this.place(target, ms);
      this.endAt = now + ms;
      if (target >= 20 || target < 10) this.timer = setTimeout(() => this.place(10 + digit, 0), ms + 40);
    }
  }

  class Odometer {
    // sep: thousands separator ('' for none). speed: 1 = normal, higher slides faster.
    constructor(el, { onLayout, sep = ',', speed = 1 } = {}) {
      this.el = el;
      this.el.classList.add('odo');
      this.cols = []; // ones digit first
      this.value = null;
      this.sep = sep;
      this.speed = speed;
      this.onLayout = onLayout || (() => {});
    }

    // instant: show the number straight away (first load, another channel). Otherwise changed digits slide.
    set(n, { duration = 500, instant = false } = {}) {
      n = Math.max(0, Math.floor(Number(n) || 0));
      if (n === this.value && !instant) return;
      const down = this.value != null && n < this.value;
      const digits = String(n).split('').reverse().map(Number);
      if (instant) {
        this.cols = digits.map((d) => new Column(d));
        this.render();
      } else if (digits.length !== this.cols.length) {
        while (this.cols.length < digits.length) this.cols.push(new Column(0)); // a new leading digit rolls in
        this.cols.length = digits.length;
        this.render();
      }
      const ms = instant ? 0 : Math.round(duration / this.speed);
      for (let i = 0; i < digits.length; i++) this.cols[i].to(digits[i], ms, down);
      this.value = n;
    }

    columns() {
      return this.cols.map((c) => c.el); // ones digit first
    }

    destroy() {
      this.el.classList.remove('odo');
      this.el.textContent = '';
    }

    render() {
      this.el.textContent = '';
      for (let i = this.cols.length - 1; i >= 0; i--) {
        this.el.appendChild(this.cols[i].el);
        if (i > 0 && i % 3 === 0 && this.sep) this.el.appendChild(span('odo-sep', this.sep));
      }
      void this.el.offsetWidth;
      this.onLayout();
    }
  }

  // No animation: the number simply changes.
  class PlainCounter {
    constructor(el, { onLayout, sep = ',' } = {}) {
      this.el = el;
      this.el.classList.add('plain');
      this.value = null;
      this.sep = sep;
      this.cols = [];
      this.onLayout = onLayout || (() => {});
    }

    set(n) {
      n = Math.max(0, Math.floor(Number(n) || 0));
      if (n === this.value) return;
      const lenChanged = this.value == null || String(n).length !== String(this.value).length;
      const digits = String(n).split('').reverse();
      if (lenChanged) {
        this.cols = digits.map((d) => span('plain-char', d));
        this.el.textContent = '';
        for (let i = this.cols.length - 1; i >= 0; i--) {
          this.el.appendChild(this.cols[i]);
          if (i > 0 && i % 3 === 0 && this.sep) this.el.appendChild(span('plain-char plain-sep', this.sep));
        }
      } else {
        digits.forEach((d, i) => { if (this.cols[i].textContent !== d) this.cols[i].textContent = d; });
      }
      this.value = n;
      if (lenChanged) {
        void this.el.offsetWidth;
        this.onLayout();
      }
    }

    columns() {
      return this.cols.slice();
    }

    destroy() {
      this.el.classList.remove('plain');
      this.el.textContent = '';
    }
  }

  window.Odometer = Odometer;
  window.PlainCounter = PlainCounter;
})();

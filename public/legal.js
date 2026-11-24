/* Legal pages: shows the site owner's name (the OWNER_NAME setting in Vercel) where the text names them. */
(function () {
  'use strict';
  fetch('/api/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((cfg) => {
      const name = cfg && typeof cfg.owner === 'string' ? cfg.owner.trim() : '';
      if (!name) return;
      for (const el of document.querySelectorAll('[data-owner]')) el.textContent = name;
    })
    .catch(() => { /* keep the general wording */ });
})();

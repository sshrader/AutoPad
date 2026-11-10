/* The "Recently launched" list, and the fee wording that comes from the server's own settings. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  // The coin table itself is drawn by stats.js. This only keeps the coin count in the hero button.
  async function load() {
    try {
      const padSlug = window.PAD.extra && window.PAD.extra.slug;
      const res = await fetch('/api/launches' + (padSlug ? '?pad=' + encodeURIComponent(padSlug) : ''), { cache: 'no-store', headers: { Accept: 'application/json' } });
      const body = await res.json();
      const list = Array.isArray(body && body.launches) ? body.launches : [];
      const cc = $('coin-count'); if (cc) cc.textContent = list.length ? '(' + list.length + ')' : '';
    } catch (err) { /* the table shows its own message */ }
  }

  // New launches appear after the page launches one, and the list quietly refreshes while the tab is open.
  document.addEventListener('animalpad:launched', () => [3000, 8000, 16000, 30000, 60000].forEach(ms => setTimeout(load, ms)));
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load();

  // Fee wording straight from the server's settings, so it can never disagree with what is deployed.
  fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(info => {
      const t = info && info.split;
      if (!t || !Number.isFinite(t.creatorPct) || !Number.isFinite(t.platformPct)) return;
      const ex = window.PAD.extra, owner = ex && ex.ownerPct > 0 ? Math.min(ex.ownerPct, 50 - t.platformPct) : 0;
      $('fee-note-how').textContent = 'Every trade pays a creator fee, shared on-chain: ' + (t.creatorPct - owner) + '% to the wallet that launched the coin, ' + (owner ? owner + '% to the owner of ' + window.PAD.name + ', ' : '') + t.platformPct + '% to ' + window.PAD.platform + '. Anyone can send the fees out; they always go to the wallets in the split.';
    })
    .catch(() => { /* the generic sentence stays */ });
})();

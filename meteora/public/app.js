'use strict';
// Draws the coin list and the coin page. All text goes in with textContent, never as HTML.
(function () {
  var cfg = { cluster: 'devnet', explorer: 'https://explorer.solana.com', explorerSuffix: '?cluster=devnet' };
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function short(a) { return a && a.length > 12 ? a.slice(0, 5) + '…' + a.slice(-5) : (a || ''); }
  function fmt(n, d) { return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 3 : d }) : '–'; }
  function get(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }); }
  function link(href, text) { var a = el('a', '', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; }
  function exp(kind, addr) { return cfg.explorer + '/' + kind + '/' + addr + cfg.explorerSuffix; }
  function badge(c) {
    var b = el('div', 'badge');
    if (c.image) { var i = el('img'); i.src = c.image; i.alt = ''; b.appendChild(i); } else { b.textContent = (c.symbol || '?').slice(0, 2); }
    return b;
  }
  function stat(c) { // one comparable set of numbers for a real or a demo coin
    if (c.simulated) return { progress: c.stats.progress, collected: c.stats.collectedSol, paid: c.stats.paidSol, mcap: c.stats.mcapSol };
    var l = c.live; return l ? { progress: l.progress, collected: l.collectedSol, paid: null, mcap: l.quoteReserveSol } : null;
  }
  function tags(c, h) {
    if (c.flagship) h.appendChild(el('span', 'tag gold', 'FLAGSHIP'));
    if (c.simulated) return;
    if (!c.launched) h.appendChild(el('span', 'tag', 'NOT LAUNCHED'));
    else h.appendChild(el('span', 'tag', 'LIVE · ' + (cfg.cluster === 'mainnet-beta' ? 'MAINNET' : 'DEVNET')));
  }
  function card(c) {
    var a = el('a', 'card' + (c.flagship ? ' flag' : '')); a.href = '/coin?id=' + encodeURIComponent(c.id);
    a.appendChild(badge(c));
    var mid = el('div'); var h = el('h3', '', c.name + ' '); h.appendChild(el('span', 'mono', '$' + c.symbol)); tags(c, h); mid.appendChild(h);
    mid.appendChild(el('div', 'sub', c.description)); a.appendChild(mid);
    if (c.flagship && c.launched) a.appendChild(el('span', 'stamp', 'LIVE'));
    var s = stat(c), n = el('div', 'num');
    if (s) { n.appendChild(el('b', '', fmt(s.collected, 2) + ' SOL')); n.appendChild(document.createTextNode('fees collected')); } else n.appendChild(document.createTextNode(c.launched ? 'loading…' : 'soon'));
    a.appendChild(n);
    if (s && typeof s.progress === 'number') { var m = el('div', 'meter'), i = el('i'); i.style.width = (s.progress > 0 ? Math.max(2, Math.min(100, s.progress)) : 0) + '%'; m.appendChild(i); a.appendChild(m); }
    return a;
  }
  function setNet() {
    var n = $('net'); if (!n) return;
    n.textContent = cfg.cluster === 'mainnet-beta' ? 'MAINNET' : 'DEVNET'; n.className = 'net' + (cfg.cluster === 'mainnet-beta' ? '' : ' dev');
  }
  function home() {
    get('/api/coins').then(function (coins) {
      var list = $('list'); list.textContent = '';
      coins.forEach(function (c) { list.appendChild(card(c)); });
      var f = coins[0];
      if (f && !f.launched) { var note = $('note'); note.hidden = false; note.textContent = 'The flagship coin has not been launched yet. When it is, it appears here first with live numbers from the chain.'; }
    }).catch(function () { $('list').textContent = 'Could not load coins. Try again in a moment.'; });
  }
  function panel(title) { var p = el('div', 'panel'); p.appendChild(el('h2', '', title)); return p; }
  function cell(label, value) { var d = el('div'); d.appendChild(el('span', '', label)); var b = el('b'); if (value && value.nodeType) b.appendChild(value); else b.textContent = value; d.appendChild(b); return d; }
  function coinPage() {
    var id = new URLSearchParams(location.search).get('id') || 'flagship', root = $('coin');
    Promise.all([get('/api/coins/' + encodeURIComponent(id)), get('/api/payouts')]).then(function (r) {
      var c = r[0], pays = r[1].filter(function (p) { return p.id === c.id; });
      document.title = c.name + ' · AutoPayment on Meteora'; root.textContent = '';
      var head = el('div', 'hero'); var row = el('div'); row.style.cssText = 'display:flex;gap:1rem;align-items:center;flex-wrap:wrap';
      row.appendChild(badge(c)); var h = el('h1', '', c.name + ' '); h.style.fontSize = 'clamp(1.7rem,4vw,2.4rem)'; h.appendChild(el('span', 'mono', '$' + c.symbol)); row.appendChild(h); head.appendChild(row);
      var tg = el('div'); tg.style.marginTop = '.5rem'; tags(c, tg); head.appendChild(tg); head.appendChild(el('p', '', c.description)); root.appendChild(head);
      var s = stat(c), p = panel('Curve and fees');
      if (!c.launched) p.appendChild(el('p', '', 'Not launched yet.'));
      else if (!s) p.appendChild(el('p', '', 'Live numbers are not available right now.'));
      else {
        var g = el('div', 'grid');
        g.appendChild(cell('Curve progress', typeof s.progress === 'number' ? fmt(s.progress, 1) + '%' : '–'));
        g.appendChild(cell('SOL in the curve', fmt(s.mcap, 2) + ' SOL'));
        g.appendChild(cell('Fees collected', fmt(s.collected, 4) + ' SOL'));
        if (c.simulated) g.appendChild(cell('Paid to creator', fmt(s.paid, 4) + ' SOL'));
        else { g.appendChild(cell('Waiting for creator', fmt(c.live.pendingCreatorSol, 4) + ' SOL')); g.appendChild(cell('Waiting for platform', fmt(c.live.pendingPlatformSol, 4) + ' SOL')); }
        p.appendChild(g);
      }
      root.appendChild(p);
      var w = panel('Where it lives');
      var g2 = el('div', 'grid'); g2.appendChild(cell('Creator wallet', c.creator ? link(exp('address', c.creator), short(c.creator)) : '–'));
      if (!c.simulated && c.mint) g2.appendChild(cell('Token', link(exp('address', c.mint), short(c.mint))));
      if (!c.simulated && c.pool) g2.appendChild(cell('Pool', link(exp('address', c.pool), short(c.pool))));
      w.appendChild(g2); root.appendChild(w);
      var q = panel('Payouts'); 
      if (c.simulated) q.appendChild(el('p', 'sub', 'No payouts yet.'));
      else if (!pays.length) q.appendChild(el('p', 'sub', 'No payouts logged yet. The fee claimer runs on a schedule and every payout appears here.'));
      else {
        var wrap = el('div', 'tblwrap'), t = el('table'), hd = el('tr'); ['When', 'Creator got', 'Platform got', 'Mode', 'Transaction'].forEach(function (x) { hd.appendChild(el('th', '', x)); }); t.appendChild(hd);
        pays.forEach(function (y) {
          var tr = el('tr'); tr.appendChild(el('td', '', new Date(y.at).toLocaleString()));
          tr.appendChild(el('td', '', fmt((y.creatorLamports || 0) / 1e9, 5) + ' SOL')); tr.appendChild(el('td', '', fmt((y.platformLamports || 0) / 1e9, 5) + ' SOL'));
          tr.appendChild(el('td', '', y.mode === 'sent' ? 'sent' : 'dry run')); var td = el('td'); if (y.creatorTx) td.appendChild(link(exp('tx', y.creatorTx), 'view')); else td.textContent = y.error ? 'error' : '–'; tr.appendChild(td); t.appendChild(tr);
        });
        wrap.appendChild(t); q.appendChild(wrap);
      }
      root.appendChild(q);
    }).catch(function () { root.textContent = 'Could not load this coin.'; });
  }
  get('/api/config').then(function (c) { cfg = c; }).catch(function () {}).then(function () { setNet(); if ($('coin')) coinPage(); else home(); });
})();

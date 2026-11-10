// The coin table on the home page: one row per coin with market cap, curve progress, holders, fees sent and airdrop status.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var wrap = $('statswrap'), body = $('stats-body');
  if (!wrap || !body) return;

  var rows = [], sortKey = 'createdAt', sortDir = -1, solUsd = null;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }
  function sol(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString(undefined, { maximumFractionDigits: d }) + ' SOL'; }
  function usd(n) { return '$' + Math.round(n).toLocaleString(); }

  function coinCell(c) {
    var td = el('th'); td.scope = 'row'; td.className = 'l';
    var a = el('a', 'coincell'); a.href = '/coin/' + encodeURIComponent(c.pool);
    if (typeof c.imageUrl === 'string' && /^\/art\/[0-9a-f]{16}\.(png|jpg)$/.test(c.imageUrl)) {
      var im = el('img'); im.src = c.imageUrl; im.alt = ''; im.width = 32; im.height = 32; im.loading = 'lazy'; a.appendChild(im);
    } else a.appendChild(el('span', 'noimg', String(c.name || '?').charAt(0).toUpperCase()));
    var t = el('span', 'cn'); t.appendChild(el('b', '', c.name)); t.appendChild(el('i', '', '$' + c.symbol));
    a.appendChild(t); td.appendChild(a);
    return td;
  }
  function num(text, sub) { var td = el('td', 'r num'); td.appendChild(el('span', '', text)); if (sub) td.appendChild(el('small', '', sub)); return td; }

  function airdropCell(a) {
    var td = el('td', 'l');
    if (!a) { td.appendChild(el('span', 'dim', 'None')); return td; }
    var label = a.status === 'done' ? 'Sent to ' + a.recipients : a.status === 'failed' ? 'Not sent' : a.status === 'sending' ? 'Sending' : 'Scheduled';
    td.appendChild(el('span', 'pill ' + (a.status === 'done' ? 'ok' : a.status === 'failed' ? 'bad' : ''), label));
    td.appendChild(el('small', '', a.pct + '% of first buy'));
    return td;
  }
  function setupCell(c) {
    var td = el('td', 'l');
    var tags = [];
    if (c.boosted) tags.push('Promoted');
    if (c.feeMode === 'partner') tags.push('Partner ' + c.partnerPct + '%');
    if (c.feeMode === 'holder') tags.push('Holder rewards');
    if (!tags.length) tags.push('Creator rewards');
    tags.forEach(function (t) { td.appendChild(el('span', 'tag' + (t === 'Promoted' ? ' hot' : ''), t)); });
    return td;
  }

  function draw() {
    var list = rows.slice().sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      x = x === null || x === undefined ? -1 : x; y = y === null || y === undefined ? -1 : y;
      return (x - y) * sortDir || b.createdAt - a.createdAt;
    });
    body.textContent = '';
    list.forEach(function (c) {
      var tr = el('tr');
      tr.appendChild(coinCell(c));
      tr.appendChild(c.marketCapSol === null ? num('–') : num(sol(c.marketCapSol, 1), c.marketCapUsd !== null ? usd(c.marketCapUsd) : ''));
      var cv = el('td', 'curve');
      var bar = el('span', 'bar'); var fill = el('i'); fill.style.width = Math.round(Math.max(0, Math.min(1, c.progress || 0)) * 100) + '%'; bar.appendChild(fill);
      cv.appendChild(bar); cv.appendChild(el('small', '', c.migrated ? 'Graduated' : Math.round((c.progress || 0) * 100) + '%'));
      tr.appendChild(cv);
      tr.appendChild(c.holders === null ? num('…') : num(String(c.holders) + (c.holdersMore ? '+' : '')));
      tr.appendChild(num(c.feesSentSol > 0 ? sol(c.feesSentSol, 4) : '–', c.payouts ? c.payouts + (c.payouts === 1 ? ' payout' : ' payouts') : ''));
      tr.appendChild(airdropCell(c.airdrop));
      tr.appendChild(setupCell(c));
      tr.appendChild(num(ago(c.createdAt)));
      body.appendChild(tr);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#stats thead button'), function (b) {
      var on = b.dataset.k === sortKey;
      b.classList.toggle('on', on);
      b.setAttribute('aria-sort', on ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
      b.dataset.dir = on ? (sortDir > 0 ? '▲' : '▼') : '';
    });
  }

  var retried = false;
  function load() {
    fetch('/api/coinstats', { cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var note = $('feed-note');
      if (!d || !Array.isArray(d.coins)) { note.textContent = 'Could not load the latest coins. Try again in a moment.'; return; }
      rows = d.coins; solUsd = d.solUsd;
      wrap.hidden = !rows.length;
      note.textContent = rows.length ? '' : 'No coins yet. Launch the first one below.';
      draw();
      // Holder counts are read in the background the first time, so look again shortly.
      if (!retried && rows.some(function (c) { return c.holders === null; })) { retried = true; setTimeout(load, 6000); }
    }).catch(function () { $('feed-note').textContent = 'Could not load the latest coins. Try again in a moment.'; });
  }

  $('stats').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-k]') : null;
    if (!b) return;
    if (sortKey === b.dataset.k) sortDir = -sortDir; else { sortKey = b.dataset.k; sortDir = -1; }
    draw();
  });
  document.addEventListener('animalpad:launched', function () { [3000, 8000, 16000, 30000, 60000].forEach(function (ms) { setTimeout(load, ms); }); });
  setInterval(function () { if (!document.hidden) load(); }, 30000);
  load();
})();

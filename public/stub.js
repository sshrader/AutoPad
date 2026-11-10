// The pay stubs: the live "next automatic payout" countdown and the latest payouts. It only reads /api/autoclaim and /api/payouts.
(function () {
  'use strict';
  var timers = [];

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function getJson(url) { return fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  function sol(n) { n = Number(n) || 0; return (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4)) + ' SOL'; }
  function two(n) { return n < 10 ? '0' + n : String(n); }
  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + ':' + two(m) + ':' + two(s % 60) : two(m) + ':' + two(s % 60);
  }
  function ago(at) {
    var s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function suffix() { return window.AnimalNet && window.AnimalNet.suffix ? window.AnimalNet.suffix : ''; }

  // One stub: `root` holds the elements; `pool` limits the payout list to one coin.
  function mount(root, parts, pool) {
    var st = null, fetchedAt = 0, list = [];
    function remaining() {
      if (!st || !st.enabled || !st.nextRunAt) return null;
      return st.nextRunAt - (st.serverNow || fetchedAt) - (Date.now() - fetchedAt);
    }
    function drawList() {
      if (!parts.list) return;
      parts.list.textContent = '';
      if (!list.length) {
        var min = st && st.minSol ? sol(st.minSol) : 'a little';
        parts.list.appendChild(el('li', 'stub-empty', pool ? 'Not paid out yet. A coin is paid once it has ' + min + ' waiting.' : 'No payouts yet. A coin is paid once it has ' + min + ' waiting.'));
        return;
      }
      list.forEach(function (p) {
        var li = el('li');
        li.appendChild(el('span', 'sym', '$' + String(p.symbol || '').slice(0, 10)));
        var a = el('a', 'amt', '+' + sol(p.sol));
        if (/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(p.sig || '')) { a.href = 'https://explorer.solana.com/tx/' + encodeURIComponent(p.sig) + suffix(); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = 'See the payout on the explorer'; }
        li.appendChild(a);
        li.appendChild(el('span', 'when', ago(p.at)));
        parts.list.appendChild(li);
      });
    }
    function drawStatic() {
      var on = Boolean(st && st.enabled);
      root.dataset.on = on ? 'yes' : 'no';
      if (parts.state) parts.state.textContent = !st ? 'Checking…' : !on ? 'Not running' : st.lowGas ? 'Low on gas' : 'Auto-pay on';
      if (parts.total) parts.total.textContent = on ? sol(st.totalPaidSol) : '–';
      if (parts.count) parts.count.textContent = on ? String(st.payouts) : '–';
      if (parts.min) parts.min.textContent = on ? sol(st.minSol) : '–';
      if (parts.every) parts.every.textContent = on ? st.everyMin + ' min' : '–';
      drawList();
    }
    function tick() {
      if (!parts.clock) return;
      var r = remaining();
      if (r === null) { parts.clock.textContent = '--:--'; if (parts.label) parts.label.textContent = st && !st.enabled ? 'Auto-claim is switched off on this server.' : 'Next automatic payout in'; return; }
      if (parts.label) parts.label.textContent = 'Next automatic payout in';
      parts.clock.textContent = r > 0 ? clock(r) : '00:00';
      if (r <= -5000 && Date.now() - fetchedAt > 8000) load(); // the run is due: look again for its result
    }
    function load() {
      return Promise.all([getJson('/api/autoclaim'), getJson('/api/payouts?limit=' + (pool ? 5 : 6) + (pool ? '&pool=' + encodeURIComponent(pool) : ''))]).then(function (r) {
        st = r[0]; list = r[1] && Array.isArray(r[1].payouts) ? r[1].payouts : []; fetchedAt = Date.now();
        drawStatic(); tick();
      });
    }
    load();
    timers.push(setInterval(tick, 1000), setInterval(load, 45000));
  }

  // The home page stub
  var home = document.getElementById('apstub');
  if (home) {
    mount(home, { state: document.getElementById('st-state'), label: document.getElementById('st-label'), clock: document.getElementById('st-count'), total: document.getElementById('st-total'), count: document.getElementById('st-n'), min: document.getElementById('st-min'), every: document.getElementById('st-every'), list: document.getElementById('st-list') }, '');
  }

  // A coin page's small stub
  window.APStub = {
    coin: function (parent, c) {
      var root = el('aside', 'stub paystub');
      root.setAttribute('aria-label', 'Automatic payouts for this coin');
      var h = el('div', 'stub-h'); var state = el('span', 'stub-state', 'Checking…'); h.appendChild(el('span', '', 'Payout stub')); h.appendChild(state); root.appendChild(h);
      var big = el('div', 'stub-big'); var label = el('span', 'stub-l', 'Next automatic payout in'); var clk = el('output', 'stub-n', '--:--'); big.appendChild(label); big.appendChild(clk); root.appendChild(big);
      var list = el('ul', 'stub-list'); root.appendChild(el('div', 'tear')); root.appendChild(list);
      parent.appendChild(root);
      mount(root, { state: state, label: label, clock: clk, list: list }, c.pool);
    }
  };
})();

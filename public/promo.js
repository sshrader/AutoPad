// The Promoted row on the home page: coins whose creators paid for a boost, labeled as paid placement.
(function () {
  'use strict';
  var box = document.getElementById('promoted'), grid = document.getElementById('promo-grid');
  if (!box || !grid) return;

  function left(ms) {
    var m = Math.max(0, Math.ceil((ms - Date.now()) / 60000));
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min left' : m + ' min left';
  }
  function card(c) {
    var a = document.createElement('a');
    a.className = 'promo-card';
    a.href = '/coin/' + encodeURIComponent(c.pool);
    if (typeof c.imageUrl === 'string' && /^\/art\/[0-9a-f]{16}\.(png|jpg)$/.test(c.imageUrl)) {
      var im = document.createElement('img'); im.src = c.imageUrl; im.alt = ''; im.width = 56; im.height = 56; a.appendChild(im);
    } else {
      var n = document.createElement('span'); n.className = 'noimg'; n.textContent = String(c.name || '?').charAt(0).toUpperCase(); a.appendChild(n);
    }
    var t = document.createElement('span'); t.className = 'promo-t';
    var b = document.createElement('b'); b.textContent = c.name;
    var s = document.createElement('i'); s.textContent = '$' + c.symbol;
    var e = document.createElement('em'); e.textContent = c.flagship ? 'Flagship coin' : 'Promoted · ' + left(c.endsAt);
    t.appendChild(b); t.appendChild(s); t.appendChild(e); a.appendChild(t);
    return a;
  }
  function load() {
    fetch('/api/promoted', { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var items = d && Array.isArray(d.items) ? d.items : [];
      grid.textContent = '';
      items.forEach(function (c) { grid.appendChild(card(c)); });
      box.hidden = !items.length;
      var badge = document.getElementById('promo-badge');
      if (badge) badge.textContent = items.some(function (c) { return !c.flagship; }) ? 'Paid placement' : 'Flagship coin';
    }).catch(function () { box.hidden = true; });
  }
  load();
  setInterval(load, 60000);
})();

'use strict';
// The header every page shares: logo, links, network badge, wallet button.
(function () {
  var top = document.getElementById('top'); if (!top) return;
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x !== undefined) n.textContent = x; return n; }
  var home = el('a', 'brand'); home.href = '/'; var img = el('img'); img.src = '/icon.svg'; img.alt = ''; home.appendChild(img); home.appendChild(el('b', '', 'AutoPayment')); top.appendChild(home);
  var nav = el('nav', 'links'); nav.setAttribute('aria-label', 'Sections');
  [['/', 'Coins'], ['/launch', 'Launch a coin'], ['/how', 'How it works'], ['/rules', 'Rules']].forEach(function (l) {
    var a = el('a', '', l[1]); a.href = l[0]; if (location.pathname === l[0] || (l[0] === '/' && location.pathname === '/coin')) a.setAttribute('aria-current', 'page'); nav.appendChild(a);
  });
  top.appendChild(nav);
  var net = el('span', 'net', '…'); net.id = 'net'; top.appendChild(net);
  var wb = el('button', 'wbtn', 'Connect wallet'); wb.type = 'button'; top.appendChild(wb);
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) { net.textContent = c.cluster === 'mainnet-beta' ? 'MAINNET' : 'DEVNET'; }).catch(function () { net.textContent = ''; });
  var W = window.APWallet;
  function short(a) { return a.slice(0, 4) + '…' + a.slice(-4); }
  if (W) {
    W.onChange(function (a) { wb.textContent = a ? short(a) : 'Connect wallet'; wb.title = a || ''; });
    wb.addEventListener('click', function () {
      if (W.address) { W.disconnect(); return; }
      W.connect().catch(function (e) { wb.textContent = e && e.code === 'no_wallet' ? 'Install Phantom' : 'Not connected'; setTimeout(function () { wb.textContent = 'Connect wallet'; }, 2500); });
    });
  }
})();

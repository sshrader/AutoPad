// The home page's "Launch options" cards: fills in the numbers that depend on this site's settings.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function all(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  function sol(n) { return (Math.round(n * 100) / 100).toFixed(2) + ' SOL'; }
  function span(min) { return min >= 60 ? (Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '')) : min + ' min'; }
  function get(url) { return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }

  get('/api/launch/config').then(function (c) {
    if (!c) return;
    var plat = Number.isFinite(c.platformPct) ? c.platformPct : 10;
    all('.pct-plat', function (e) { e.textContent = plat + '%'; });
    all('.pct-you', function (e) { e.textContent = (100 - plat) + '%'; });
    all('.pct-max', function (e) { e.textContent = (Number.isFinite(c.maxPartnerPct) ? c.maxPartnerPct : 50 - plat) + '%'; });
    if (Number.isFinite(c.holderLaunchFeeSol)) $('opt-holder-fee').textContent = c.holderLaunchFeeSol + ' SOL';
    $('opt-holder-soon').hidden = Boolean(c.holderRewards);
    $('opt-airdrop').hidden = !c.airdrop;
  });
  get('/api/boost/config').then(function (b) {
    if (!b || !Array.isArray(b.tiers)) return;
    var ul = $('opt-tiers');
    ul.textContent = '';
    b.tiers.forEach(function (t) { var li = document.createElement('li'); li.textContent = span(t.minutes) + ' for ' + sol(t.sol); ul.appendChild(li); });
    ul.hidden = !b.tiers.length;
    $('opt-boost-text').textContent = 'Or pick your own amount from ' + sol(b.minSol) + ' to ' + sol(b.maxSol) + '. Longer boosts cost more in total and less per hour. There are ' + b.slots + ' slots.';
  });
})();

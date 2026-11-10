// The launch form's choices that change how a coin's money works: who gets the creator fees, and an optional paid boost.
// It only collects and checks the choices. The server checks them again, and the launch transaction carries the boost fee.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var feeBox = $('fee-opt');
  if (!feeBox) return;

  var cfg = { platformPct: 10, maxPartnerPct: 40, holderRewards: false, holderLaunchFeeSol: 0.05 };
  var airdropOn = false;     // the site has the airdrop switched on
  var boost = null;          // /api/boost/config
  var rateToBeat = 0;        // when every slot is taken, the SOL per hour a new boost must beat
  var picked = 0;            // the chosen boost amount in SOL; 0 means none
  var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var platform = (window.PAD && (window.PAD.platform || window.PAD.name)) || 'the platform';

  function mode() { var r = feeBox.querySelector('input[name="feemode"]:checked'); return r ? r.value : 'creator'; }
  function sol(n) { return (Math.round(n * 100) / 100).toFixed(2) + ' SOL'; }
  function span(min) { return min >= 60 ? (Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '')) : min + ' min'; }

  // The same curve the server uses: minutes = baseMin x (sol / baseSol) ^ (1 / exponent), inside the limits.
  function minutesFor(n) {
    if (!boost || !(n >= boost.minSol - 1e-9) || n > boost.maxSol + 1e-9) return 0;
    return Math.max(boost.minMinutes, Math.min(boost.maxMinutes, Math.floor(boost.baseMinutes * Math.pow(n / boost.baseSol, 1 / boost.exponent) + 1e-9)));
  }

  function drawFee() {
    var m = mode();
    $('fo-partner').hidden = m !== 'partner';
    var you = 100 - cfg.platformPct, out = '';
    if (m === 'creator') out = 'You keep ' + you + '% of creator fees and ' + platform + ' takes ' + cfg.platformPct + '%. Payouts are automatic.';
    else if (m === 'partner') {
      var p = Number($('fo-pct').value);
      out = Number.isInteger(p) && p >= 1 && p <= cfg.maxPartnerPct
        ? 'You keep ' + (you - p) + '%, your partner gets ' + p + '%, ' + platform + ' takes ' + cfg.platformPct + '%. Fixed when the coin is created.'
        : 'Choose a whole number from 1 to ' + cfg.maxPartnerPct + ' for your partner\'s share.';
    } else out = 'All creator fees go to the coin\'s holders through pump.fun. You pay a flat ' + cfg.holderLaunchFeeSol + ' SOL to ' + platform + ' when you launch, and cannot buy your own coin in the same step.';
    $('fo-preview').textContent = out;
    $('fo-pct').max = String(cfg.maxPartnerPct);
  }

  function drawBoost() {
    var out = $('bo-preview');
    if (!boost) return;
    if (!picked) { out.textContent = 'No boost. Your coin shows in the normal list of new coins.'; return; }
    var m = minutesFor(picked);
    if (!m) { out.textContent = 'Use an amount from ' + sol(boost.minSol) + ' to ' + sol(boost.maxSol) + '.'; return; }
    var rate = picked / (m / 60);
    var text = sol(picked) + ' puts your coin in the Promoted row for about ' + span(m) + ', ranked at ' + rate.toFixed(3) + ' SOL per hour.';
    if (rateToBeat && rate <= rateToBeat) text += ' All ' + boost.slots + ' slots are taken right now: to show, you need more than ' + rateToBeat + ' SOL per hour. A boost keeps running out its time either way.';
    out.textContent = text;
  }

  function buildTiers() {
    var box = $('bo-tiers');
    box.textContent = '';
    var none = document.createElement('button'); none.type = 'button'; none.className = 'tier on'; none.dataset.sol = '0';
    none.textContent = 'No boost';
    box.appendChild(none);
    boost.tiers.forEach(function (t) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'tier'; b.dataset.sol = String(t.sol);
      b.setAttribute('aria-label', span(t.minutes) + ' for ' + sol(t.sol));
      var a = document.createElement('b'); a.textContent = span(t.minutes);
      var c = document.createElement('i'); c.textContent = sol(t.sol);
      b.appendChild(a); b.appendChild(c); box.appendChild(b);
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tier') : null;
      if (!b) return;
      picked = Number(b.dataset.sol) || 0;
      $('bo-custom').value = '';
      mark(); drawBoost();
    });
    $('bo-custom').min = String(boost.minSol); $('bo-custom').max = String(boost.maxSol);
    $('bo-custom').addEventListener('input', function () {
      var v = Number($('bo-custom').value);
      picked = Number.isFinite(v) && v > 0 ? v : 0;
      mark(); drawBoost();
    });
    $('boost-opt').hidden = false;
    drawBoost();
  }
  function mark() {
    var custom = $('bo-custom').value !== '';
    Array.prototype.forEach.call($('bo-tiers').querySelectorAll('.tier'), function (b) {
      b.classList.toggle('on', !custom && Number(b.dataset.sol) === picked);
      b.setAttribute('aria-pressed', String(!custom && Number(b.dataset.sol) === picked));
    });
  }

  // The airdrop comes out of the first buy, so the box stays off until a "Buy at launch" amount is entered.
  function drawAirdrop() {
    var buy = Number($('l-buy') && $('l-buy').value) || 0;
    $('ad-on').disabled = !(buy > 0);
    $('ad-needs').hidden = buy > 0;
    if (!(buy > 0)) $('ad-on').checked = false;
    var on = $('ad-on').checked;
    $('ad-fields').hidden = !on;
    var out = $('ad-preview');
    if (!on) { out.textContent = buy > 0 ? 'No airdrop.' : ''; return; }
    out.textContent = Number($('ad-pct').value) + '% of the tokens from your first buy go to holders once ' + Number($('ad-holders').value) + ' wallets hold your coin and ' + Number($('ad-minutes').value) + ' minutes have passed, whichever comes last.';
  }
  $('ad-on').addEventListener('change', drawAirdrop);
  if ($('l-buy')) $('l-buy').addEventListener('input', drawAirdrop);
  ['ad-pct', 'ad-holders', 'ad-minutes'].forEach(function (id) { $(id).addEventListener('input', drawAirdrop); });
  drawAirdrop();

  feeBox.addEventListener('change', drawFee);
  $('fo-pct').addEventListener('input', drawFee);

  // What the launch form sends, or why it cannot be sent yet.
  window.APOptions = {
    get: function (creator, firstBuy) {
      var m = mode(), body = { feeMode: m };
      if (m === 'partner') {
        var w = $('fo-wallet').value.trim(), p = Number($('fo-pct').value);
        if (!B58.test(w)) return { ok: false, error: 'Enter your partner\'s Solana wallet address, or choose Creator rewards.' };
        if (creator && w === creator) return { ok: false, error: 'Your partner needs a different wallet from yours.' };
        if (!Number.isInteger(p) || p < 1 || p > cfg.maxPartnerPct) return { ok: false, error: 'Your partner\'s share must be a whole number from 1 to ' + cfg.maxPartnerPct + '.' };
        body.partner = w; body.partnerPct = p;
      }
      if (m === 'holder') {
        if (!cfg.holderRewards) return { ok: false, error: 'Holder rewards are coming soon. Choose Creator rewards for now.' };
        if (firstBuy > 0) return { ok: false, error: 'Holder-rewards coins cannot buy at launch yet. Clear "Buy at launch" or choose Creator rewards.' };
      }
      if (picked) {
        if (!minutesFor(picked)) return { ok: false, error: 'The boost amount must be from ' + sol(boost.minSol) + ' to ' + sol(boost.maxSol) + ', or choose No boost.' };
        body.boostSol = picked;
      }
      if (airdropOn && $('ad-on').checked) {
        var ap = Number($('ad-pct').value), ah = Number($('ad-holders').value), at = Number($('ad-minutes').value);
        if (!(firstBuy > 0)) return { ok: false, error: 'An airdrop comes from your first buy. Enter a "Buy at launch" amount, or turn the airdrop off.' };
        if (m === 'holder') return { ok: false, error: 'Holder-rewards coins cannot have an airdrop. Turn the airdrop off.' };
        if (!Number.isInteger(ap) || ap < 1 || ap > 50) return { ok: false, error: 'The airdrop share must be a whole number from 1 to 50.' };
        if (!Number.isInteger(ah) || ah < 5 || ah > 1000) return { ok: false, error: 'The airdrop holder count must be a whole number from 5 to 1000.' };
        if (!Number.isInteger(at) || at < 1 || at > 10080) return { ok: false, error: 'The airdrop wait must be a whole number of minutes from 1 to 10080 (7 days).' };
        body.airdropPct = ap; body.airdropHolders = ah; body.airdropMinutes = at;
      }
      return { ok: true, body: body };
    }
  };

  fetch('/api/launch/config', { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
    if (c) {
      cfg.platformPct = Number.isFinite(c.platformPct) ? c.platformPct : cfg.platformPct;
      cfg.maxPartnerPct = Number.isFinite(c.maxPartnerPct) ? c.maxPartnerPct : cfg.maxPartnerPct;
      cfg.holderRewards = Boolean(c.holderRewards);
      airdropOn = Boolean(c.airdrop);
      $('airdrop-opt').hidden = !airdropOn;
      cfg.holderLaunchFeeSol = Number.isFinite(c.holderLaunchFeeSol) ? c.holderLaunchFeeSol : cfg.holderLaunchFeeSol;
    }
    $('fo-creator-text').textContent = 'You keep ' + (100 - cfg.platformPct) + '% of creator fees. They are paid out to you automatically.';
    if (!cfg.holderRewards) { $('fo-soon').hidden = false; $('fo-holder').disabled = true; $('fo-holder-row').classList.add('off'); }
    drawFee();
  }).catch(drawFee);

  Promise.all([
    fetch('/api/boost/config', { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }),
    fetch('/api/promoted', { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ]).then(function (r) {
    if (!r[0] || !Array.isArray(r[0].tiers)) return;
    boost = r[0]; rateToBeat = r[1] && Number.isFinite(r[1].rateToBeat) ? r[1].rateToBeat : 0;
    buildTiers();
  }).catch(function () { /* the boost option simply stays hidden */ });
})();

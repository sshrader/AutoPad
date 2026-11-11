/* Devnet launch, page side. After a launch is staged, this connects the creator's wallet, asks the
   server for an unsigned token-launch transaction, and has the wallet sign and send it, then waits
   for the result. The page never sees a private key. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const W = window.AnimalWallet;

  let enabled = false;
  let freeOn = false;
  let split = null; // { creatorPct, platformPct } from the server
  let staged = null;
  let wallet = null; // base58 address once connected
  let busy = false;
  let pending = null; // a launched coin whose later steps are not finished: { data, firstBuy }

  function say(text, bad) {
    const el = $('dl-status');
    el.textContent = text;
    el.className = 'dl-status' + (bad ? ' bad' : '');
  }

  function render() {
    const show = enabled && staged;
    $('devnet-launch').hidden = !show;
    $('dl-hint').hidden = Boolean(show);
    if (!show) return;
    $('dl-connect').hidden = Boolean(wallet);
    $('dl-go').hidden = !wallet;
    $('dl-go').disabled = busy;
    $('dl-connect').disabled = busy;
    const fo = $('free-opt');
    if (fo) { fo.hidden = !freeOn || Boolean(pending); $('fl-go').disabled = busy; }
  }

  function strip(label, value) {
    const d = document.createElement('div');
    d.className = 'castrip';
    const l = document.createElement('span'); l.className = 'calab'; l.textContent = label;
    const c = document.createElement('code'); c.className = 'cavalue'; c.textContent = value;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ca-copy'; b.dataset.ca = value; b.textContent = 'Copy';
    b.setAttribute('aria-label', 'Copy ' + (label === 'CA' ? 'token contract address' : label));
    d.appendChild(l); d.appendChild(c); d.appendChild(b);
    return d;
  }

  function showResult(r, signature) {
    const box = $('dl-result');
    box.innerHTML = '';
    box.appendChild(strip('CA', r.mint));
    const links = document.createElement('div');
    [['Transaction', 'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + AnimalNet.suffix],
     ['Token', 'https://explorer.solana.com/address/' + encodeURIComponent(r.mint) + AnimalNet.suffix]].forEach((x, i) => {
      const a = document.createElement('a');
      a.href = x[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = x[0] + ' ↗';
      if (i) links.appendChild(document.createTextNode('  '));
      links.appendChild(a);
    });
    box.appendChild(links);
    box.hidden = false;
  }

  // Once the launch is finished, a button to the coin's own page.
  function coinLink(pool) {
    const box = $('dl-result');
    if (!pool || box.querySelector('.coin-go')) return;
    const a = document.createElement('a');
    a.className = 'btn go coin-go'; a.href = '/coin/' + encodeURIComponent(pool); a.textContent = 'View your coin';
    const row = document.createElement('div'); row.className = 'row'; row.appendChild(a);
    // On mainnet, a button for GMGN too. On the flagship page it also tries to open it by itself (a browser may block that; the button always works).
    if (AnimalNet.main) {
      const g = 'https://gmgn.ai/sol/token/' + encodeURIComponent(pool);
      const b = document.createElement('a'); b.className = 'btn'; b.href = g; b.target = '_blank'; b.rel = 'noopener noreferrer'; b.textContent = 'Open on GMGN';
      row.appendChild(b);
      if (location.pathname.indexOf('/admin/launch') === 0) { try { window.open(g, '_blank', 'noopener'); } catch (e) { /* the button is there */ } }
    }
    box.appendChild(row); box.hidden = false;
  }

  async function connect() {
    busy = true; render();
    try {
      wallet = await W.connect();
      say('Connected ' + wallet.slice(0, 4) + '…' + wallet.slice(-4) + '.' + (AnimalNet.main ? '' : ' Phantom must be set to Devnet.'));
    } catch (err) {
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : 'Wallet connection was not approved.', true);
    }
    busy = false; render();
  }

  // The coin exists. The rest of the launch is asked for one transaction at a time, from what is on-chain,
  // so it can be picked up again if a step is declined or the tab is closed.
  async function runSteps() {
    const data = pending.data, firstBuy = pending.firstBuy;
    const total = pending.atomic || firstBuy <= 0 ? 2 : 3;
    let done = false;
    for (let round = 0, waits = 0; round < 6 && !done; round++) {
      const sres = await fetch('/api/launch/step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ mint: data.mint, creator: wallet, firstBuySol: firstBuy }, pending.airdrop || {}))
      });
      const next = await sres.json().catch(() => null);
      if (!sres.ok || !next) { say('Your coin was created, but the next step could not be prepared. Press Launch to try again.', true); return; }
      if (next.step === 'waiting') { if (++waits > 10) break; await new Promise(r => setTimeout(r, 2000)); round--; continue; }
      if (next.step === 'done') { done = true; break; }
      const sp = data.split && Number.isFinite(data.split.creatorPct) ? data.split : split;
      say(next.step === 'split'
        ? 'Step 2 of ' + total + ': approve the fee split' + (sp ? ' (you keep ' + sp.creatorPct + '% of creator fees' + (sp.ownerPct ? ', your partner ' + sp.ownerPct + '%' : '') + ', ' + window.PAD.platform + ' ' + sp.platformPct + '%)' : '') + '…'
        : 'Step 3 of ' + total + ': approve your first buy…');
      const sig = await W.signAndSend(next.transaction);
      say('Sent. Waiting for the network to confirm…');
      const st = await W.confirm(sig);
      if (st !== 'confirmed') { say('That step did not confirm. Your coin exists. Press Launch to continue where it stopped.', true); return; }
    }
    const boosted = done ? await startBoost() : null;
    if (done) coinLink(data.pool);
    if (done && boosted !== false) pending = null;
    say(done ? 'Done ✓ Your coin is live.' + (boosted ? ' Your boost has started: it shows in the Promoted row for about ' + boosted + ' min.' : '') + ' Trade it in the card below.' : 'Your coin is live, but a step is still pending. Press Launch to continue.', !done);
    if (done && boosted === false) say('Your coin is live, and your boost payment went through, but it has not started yet. Press Launch to try again.', true);
  }

  // A boost was paid for in the launch transaction. Once that is on-chain the server confirms it and the boost starts.
  // Returns the minutes it runs for, null if there was no boost, or false if it could not be confirmed yet.
  async function startBoost() {
    const data = pending && pending.data;
    if (!data || !data.boost || !pending.signature) return null;
    if (pending.boostMinutes) return pending.boostMinutes;
    for (let i = 0; i < 8; i++) {
      try {
        const res = await fetch('/api/launch/boost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool: data.pool, sig: pending.signature }) });
        const out = await res.json().catch(() => null);
        if (res.ok && out && out.started) { pending.boostMinutes = out.minutes || data.boost.minutes; return pending.boostMinutes; }
        if (!(res.status === 404 || res.status === 502)) return false; // not paid, or something that will not fix itself
      } catch (e) { /* try again */ }
      await new Promise(r => setTimeout(r, 2500));
    }
    return false;
  }

  async function launch() {
    if (!wallet || !staged || busy) return;
    busy = true; render();
    try {
      if (pending) { await runSteps(); busy = false; render(); return; }
      $('dl-result').hidden = true;
      const buyText = $('l-buy').value.trim();
      const firstBuy = buyText === '' ? 0 : Number(buyText);
      if (!Number.isFinite(firstBuy) || firstBuy < 0 || (firstBuy > 0 && (firstBuy < 0.01 || firstBuy > 5))) {
        say('Buy at launch must be left empty, or be from 0.01 to 5 SOL.', true);
        busy = false; render();
        return;
      }
      const needBuy = window.PAD.extra && window.PAD.extra.requireFirstBuy ? window.PAD.extra.minFirstBuySol : 0;
      if (needBuy && !(firstBuy >= needBuy)) {
        say('This launchpad needs you to buy your own coin at launch: at least ' + needBuy + ' SOL.', true);
        busy = false; render();
        return;
      }
      const opt = window.APOptions ? window.APOptions.get(wallet, firstBuy) : { ok: true, body: {} };
      if (!opt.ok) { say(opt.error, true); busy = false; render(); return; }
      const links = {};
      [['website', 'l-web'], ['twitter', 'l-x'], ['telegram', 'l-tg']].forEach(p => { const v = $(p[1]).value.trim(); if (v) links[p[0]] = v; });
      say('Preparing the transaction…');
      const res = await fetch('/api/launch/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ name: staged.name, symbol: staged.symbol, art: staged.art, creator: wallet, links: links, firstBuySol: firstBuy, pad: (window.PAD.extra && window.PAD.extra.slug) || undefined }, opt.body))
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.transaction !== 'string') {
        const by = data && data.by ? ' It matches $' + String(data.by.symbol).slice(0, 10) + ' (' + String(data.by.name).slice(0, 32) + ').' : '';
        const why = { ticker_taken: 'This ticker is already taken on this launchpad. Every coin here must be an original, so pick a different ticker.' + by, name_taken: 'This name is already taken on this launchpad, or is too close to one that is. Pick a different name.' + by, picture_taken: 'This picture is the same as, or very close to, one already launched here. Use your own picture.' + by, picture_required: 'Add a picture for your coin first.', not_allowed: data && data.reason === 'not_listed' ? 'This launchpad is private. Only wallets on its list can launch coins here.' : 'This wallet cannot launch coins on this launchpad.', pair_buy_not_ready: 'Buying your own coin at launch is not available yet on a launchpad with a pool pair other than SOL. Launch without a first buy.', pair_not_found: 'This launchpad\'s pool pair was not found on this network.', holder_not_ready: 'Holder-rewards coins are not switched on for this site yet.', holder_buy_not_ready: 'Buying your own coin at launch is not available yet on a holder-rewards launchpad. Launch without a first buy.', holder_pair_unsupported: 'Holder rewards cannot be combined with a pool pair.', pair_not_ready: 'This launchpad uses a pool pair other than SOL, and launching with a pair is not switched on yet.', first_buy_required: 'This launchpad needs you to buy your own coin at launch: at least ' + ((data && data.min) || 0.05) + ' SOL.', rate_limited: 'Too many launches. Wait a minute.', bad_fee_mode: 'Choose how creator fees are shared.', bad_partner: 'Your partner\'s wallet address is not valid.', partner_is_creator: 'Your partner needs a different wallet from yours.', bad_partner_pct: 'Your partner\'s share must be a whole number' + (data && data.max ? ' from 1 to ' + data.max : '') + '.', bad_airdrop: 'Check the airdrop settings: a share from 1 to 50%, 2 to 1000 holders, and 1 to 10080 minutes.', airdrop_needs_buy: 'An airdrop comes from your first buy. Enter a Buy at launch amount or turn the airdrop off.', airdrop_unavailable: 'Airdrops are not switched on for this site yet.', bad_boost: 'That boost amount is not allowed. Pick one of the options or an amount in range.', bad_name: 'That name is not allowed.', bad_symbol: 'Use 1 to 10 letters or digits for the ticker.', bad_art: 'That picture is no longer available. Make a new one.', bad_amount: 'Buy at launch must be from 0.01 to 5 SOL, or left empty.', bad_links: 'Check your links. A website needs https://, and X takes a handle, a profile link or a post link, and Telegram takes a handle like @yourcoin.', links_locked: 'Your links are locked because a launch was already started with this picture. Put the earlier links back, or draw a new one to change them.', uri_too_long: 'That name is too long.', launch_unavailable: 'Launching is not switched on for this site.', founder_only: 'This picture can only be launched by the ' + window.PAD.platform + ' founder wallet.' };
        say((data && why[data.error]) || 'Could not prepare the launch. Try again.', true);
        busy = false; render();
        return;
      }
      const total = data.atomic || firstBuy <= 0 ? 2 : 3;
      say('Step 1 of ' + total + ': approve creating the coin' + (data.atomic && firstBuy > 0 ? ' and your first buy' : '') + ' in your wallet…');
      const signature = await W.signAndSend(data.transaction);
      showResult(data, signature);
      say('Sent. Waiting for the network to confirm…');
      let state = await W.confirm(signature);
      if (state === 'failed') { say('The transaction failed on-chain. Check the transaction link for the reason. Nothing was created.', true); busy = false; render(); return; }
      if (state !== 'confirmed') { say('Not confirmed yet. Check the transaction link in a minute.', true); busy = false; render(); return; }
      document.dispatchEvent(new CustomEvent('animalpad:launched', { detail: { pool: data.pool } }));
      pending = { data: data, firstBuy: firstBuy, atomic: Boolean(data.atomic), signature: signature, airdrop: data.airdrop ? { airdropPct: data.airdrop.pct, airdropHolders: data.airdrop.holders, airdropMinutes: data.airdrop.minutes } : null };
      await runSteps();
    } catch (err) {
      const m = err && err.message ? String(err.message) : '';
      say(err && err.code === 'no_wallet' ? W.NO_WALLET
        : /reject|denied|cancel/i.test(m) ? 'You declined the transaction.'
        : 'The launch did not go through. Check that your wallet is on ' + (AnimalNet.main ? 'Solana mainnet and has enough SOL.' : 'Devnet and has test SOL.') + (m ? ' Details: ' + m.slice(0, 300) : ''), true);
      console.error('launch error', err);
      if (pending) $('dl-status').textContent += ' Your coin exists. Press Launch to continue where it stopped.';
    }
    busy = false; render();
  }


  // A one-time code launches the coin with no wallet: the server's own wallet pays and signs. It takes about half a minute.
  async function freeLaunch() {
    if (!staged || busy) return;
    const code = $('fl-code').value.trim();
    if (!code) { say('Enter your launch code first.', true); return; }
    busy = true; render();
    $('dl-result').hidden = true;
    say('Launching your coin. This takes about 30 seconds. Please keep this page open…');
    try {
      const links = {};
      [['website', 'l-web'], ['twitter', 'l-x'], ['telegram', 'l-tg']].forEach(p => { const v = $(p[1]).value.trim(); if (v) links[p[0]] = v; });
      const res = await fetch('/api/launch/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, name: staged.name, symbol: staged.symbol, art: staged.art, links: links }) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.mint) {
        const why = { bad_code: 'That code is not valid. It may have been used already, or it has expired.', already_used: 'You have already used your free launch. There is one per visitor.', rate_limited: 'Too many tries. Wait a few minutes.', free_failed: 'The launch did not go through and your code was not used. Try again.', free_partial: 'Your coin was created, but the last step did not finish. Your code is used up. Tell the ' + window.PAD.platform + ' team this address: ' + ((data && data.mint) || ''), bad_name: 'That name is not allowed.', bad_symbol: 'Use 1 to 10 letters or digits for the ticker.', bad_art: 'That picture is no longer available. Make a new one.', bad_links: 'Check your links.', blocked_name: 'That name or ticker is not allowed.', uri_too_long: 'That name is too long.', free_off: 'Free launches are not switched on.' };
        say((data && why[data.error]) || 'Could not launch. Try again.', true);
        busy = false; render();
        return;
      }
      const box = $('dl-result');
      box.innerHTML = '';
      box.appendChild(strip('CA', data.mint));
      const a = document.createElement('a');
      a.href = 'https://explorer.solana.com/address/' + encodeURIComponent(data.mint) + AnimalNet.suffix; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Token ↗';
      box.appendChild(a); box.hidden = false;
      coinLink(data.pool);
      say('Done ✓ Your coin is live. Find it in the coin list.');
      $('fl-code').value = '';
      document.dispatchEvent(new CustomEvent('animalpad:launched', { detail: { pool: data.pool } }));
    } catch (err) {
      say('The launch did not go through. Check your connection and try again.', true);
    }
    busy = false; render();
  }
  if ($('fl-go')) $('fl-go').addEventListener('click', freeLaunch);

  // The owner's box: with the platform wallet connected, make one or several codes here and watch each go from ready to used.
  (function () {
    const box = $('owner-free');
    if (!box) return;
    let admins = [], addr = '', codes = [], timer = null;
    const KEY = 'autopay-free-codes';
    try { codes = JSON.parse(localStorage.getItem(KEY) || '[]'); if (!Array.isArray(codes)) codes = []; } catch (e) { codes = []; }
    const osay = (t, bad) => { const e = $('of-status'); e.textContent = t; e.className = 'dl-status' + (bad ? ' bad' : ''); };
    const LABEL = { ready: 'Ready', working: 'In use right now…', used: 'Used', expired: 'Expired', unknown: 'Expired' };
    function show() {
      box.hidden = !(freeOn && addr && admins.indexOf(addr) !== -1);
    }
    async function poll() {
      clearTimeout(timer);
      if (box.hidden || !codes.length) { $('of-list').textContent = ''; return; }
      const rows = await Promise.all(codes.map(c => fetch('/api/launch/free?code=' + encodeURIComponent(c)).then(x => x.json()).then(r => (r && r.state) || 'unknown').catch(() => 'unknown')));
      const list = $('of-list'); list.textContent = '';
      let again = false;
      codes.forEach((c, i) => {
        const li = document.createElement('li'); li.className = 'row';
        const code = document.createElement('code'); code.className = 'big'; code.textContent = c;
        const st = rows[i]; if (st !== 'ready' && st !== 'working') code.style.textDecoration = 'line-through'; else again = true;
        const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = LABEL[st] || st;
        li.appendChild(code); li.appendChild(badge); list.appendChild(li);
      });
      timer = setTimeout(poll, again ? 8000 : 30000);
    }
    $('of-make').addEventListener('click', async () => {
      try {
        const ts = Date.now(), count = Number($('of-count').value) || 1;
        osay('Approve the signature in your wallet. It does not spend anything.');
        const signature = await W.signMessage('AutoPay: make a one-time free launch code. Wallet: ' + addr + '. Time: ' + ts + (count > 1 ? '. Codes: ' + count : ''));
        const res = await fetch('/api/admin/freecode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: addr, ts: ts, count: count, signature: signature }) });
        const out = await res.json().catch(() => null);
        if (!res.ok || !out || !out.code) { osay(({ too_many_open: 'That would be more than 10 unused codes at once.', not_admin: 'This wallet cannot make codes.', stale: 'Your clock looks off. Try again.', bad_count: 'Pick 1 to 10 codes.' })[out && out.error] || 'Could not make codes.', true); return; }
        codes = (out.codes || [out.code]).concat(codes).slice(0, 30);
        try { localStorage.setItem(KEY, JSON.stringify(codes)); } catch (e) { /* the codes are still on screen */ }
        osay(count > 1 ? 'Made ' + count + ' codes. Each works once.' : 'Made a code. It works once.');
        show(); poll();
      } catch (err) { osay('That was not approved.', true); }
    });
    addr = (W && W.address) || '';
    document.addEventListener('animalpad:wallet', e => { addr = (e.detail && e.detail.address) || ''; show(); poll(); });
    document.addEventListener('animalpad:freeconfig', e => { admins = (e.detail && e.detail.admins) || []; show(); poll(); });
  })();

  document.addEventListener('animalpad:reset', () => { staged = null; pending = null; $('dl-result').hidden = true; say(''); render(); });

  document.addEventListener('animalpad:wallet', e => { wallet = (e.detail && e.detail.address) || null; render(); });
  $('dl-connect').addEventListener('click', connect);
  $('dl-go').addEventListener('click', launch);

  document.addEventListener('animalpad:staged', e => {
    staged = e.detail;
    $('dl-result').hidden = true;
    say('');
    render();
  });

  fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(info => {
      enabled = Boolean(info && info.enabled);
      freeOn = Boolean(info && info.free);
      document.dispatchEvent(new CustomEvent('animalpad:freeconfig', { detail: { admins: (info && info.freeAdmins) || [] } }));
      split = info && info.split ? info.split : null;
      const ex = window.PAD.extra;
      if (split && ex && Number.isInteger(ex.ownerPct) && ex.ownerPct > 0) split = { creatorPct: split.creatorPct - ex.ownerPct, ownerPct: ex.ownerPct, platformPct: split.platformPct };
      render();
    })
    .catch(() => { enabled = false; });
  // "Use this launchpad's link": fills the website with this pad's own address and locks the box while ticked.
  (function () {
    const box = $('l-use-pad'), web = $('l-web'), slug = window.PAD && window.PAD.extra && window.PAD.extra.slug;
    if (!box || !web) return;
    if (!slug) { box.closest('label').hidden = true; return; }
    let before = '';
    box.addEventListener('change', () => {
      if (box.checked) { before = web.value; web.value = location.origin + '/p/' + slug; web.readOnly = true; }
      else { web.readOnly = false; web.value = before; }
    });
  })();
})();

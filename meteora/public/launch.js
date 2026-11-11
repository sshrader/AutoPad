'use strict';
// The launch form: crop the picture, ask the server for a transaction, have the wallet sign it, then wait for the chain.
(function () {
  var W = window.APWallet, cfg = { explorer: 'https://explorer.solana.com', explorerSuffix: '?cluster=devnet', maxBuySol: 2 };
  function $(id) { return document.getElementById(id); }
  var MSG = { bad_name: 'The name must be 1 to 32 characters.', bad_symbol: 'The ticker must be 2 to 10 letters or numbers.', bad_description: 'The description is too long.', bad_link: 'One of the links does not look right. Use a full address like https://yourcoin.com, or leave it empty.', bad_buy: 'Your first buy must be 0, or between 0.01 and the limit.', bad_image: 'Pick a PNG or JPEG picture.', bad_wallet: 'Connect your wallet first.', slow_down: 'Too many tries. Wait a little and try again.', launch_off: 'Launching is not open yet.', launch_failed: 'Could not build the launch. Try again.', too_big: 'That picture is too big.', not_on_chain_yet: 'The launch has not shown up on chain yet.', flagship_first: 'The flagship coin launches first. Launching opens to everyone right after.' };
  function say(t, kind) { var m = $('msg'); m.textContent = t; m.className = 'msg' + (kind ? ' ' + kind : ''); }
  function post(url, body) { return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); }); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function cropImage(file) { // square, middle, 512 px; PNG unless that is big
    return new Promise(function (ok, no) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var c = document.createElement('canvas'); c.width = c.height = 512; var g = c.getContext('2d');
        var s = Math.min(img.naturalWidth, img.naturalHeight), sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
        g.drawImage(img, sx, sy, s, s, 0, 0, 512, 512);
        c.toBlob(function (png) {
          if (png && png.size <= 350000) return ok(png);
          c.toBlob(function (jpg) { jpg ? ok(jpg) : no(new Error('bad_image')); }, 'image/jpeg', 0.85);
        }, 'image/png');
      };
      img.onerror = function () { URL.revokeObjectURL(url); no(new Error('bad_image')); };
      img.src = url;
    });
  }
  function b64(blob) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1] || ''); }; r.onerror = function () { no(new Error('bad_image')); }; r.readAsDataURL(blob); }); }

  $('img').addEventListener('change', function () {
    var f = this.files && this.files[0], p = $('prev');
    if (!f) { p.hidden = true; return; }
    p.src = URL.createObjectURL(f); p.hidden = false;
  });

  $('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var go = $('go'), file = $('img').files && $('img').files[0];
    if (!file) return say('Pick a picture first.', 'bad');
    if (!$('name').value.trim() || !$('sym').value.trim()) return say('Enter a name and a ticker.', 'bad');
    go.disabled = true; say('Getting ready…');
    var wallet, sentSig = '', mint = '', gmgnTab = null;
    // Opened now, while the click still counts, so the browser allows it. It is pointed at GMGN once the coin is confirmed.
    if (cfg.cluster === 'mainnet-beta') {
      try { gmgnTab = window.open('about:blank', '_blank'); if (gmgnTab) { gmgnTab.document.title = 'Launching…'; gmgnTab.document.body.style.cssText = 'font:16px system-ui;padding:2rem'; gmgnTab.document.body.textContent = 'Launching your coin. This tab will open it on GMGN when it is live.'; } } catch (err) { gmgnTab = null; }
    }
    (W.address ? Promise.resolve(W.address) : W.connect()).then(function (a) { wallet = a; return cropImage(file); }).then(b64).then(function (img) {
      return post('/api/launch/prepare', { wallet: wallet, name: $('name').value, symbol: $('sym').value, description: $('desc').value, website: $('web').value, twitter: $('tw').value, telegram: $('tg').value, buySol: Number($('buy').value || 0), image: img });
    }).then(function (out) {
      if (!out.tx) throw new Error(out.error || 'launch_failed');
      mint = out.mint || '';
      say('Approve the transaction in your wallet…');
      return W.signAndSend(out.tx).then(function (sig) { sentSig = sig; return { id: out.id, sig: sig }; });
    }).then(function (r) {
      say('Sent. Waiting for the network…');
      var tries = 0;
      function check() {
        return post('/api/launch/confirm', { id: r.id }).then(function (c) {
          if (c.ok) return r;
          if (++tries > 30) throw new Error('not_on_chain_yet');
          return wait(2000).then(check);
        });
      }
      return check();
    }).then(function (r) {
      var gm = mint && cfg.cluster === 'mainnet-beta' ? 'https://gmgn.ai/sol/token/' + mint : '';
      if (gm && gmgnTab && !gmgnTab.closed) { try { gmgnTab.location.href = gm; } catch (err) { /* the link below still works */ } }
      var m = $('msg'); m.className = 'msg good'; m.textContent = 'Your coin is live. ';
      var a = document.createElement('a'); a.href = '/coin?id=' + encodeURIComponent(r.id); a.textContent = 'View your coin'; m.appendChild(a);
      m.appendChild(document.createTextNode(' · ')); var t = document.createElement('a'); t.href = cfg.explorer + '/tx/' + r.sig + cfg.explorerSuffix; t.target = '_blank'; t.rel = 'noopener'; t.textContent = 'Transaction'; m.appendChild(t);
      if (gm) { m.appendChild(document.createTextNode(' · ')); var g = document.createElement('a'); g.href = gm; g.target = '_blank'; g.rel = 'noopener'; g.textContent = 'Open in GMGN'; m.appendChild(g); }
    }).catch(function (e) {
      try { if (gmgnTab && !gmgnTab.closed) gmgnTab.close(); } catch (err) { /* ignore */ }
      var code = e && (e.code || e.message);
      var shownBy = code;
      say(code === 'no_wallet' ? 'Install the Phantom wallet to continue.' : MSG[code] || (/reject|denied|cancel/i.test(String(e && e.message)) ? 'You cancelled in your wallet. Nothing was spent.' : 'Something went wrong. If your wallet shows a transaction, check it on the explorer.'), 'bad');
      if (sentSig) { var m = $('msg'); m.appendChild(document.createTextNode(' ')); var t = document.createElement('a'); t.href = cfg.explorer + '/tx/' + sentSig + cfg.explorerSuffix; t.target = '_blank'; t.rel = 'noopener'; t.textContent = 'Check your transaction'; m.appendChild(t); }
    }).then(function () { go.disabled = false; });
  });

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c; if (!c.launch) { $('off').hidden = false; $('go').disabled = true; }
    $('buyhint').textContent = 'Optional, up to ' + c.maxBuySol + ' SOL. It happens in the same transaction as the launch, so nobody can get in front of you.';
  }).catch(function () {});
})();

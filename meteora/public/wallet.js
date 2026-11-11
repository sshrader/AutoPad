'use strict';
// Wallet helper (Phantom). The page never sees a private key: the server prepares a transaction, the wallet signs and sends it.
(function () {
  var WEB3 = 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.0/lib/index.iife.min.js';
  var address = null, listeners = [];
  function provider() {
    var p = window.phantom && window.phantom.solana;
    if (p && p.isPhantom) return p;
    if (window.solana && window.solana.isPhantom) return window.solana;
    return null;
  }
  function set(a) { a = a ? String(a) : null; if (a === address) return; address = a; listeners.forEach(function (f) { try { f(address); } catch (e) { /* ignore */ } }); }
  function loadWeb3() {
    if (window.solanaWeb3) return Promise.resolve();
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = WEB3; s.onload = function () { window.solanaWeb3 ? ok() : no(new Error('web3')); }; s.onerror = function () { no(new Error('web3')); }; document.head.appendChild(s);
    });
  }
  var api = {
    get address() { return address; },
    available: function () { return !!provider(); },
    onChange: function (f) { listeners.push(f); f(address); },
    connect: function () {
      var p = provider(); if (!p) { var e = new Error('no_wallet'); e.code = 'no_wallet'; return Promise.reject(e); }
      return p.connect().then(function (r) { set(r && r.publicKey ? r.publicKey : p.publicKey); return address; });
    },
    disconnect: function () { var p = provider(); return Promise.resolve(p && p.disconnect ? p.disconnect() : null).catch(function () {}).then(function () { set(null); }); },
    signAndSend: function (b64) {
      var p = provider(); if (!p) { var e = new Error('no_wallet'); e.code = 'no_wallet'; return Promise.reject(e); }
      return loadWeb3().then(function () {
        var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
        var tx = window.solanaWeb3.VersionedTransaction.deserialize(bytes);
        return p.signAndSendTransaction(tx);
      }).then(function (sent) { return sent && sent.signature ? sent.signature : String(sent); });
    },
  };
  var p = provider();
  if (p && p.on) { p.on('accountChanged', function (pk) { set(pk || null); }); p.on('disconnect', function () { set(null); }); }
  if (p) { try { p.connect({ onlyIfTrusted: true }).then(function (r) { set(r && r.publicKey ? r.publicKey : p.publicKey); }, function () {}); } catch (e) { /* not approved yet */ } }
  window.APWallet = api;
})();

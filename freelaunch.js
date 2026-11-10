'use strict';

// One-time free launches (devnet testing). The owner makes a code on the admin page, signing with the platform wallet.
// Whoever has the code can launch ONE coin without connecting a wallet: the server's own keeper wallet pays for it and is
// the coin's creator, so its creator fees go to the platform side. A code works once and then it is spent.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifySignature } = require('./sigverify');

const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pretty = c => c.slice(0, 4) + '-' + c.slice(4);
const messageFor = (wallet, ts) => 'AutoPay: make a one-time free launch code. Wallet: ' + wallet + '. Time: ' + ts;

function createFreeLaunch(opts) {
  const o = opts || {};
  const launcher = o.launcher;
  const io = o.io;
  const admins = (o.admins || []).filter(Boolean);
  const now = o.now || Date.now;
  const logger = o.logger || console;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const ttlMs = o.ttlMs || 7 * 86400000;
  const maxOpen = o.maxOpen || 10;
  const file = o.file || '';

  let codes = {};
  if (file) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && typeof d === 'object') codes = d; } catch (e) { /* first run */ } }
  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(codes)); fs.renameSync(file + '.tmp', file); }
    catch (e) { logger.error('Free launch codes save failed: ' + (e && e.message)); }
  }
  const live = e => e && !e.usedAt && now() - e.at < ttlMs;

  // Admin: a code, if the signature is from an admin wallet and fresh.
  function issue(b) {
    const wallet = b && typeof b.wallet === 'string' ? b.wallet : '';
    const ts = Number(b && b.ts);
    if (!wallet || admins.indexOf(wallet) === -1) return { status: 403, body: { error: 'not_admin' } };
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > 5 * 60000) return { status: 400, body: { error: 'stale' } };
    if (!verifySignature(wallet, messageFor(wallet, ts), b.signature)) return { status: 401, body: { error: 'bad_signature' } };
    const open = Object.keys(codes).filter(k => live(codes[k]));
    if (open.length >= maxOpen) return { status: 409, body: { error: 'too_many_open' } };
    let code = '';
    for (const x of crypto.randomBytes(8)) code += ALPHA[x % ALPHA.length];
    codes[code] = { at: now() };
    save();
    return { status: 200, body: { code: pretty(code), expiresAt: now() + ttlMs, open: open.length + 1 } };
  }

  const valid = code => live(codes[norm(code)]) && !codes[norm(code)].busy;

  // Launch one coin with a code. `prepare` is the usual launch input without a creator; onPrepared lets the server record the coin.
  async function launch(input, ctx, onPrepared) {
    const key = norm(input && input.code);
    const e = codes[key];
    if (!io || !live(e) || e.busy) return { status: 403, body: { error: 'bad_code' } };
    e.busy = true;
    let mint = '';
    try {
      const body = Object.assign({}, input, { creator: io.payer, firstBuySol: 0 });
      delete body.code; delete body.airdropPct; delete body.boostSol; delete body.feeMode;
      const r = await launcher.prepare(body, ctx);
      if (r.status !== 200) { e.busy = false; return r; }
      mint = r.body.mint;
      if (onPrepared) onPrepared(r.body, io.payer);
      await io.signSend(r.body.transaction);
      for (let i = 0; i < 14; i++) {
        const s = await launcher.step({ mint, creator: io.payer, firstBuySol: 0 }, ctx);
        if (s.status !== 200) throw new Error('step failed: ' + JSON.stringify(s.body));
        if (s.body.step === 'done') break;
        if (s.body.step === 'waiting') { await sleep(1500); continue; }
        await io.signSend(s.body.transaction);
        if (i === 13) throw new Error('fee split did not finish');
      }
      e.usedAt = now(); e.mint = mint; delete e.busy; save();
      return { status: 200, body: { mint, pool: mint, creator: io.payer, cluster: r.body.cluster } };
    } catch (err) {
      logger.error('Free launch failed: ' + (err && err.message));
      delete e.busy;
      // Once the coin exists the code is spent, so it cannot be used to make a second one.
      if (mint) { e.usedAt = now(); e.mint = mint; e.partial = true; save(); return { status: 502, body: { error: 'free_partial', mint } }; }
      return { status: 502, body: { error: 'free_failed' } };
    }
  }

  // What a code is doing, for the page that made it: ready, working, used or expired.
  function status(code) {
    const e = codes[norm(code)];
    if (!e) return 'unknown';
    if (e.usedAt) return 'used';
    if (now() - e.at >= ttlMs) return 'expired';
    return e.busy ? 'working' : 'ready';
  }

  // The newest code is shown to every visitor: one person who uses it gets the free launch, then it reads as used.
  function current() {
    let key = '';
    for (const k of Object.keys(codes)) if (!key || codes[k].at > codes[key].at) key = k;
    if (!key) return { state: 'none' };
    const state = status(key);
    return state === 'ready' || state === 'working' ? { state, code: pretty(key), expiresAt: codes[key].at + ttlMs } : { state, usedAt: codes[key].usedAt || 0 };
  }

  return { issue, launch, valid, status, current, admins, messageFor };
}

module.exports = { createFreeLaunch, messageFor };

'use strict';
// The keeper: AutoPay's auto-claim. Every few minutes it looks at each coin launched here, and when a coin has enough creator
// fees waiting it pays them out to the wallets in that coin's fee split (the creator's share and the platform's share).
//
// It never holds anyone's money. pump.fun's payout is open to any wallet: it can only move fees to the shareholders already
// written on-chain for that coin, and whoever sends it pays the small network fee. The keeper is that wallet. Its secret key
// lives only in the host's settings (KEEPER_SECRET_KEY) and the wallet holds a few cents of SOL for network fees.
const fs = require('fs');
const path = require('path');

const KEEPER_IP = 'keeper'; // the launcher's rate limits are per caller; the keeper is one caller
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Wraps @solana/web3.js into the three things the keeper needs: its address, signing and sending a prepared transaction,
// and its SOL balance. `secret` is the contents of a wallet file: a JSON list of 64 numbers.
function web3Io(opts) {
  const { web3, secret, rpcUrl } = opts;
  let bytes = null;
  const text = String(secret || '').trim();
  try { if (text[0] === '[') bytes = Uint8Array.from(JSON.parse(text)); } catch (e) { bytes = null; }
  if (!bytes || bytes.length !== 64) throw new Error('KEEPER_SECRET_KEY must be the wallet file contents: a list of 64 numbers like [12,34,...].');
  const kp = web3.Keypair.fromSecretKey(bytes);
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  return {
    payer: kp.publicKey.toBase58(),
    async sign(base64) {
      const tx = web3.Transaction.from(Buffer.from(base64, 'base64'));
      tx.partialSign(kp);
      return tx.serialize().toString('base64');
    },
    async send(base64) {
      const raw = Buffer.from(base64, 'base64');
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
      for (let i = 0; i < 30; i++) {
        const st = (await connection.getSignatureStatuses([sig])).value[0];
        if (st && st.err) throw new Error('payout transaction failed on-chain');
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
        await new Promise(r => setTimeout(r, 1500));
      }
      throw new Error('payout transaction was not confirmed in time');
    },
    // Signs a launch transaction (legacy or v0, with other signatures already on it), sends it and waits for it to land.
    async signSend(base64) {
      const vtx = web3.VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
      vtx.sign([kp]);
      return this.send(Buffer.from(vtx.serialize()).toString('base64'));
    },
    async balanceSol() { return (await connection.getBalance(kp.publicKey)) / 1e9; }
  };
}

function createKeeper(opts) {
  const o = opts || {};
  const launcher = o.launcher;
  const launches = o.launches;
  const io = o.io || null;                        // { payer, sign, send, balanceSol }; without it the keeper is off
  const file = o.file || '';
  const now = o.now || Date.now;
  const logger = o.logger || console;
  const minSol = Number.isFinite(o.minSol) && o.minSol > 0 ? o.minSol : 0.02;          // pay out a coin once this much is waiting
  const everyMs = Number.isFinite(o.everyMs) && o.everyMs >= 1000 ? o.everyMs : 15 * 60 * 1000;
  const maxPays = Number.isInteger(o.maxPays) && o.maxPays > 0 ? o.maxPays : 8;        // payouts per run
  const maxChecks = Number.isInteger(o.maxChecks) && o.maxChecks > 0 ? o.maxChecks : 100; // coins looked at per run
  const minGasSol = Number.isFinite(o.minGasSol) ? o.minGasSol : 0.005;                 // stop paying below this keeper balance
  const keep = Number.isInteger(o.keep) && o.keep > 0 ? o.keep : 2000;
  const airdropper = o.airdropper || null;                                          // optional: sends scheduled airdrops each cycle
  const enabled = Boolean(io && launcher && launches && launcher.info().enabled);

  let payouts = [];
  if (file) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(d)) payouts = d.filter(p => p && B58_RE.test(p.pool || '') && Number.isFinite(p.sol) && Number.isFinite(p.at)); } catch (e) { /* first run */ } }
  let totalSol = payouts.reduce((n, p) => n + p.sol, 0);
  const byPool = new Map();
  const tally = p => { const t = byPool.get(p.pool) || { sol: 0, count: 0 }; t.sol += p.sol; t.count++; byPool.set(p.pool, t); };
  payouts.forEach(tally);
  let totalCount = payouts.length;
  let lastRunAt = 0, nextRunAt = 0, lastError = '', lowGas = false, balanceSol = null, running = false, cursor = 0, timer = null;
  let lastRun = { checked: 0, paid: 0, errors: 0 };

  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(payouts)); fs.renameSync(file + '.tmp', file); }
    catch (e) { logger.error('Payout list save failed: ' + (e && e.message)); }
  }

  // One pass over the coins. Safe to call at any time; a second call while one is running does nothing.
  async function run() {
    if (!enabled || running) return lastRun;
    running = true;
    const stats = { checked: 0, paid: 0, errors: 0 };
    try {
      try { balanceSol = await io.balanceSol(); } catch (e) { balanceSol = null; }
      lowGas = balanceSol !== null && balanceSol < minGasSol;
      const list = launches.pools();
      // Start where the last run stopped, so a long list is covered fairly across runs.
      const order = list.length ? list.slice(cursor % list.length).concat(list.slice(0, cursor % list.length)) : [];
      let looked = 0;
      for (const c of order) {
        if (lowGas || stats.paid >= maxPays || looked >= maxChecks) break;
        looked++; stats.checked++;
        const ctx = { ip: KEEPER_IP };
        const f = await launcher.fees(c.pool, ctx);
        if (f.status === 404) continue;                       // not on-chain (yet)
        if (f.status !== 200) { stats.errors++; continue; }
        const b = f.body;
        if (b.holderRewards || !b.splitOk || b.paired) continue; // nothing to pay out, no split yet, or paid in another token
        if (!(b.pendingSol >= minSol)) continue;
        const d = await launcher.distribute({ pool: c.pool, payer: io.payer }, ctx);
        if (d.status === 409) continue;                       // someone paid it first, or it graduated
        if (d.status !== 200) { stats.errors++; lastError = 'prepare ' + (d.body && d.body.error || d.status); continue; }
        try {
          const sig = await io.send(await io.sign(d.body.transaction));
          const sol = Number.isFinite(d.body.waitingSol) ? d.body.waitingSol : b.pendingSol;
          payouts.push({ pool: c.pool, symbol: c.symbol || '', name: c.name || '', sol, shares: (b.shares || []).map(s => ({ address: s.address, pct: s.pct })), sig, at: now() });
          if (payouts.length > keep) payouts = payouts.slice(payouts.length - keep);
          tally(payouts[payouts.length - 1]);
          totalSol += sol; totalCount++; stats.paid++; lastError = '';
          save();
        } catch (e) {
          stats.errors++; lastError = String(e && e.message || 'send failed').slice(0, 120);
          logger.error('Keeper payout failed for ' + c.pool + ': ' + lastError);
        }
      }
      cursor += looked;
      if (airdropper) { try { await airdropper.process(); } catch (e) { logger.error('Airdrop run failed: ' + (e && e.message)); } }
    } catch (e) {
      stats.errors++; lastError = String(e && e.message || 'run failed').slice(0, 120);
      logger.error('Keeper run failed: ' + (e && e.stack ? e.stack : lastError));
    } finally {
      running = false; lastRun = stats; lastRunAt = now(); nextRunAt = timer ? lastRunAt + everyMs : 0;
    }
    return stats;
  }

  function start(firstDelayMs) {
    if (!enabled || timer) return;
    const first = Number.isFinite(firstDelayMs) ? firstDelayMs : 60000;
    nextRunAt = now() + first;
    const tick = () => { run().finally(() => { nextRunAt = now() + everyMs; timer = setTimeout(tick, everyMs); if (timer.unref) timer.unref(); }); };
    timer = setTimeout(tick, first);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearTimeout(timer); timer = null; nextRunAt = 0; }

  // What the site shows: no secrets, only the keeper's public address and its numbers.
  function status() {
    return { enabled, address: enabled ? io.payer : '', balanceSol, lowGas, minSol, everyMin: Math.round(everyMs / 60000), lastRunAt, nextRunAt, lastRun, lastError: lastError ? 'last payout attempt failed' : '', totalPaidSol: Math.round(totalSol * 1e6) / 1e6, payouts: totalCount };
  }
  function recent(limit, pool) {
    const n = Math.max(1, Math.min(50, Number(limit) || 20));
    return payouts.filter(p => !pool || p.pool === pool).slice(-n).reverse();
  }
  // What the keeper has paid out per coin: { sol, count }, from the saved payout list.
  const paidOf = pool => byPool.get(pool) || { sol: 0, count: 0 };
  return { run, start, stop, status, recent, paidOf, enabled };
}

module.exports = { createKeeper, web3Io };

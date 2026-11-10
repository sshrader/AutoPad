'use strict';
// Auto airdrop: a creator can set aside a share of their first buy to be sent to the coin's holders later, once a set time
// has passed AND a set number of holders exist.
//
// How it stays non-custodial: at launch the creator's wallet signs a Token-2022 "approve" that lets the keeper wallet move up
// to that many tokens out of the creator's own token account. The tokens stay in the creator's wallet until the keeper sends
// them. This is NOT a lock: the creator can sell the tokens or revoke the approval at any time, and then nothing is sent.
const fs = require('fs');
const path = require('path');

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LIMITS = { minPct: 1, maxPct: 50, minHolders: 2, maxHolders: 1000, minMinutes: 1, maxMinutes: 10080 };

// Reads the first 165 bytes of a token account (the layout every Token-2022 account starts with).
function parseTokenAccount(data) {
  const b = Buffer.from(data);
  if (b.length < 165) return null;
  const hasDelegate = b.readUInt32LE(72) === 1;
  return {
    mint: b.subarray(0, 32), owner: b.subarray(32, 64), amount: b.readBigUInt64LE(64),
    delegate: hasDelegate ? b.subarray(76, 108) : null, delegatedAmount: b.readBigUInt64LE(121), state: b[108]
  };
}

// Splits `total` between holders in proportion to their balances. Whole units only; the leftover goes to the largest
// remainders, so the parts always add up to exactly `total`. Input: [{ key, weight: BigInt }]. Output: [{ key, amount: BigInt }].
function allocate(total, holders) {
  const t = BigInt(total);
  const list = holders.filter(h => BigInt(h.weight) > 0n);
  const sum = list.reduce((n, h) => n + BigInt(h.weight), 0n);
  if (t <= 0n || sum === 0n) return [];
  const rows = list.map((h, i) => {
    const w = BigInt(h.weight), q = (t * w) / sum, r = (t * w) % sum;
    return { key: h.key, amount: q, rem: r, i };
  });
  let left = t - rows.reduce((n, r) => n + r.amount, 0n);
  rows.slice().sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1)).forEach(r => { if (left > 0n) { r.amount += 1n; left -= 1n; } });
  return rows.filter(r => r.amount > 0n).map(r => ({ key: r.key, amount: r.amount }));
}

// What the launch form asks for, checked. Returns { pct, holders, minutes } or null if absent, or false if wrong.
function parseSettings(b) {
  const has = x => x !== undefined && x !== null && x !== '';
  if (!has(b.airdropPct)) return null;
  const pct = Number(b.airdropPct), holders = Number(b.airdropHolders), minutes = Number(b.airdropMinutes);
  if (!Number.isInteger(pct) || pct < LIMITS.minPct || pct > LIMITS.maxPct) return false;
  if (!Number.isInteger(holders) || holders < LIMITS.minHolders || holders > LIMITS.maxHolders) return false;
  if (!Number.isInteger(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) return false;
  return { pct, holders, minutes };
}

// The list of airdrops, saved to a file so a restart keeps them.
function createAirdrops(opts) {
  const o = opts || {};
  const file = o.file || '';
  const jobs = new Map();
  if (file) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d)) d.forEach(j => { if (j && B58_RE.test(j.pool || '')) jobs.set(j.pool, j); });
    } catch (e) { /* first run */ }
  }
  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(Array.from(jobs.values()))); fs.renameSync(file + '.tmp', file); }
    catch (e) { (o.logger || console).error('Airdrop list save failed: ' + (e && e.message)); }
  }
  return {
    add(j) {
      if (!j || !B58_RE.test(j.pool || '') || jobs.has(j.pool)) return null;
      const job = { pool: j.pool, creator: j.creator, pct: j.pct, minHolders: j.minHolders, afterMinutes: j.afterMinutes, tokens: String(j.tokens || '0'), createdAt: j.createdAt, status: 'scheduled', reason: '', holders: 0, checkedAt: 0, tries: 0 };
      jobs.set(job.pool, job); save(); return job;
    },
    get(pool) { return jobs.get(pool) || null; },
    list() { return Array.from(jobs.values()); },
    update(pool, patch) { const j = jobs.get(pool); if (!j) return null; Object.assign(j, patch); save(); return j; }
  };
}

// The part the keeper runs each cycle. `launcher` supplies chain reads and unsigned transfer transactions; `io` is the keeper wallet.
function createAirdropper(opts) {
  const o = opts || {};
  const { store, launcher, io } = o;
  const now = o.now || Date.now;
  const logger = o.logger || console;
  const minHold = BigInt(o.minHold === undefined ? 100000000000n : o.minHold);   // raw units (6 decimals): 100,000 tokens
  const batch = Number.isInteger(o.batch) && o.batch > 0 ? o.batch : 10;
  const maxJobs = Number.isInteger(o.maxJobs) && o.maxJobs > 0 ? o.maxJobs : 3;
  const maxTries = Number.isInteger(o.maxTries) && o.maxTries > 0 ? o.maxTries : 20;
  const minGasSol = Number.isFinite(o.minGasSol) ? o.minGasSol : 0.005;
  const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : 60 * 60 * 1000;   // time allowed for the launch to land before an approval counts as missing

  // What the keeper can really move: the approval, but never more than the creator still holds. (Selling the tokens leaves the
  // approval number in place, so the balance is the limit.)
  const live = a => {
    if (!a || a.delegate !== io.payer) return 0n;
    return typeof a.amount === 'bigint' && a.amount < a.delegatedAmount ? a.amount : a.delegatedAmount;
  };

  // One airdrop. Returns nothing; it records its own result.
  async function work(job) {
    const due = job.createdAt + job.afterMinutes * 60000;
    if (now() < due) return;
    const info = await launcher.airdropInfo(job.pool, job.creator);
    if (!info) { fail(job, 'chain read failed', true); return; }
    const mine = info.accounts.find(a => a.owner === job.creator);
    const approved = live(mine);
    const planned = Array.isArray(job.plan) && job.plan.length > 0;
    if (!planned) {
      if (!mine || approved === 0n) {
        if (now() < job.createdAt + graceMs) return;       // the launch may still be landing
        return finish(job, 'failed', 'The creator sold or cancelled the airdrop before it was due.');
      }
      if (info.complete === false) {
        // The RPC could only list the biggest holders, so a fair split between everyone is not possible. Say why and wait.
        store.update(job.pool, { reason: 'Waiting: the RPC cannot list every holder. Set LAUNCH_RPC_URL to a provider that can (for example Helius).', checkedAt: now() });
        return;
      }
      if (job.reason) store.update(job.pool, { reason: '' });
      const skip = new Set([job.creator, io.payer, info.curve, o.platformWallet].filter(Boolean));
      const eligible = info.accounts.filter(a => !skip.has(a.owner) && a.amount >= minHold);
      store.update(job.pool, { holders: eligible.length, checkedAt: now() });
      if (eligible.length < job.minHolders) return;       // not enough holders yet: wait
      const amount = approved < mine.amount ? approved : mine.amount;
      if (amount <= 0n) return finish(job, 'failed', 'Nothing left to send.');
      const parts = allocate(amount, eligible.map(a => ({ key: a.account, weight: a.amount })));
      if (!parts.length) return finish(job, 'failed', 'Nothing left to send.');
      store.update(job.pool, { plan: parts.map(p => ({ to: p.key, amount: p.amount.toString() })), sent: 0, approvedStart: approved.toString(), source: mine.account, status: 'sending' });
      job = store.get(job.pool);
    }
    // Send the plan in batches. Before each batch, check it did not already land on an earlier try that looked like a failure.
    let sent = job.sent || 0;
    let expected = BigInt(job.approvedStart);
    for (let i = 0; i < sent * batch && i < job.plan.length; i++) expected -= BigInt(job.plan[i].amount);
    const batches = Math.ceil(job.plan.length / batch);
    const sigs = (job.sigs || []).slice();
    while (sent < batches) {
      const part = job.plan.slice(sent * batch, sent * batch + batch);
      const sum = part.reduce((n, p) => n + BigInt(p.amount), 0n);
      const nowLive = live((await launcher.airdropInfo(job.pool, job.creator) || { accounts: [] }).accounts.find(a => a.owner === job.creator));
      if (nowLive <= expected - sum) { sent++; expected -= sum; store.update(job.pool, { sent }); continue; }   // it landed
      if (nowLive < sum) return finish(job, 'failed', 'The creator sold or cancelled part of the airdrop. ' + sent + ' of ' + batches + ' batches were sent.');
      const txs = await launcher.airdropTransactions({ mint: job.pool, creator: job.creator, source: job.source, keeper: io.payer, recipients: part });
      const sig = await io.send(await io.sign(txs[0]));
      sigs.push(sig); sent++; expected -= sum;
      store.update(job.pool, { sent, sigs });
    }
    store.update(job.pool, { status: 'done', reason: '', finishedAt: now(), delivered: job.plan.reduce((n, p) => n + BigInt(p.amount), 0n).toString(), recipients: job.plan.length });
  }

  function finish(job, status, reason) { store.update(job.pool, { status, reason, finishedAt: now() }); }
  function fail(job, reason, retry) {
    const tries = (job.tries || 0) + 1;
    if (retry && tries < maxTries) store.update(job.pool, { tries }); else store.update(job.pool, { tries, status: 'failed', reason, finishedAt: now() });
  }

  async function process() {
    if (!io || !launcher || !store) return { checked: 0 };
    let bal = null;
    try { bal = await io.balanceSol(); } catch (e) { bal = null; }
    if (bal !== null && bal < minGasSol) return { checked: 0, lowGas: true };
    const list = store.list().filter(j => j.status === 'scheduled' || j.status === 'sending').slice(0, maxJobs);
    for (const j of list) {
      try { await work(j); }
      catch (e) {
        logger.error('Airdrop failed for ' + j.pool + ': ' + (e && e.message));
        const cur = store.get(j.pool);
        if (cur && cur.status !== 'sending') fail(cur, 'The airdrop could not be sent.', true);
        else store.update(j.pool, { tries: (cur.tries || 0) + 1, status: (cur.tries || 0) + 1 >= maxTries ? 'failed' : 'sending', reason: (cur.tries || 0) + 1 >= maxTries ? 'The airdrop could not be sent.' : '' });
      }
    }
    return { checked: list.length };
  }
  return { process, work };
}

module.exports = { parseTokenAccount, allocate, parseSettings, createAirdrops, createAirdropper, LIMITS };

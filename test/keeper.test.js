'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKeeper } = require('../keeper');

const A = 'So11111111111111111111111111111111111111112', B = 'Vote111111111111111111111111111111111111111', C = 'Stake11111111111111111111111111111111111111';
const PAYER = '11111111111111111111111111111111';
const quiet = { error() {}, log() {} };

function setup(over) {
  const o = over || {};
  const coins = o.coins || [{ pool: A, symbol: 'AAA', name: 'Aaa', creator: PAYER }];
  const fees = o.fees || {};          // pool -> fees() result body or { status }
  const calls = { fees: [], distribute: [], sent: [] };
  const launcher = {
    info: () => ({ enabled: true }),
    async fees(pool, ctx) { calls.fees.push([pool, ctx.ip]); const f = fees[pool]; return f && f.status ? f : { status: 200, body: Object.assign({ splitOk: true, pendingSol: 0, shares: [{ address: PAYER, pct: 90 }, { address: B, pct: 10 }] }, f) }; },
    async distribute(input, ctx) { calls.distribute.push([input.pool, input.payer, ctx.ip]); return o.distribute ? o.distribute(input) : { status: 200, body: { transaction: 'tx-' + input.pool, waitingSol: (fees[input.pool] || {}).pendingSol } }; }
  };
  const launches = { pools: () => coins };
  const io = { payer: PAYER, async sign(t) { return 'signed-' + t; }, async send(t) { calls.sent.push(t); if (o.sendFails) throw new Error('boom'); return 'sig-' + t; }, async balanceSol() { return o.balance === undefined ? 1 : o.balance; } };
  const keeper = createKeeper(Object.assign({ launcher, launches, io, logger: quiet }, o.keeper || {}));
  return { keeper, calls };
}

test('pays out a coin once enough is waiting, as the keeper wallet, and records it', async () => {
  const { keeper, calls } = setup({ fees: { [A]: { pendingSol: 0.5 } } });
  const r = await keeper.run();
  assert.equal(r.paid, 1);
  assert.deepEqual(calls.distribute, [[A, PAYER, 'keeper']]);
  assert.deepEqual(calls.sent, ['signed-tx-' + A]);
  const p = keeper.recent(5)[0];
  assert.equal(p.pool, A); assert.equal(p.sol, 0.5); assert.equal(p.sig, 'sig-signed-tx-' + A);
  assert.deepEqual(p.shares.map(s => s.pct), [90, 10]);
  assert.equal(keeper.status().totalPaidSol, 0.5);
  assert.equal(keeper.status().payouts, 1);
});

test('leaves a coin alone when less than the minimum is waiting', async () => {
  const { keeper, calls } = setup({ fees: { [A]: { pendingSol: 0.005 } } });
  assert.equal((await keeper.run()).paid, 0);
  assert.equal(calls.distribute.length, 0);
});

test('skips holder-rewards coins, coins with no split yet, paired coins and coins that are not on-chain', async () => {
  const coins = [A, B, C, 'Sysvar1111111111111111111111111111111111111'].map(pool => ({ pool, symbol: 'X', name: 'X', creator: PAYER }));
  const { keeper, calls } = setup({ coins, fees: {
    [A]: { holderRewards: true, pendingSol: 1 }, [B]: { splitOk: false, pendingSol: 1 }, [C]: { paired: true, pendingSol: 1 },
    Sysvar1111111111111111111111111111111111111: { status: 404, body: { error: 'pool_not_found' } } } });
  const r = await keeper.run();
  assert.equal(r.paid, 0); assert.equal(r.errors, 0); assert.equal(calls.distribute.length, 0);
});

test('a coin someone already paid out (409) is not an error', async () => {
  const { keeper } = setup({ fees: { [A]: { pendingSol: 1 } }, distribute: () => ({ status: 409, body: { error: 'nothing_to_claim' } }) });
  const r = await keeper.run();
  assert.equal(r.paid, 0); assert.equal(r.errors, 0);
});

test('a failed send is counted, reported without details, and the next coin still runs', async () => {
  const coins = [A, B].map(pool => ({ pool, symbol: 'X', name: 'X', creator: PAYER }));
  const { keeper } = setup({ coins, fees: { [A]: { pendingSol: 1 }, [B]: { pendingSol: 1 } }, sendFails: true });
  const r = await keeper.run();
  assert.equal(r.errors, 2); assert.equal(r.paid, 0);
  assert.equal(keeper.status().lastError, 'last payout attempt failed');
  assert.equal(keeper.recent(5).length, 0);
});

test('stops paying when the keeper wallet is nearly out of SOL, and says so', async () => {
  const { keeper, calls } = setup({ fees: { [A]: { pendingSol: 1 } }, balance: 0.001 });
  const r = await keeper.run();
  assert.equal(r.paid, 0); assert.equal(calls.distribute.length, 0);
  assert.equal(keeper.status().lowGas, true);
});

test('pays at most maxPays coins in a run and carries on from there next run', async () => {
  const pools = [A, B, C];
  const coins = pools.map(pool => ({ pool, symbol: 'X', name: 'X', creator: PAYER }));
  const fees = {}; pools.forEach(p => { fees[p] = { pendingSol: 1 }; });
  // Like the chain, a coin has nothing waiting once it has been paid out.
  const distribute = input => { const w = fees[input.pool].pendingSol; fees[input.pool].pendingSol = 0; return { status: 200, body: { transaction: 'tx-' + input.pool, waitingSol: w } }; };
  const { keeper, calls } = setup({ coins, fees, distribute, keeper: { maxPays: 2, maxChecks: 2 } });
  assert.equal((await keeper.run()).paid, 2);
  assert.equal((await keeper.run()).paid, 1); // the third coin is reached next
  assert.ok(calls.distribute.some(c => c[0] === C));
});

test('without a wallet the keeper is off and does nothing', async () => {
  const { calls } = setup();
  const off = createKeeper({ launcher: { info: () => ({ enabled: true }) }, launches: { pools: () => [] }, logger: quiet });
  assert.equal(off.status().enabled, false);
  await off.run(); off.start();
  assert.equal(calls.sent.length, 0);
});

test('the status shows the keeper address but nothing secret', async () => {
  const { keeper } = setup();
  await keeper.run();
  const s = keeper.status();
  assert.equal(s.address, PAYER);
  assert.deepEqual(Object.keys(s).sort(), ['address', 'balanceSol', 'enabled', 'everyMin', 'lastError', 'lastRun', 'lastRunAt', 'lowGas', 'minSol', 'nextRunAt', 'payouts', 'totalPaidSol']);
});

test('payouts survive a restart when a file is given', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-')), 'payouts.json');
  const one = setup({ fees: { [A]: { pendingSol: 0.25 } }, keeper: { file } });
  await one.keeper.run();
  const two = setup({ keeper: { file } });
  assert.equal(two.keeper.status().payouts, 1);
  assert.equal(two.keeper.status().totalPaidSol, 0.25);
  assert.equal(two.keeper.recent(5, A).length, 1);
});

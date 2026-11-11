import test from 'node:test';
import assert from 'node:assert/strict';
import { runClaims } from '../claimer.mjs';

const fake = (fees, calls = []) => ({
  fees: async () => fees,
  claimCreator: async (pool, to) => { calls.push(['creator', pool, to]); return 'sigC'; },
  claimPartner: async (pool, to) => { calls.push(['partner', pool, to]); return 'sigP'; },
});
const coin = { id: 'flagship', symbol: 'AUTO', pool: 'POOL', creator: 'CREATOR', simulated: false };

test('dry run reports fees and sends nothing', async () => {
  const calls = [];
  const out = await runClaims({ chain: fake({ creatorPending: 900, partnerPending: 100 }, calls), coins: [coin], platformWallet: 'PLAT', send: false });
  assert.equal(calls.length, 0);
  assert.equal(out[0].mode, 'dry');
  assert.equal(out[0].creatorLamports, 900);
  assert.equal(out[0].platformLamports, 100);
});

test('send pays the creator wallet and the platform wallet', async () => {
  const calls = [];
  const out = await runClaims({ chain: fake({ creatorPending: 900, partnerPending: 100 }, calls), coins: [coin], platformWallet: 'PLAT', send: true });
  assert.deepEqual(calls, [['creator', 'POOL', 'CREATOR'], ['partner', 'POOL', 'PLAT']]);
  assert.equal(out[0].creatorTx, 'sigC');
  assert.equal(out[0].platformTx, 'sigP');
});

test('skips demo coins, unlaunched coins, and amounts under the minimum', async () => {
  const calls = [];
  const coins = [{ ...coin, simulated: true }, { ...coin, id: 'x', pool: '' }, coin];
  const out = await runClaims({ chain: fake({ creatorPending: 5, partnerPending: 5 }, calls), coins, platformWallet: 'PLAT', minLamports: 100, send: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].skipped, 'below_minimum');
  assert.equal(calls.length, 0);
});

test('a failing coin is logged, not thrown', async () => {
  const chain = { fees: async () => { throw new Error('rpc down'); } };
  const out = await runClaims({ chain, coins: [coin], platformWallet: 'PLAT', send: true });
  assert.match(out[0].error, /rpc down/);
});

test('only claims the side that has fees', async () => {
  const calls = [];
  await runClaims({ chain: fake({ creatorPending: 0, partnerPending: 50 }, calls), coins: [coin], platformWallet: 'PLAT', send: true });
  assert.deepEqual(calls, [['partner', 'POOL', 'PLAT']]);
});

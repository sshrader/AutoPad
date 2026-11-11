import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

const A = '2H9r5ik8nqxkkr3tNtjW4KijXBygcRy7wNAGAmrTMxZ';
const B = '6MC8oeNvL4LQDXcxCQzzcoKpVsrbY3UJMYeKVQ5ew6TV';
const C = 'G1chTc2mCXttJdrvF2qRU5oaemmfkVjJudLGF4KNAEhK';

async function serve(vars, chain) {
  const e = (n, d = '') => String(vars[n] ?? d);
  const srv = http.createServer(createApp({ e, chain, dataDir: '/nonexistent' }));
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { base, close: () => srv.close() };
}
const chain = {
  poolInfo: async () => ({ quoteReserveSol: 12.5, isMigrated: false, progress: 8.4 }),
  fees: async () => ({ creatorPending: 900000, partnerPending: 100000, totalCollected: 5000000 }),
};

test('flagship is first and honest before launch', async () => {
  const s = await serve({ CLUSTER: 'mainnet-beta' });
  const coins = await (await fetch(s.base + '/api/coins')).json();
  assert.equal(coins[0].id, 'flagship');
  assert.equal(coins[0].launched, false);
  assert.equal(coins[0].live, null);
  assert.ok(coins.slice(1).every(c => c.simulated === true && c.launched === true && c.stats));
  s.close();
});

test('launched flagship shows live numbers from the chain', async () => {
  const s = await serve({ FLAGSHIP_CREATOR: A, FLAGSHIP_MINT: B, FLAGSHIP_POOL: C }, chain);
  const coins = await (await fetch(s.base + '/api/coins')).json();
  assert.equal(coins[0].launched, true);
  assert.equal(coins[0].live.collectedSol, 0.005);
  assert.equal(coins[0].live.pendingCreatorSol, 0.0009);
  assert.equal(coins[0].live.progress, 8.4);
  s.close();
});

test('a chain failure hides live numbers instead of breaking the page', async () => {
  const bad = { poolInfo: async () => { throw new Error('x'); }, fees: async () => ({}) };
  const s = await serve({ FLAGSHIP_CREATOR: A, FLAGSHIP_MINT: B, FLAGSHIP_POOL: C }, bad);
  const r = await fetch(s.base + '/api/coins/flagship');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).live, null);
  s.close();
});

test('serves metadata for the launch and pages, rejects writes and path tricks', async () => {
  const s = await serve({ SITE_URL: 'https://example.test/', FLAGSHIP_SYMBOL: 'AUTO' });
  const meta = await (await fetch(s.base + '/meta/flagship.json')).json();
  assert.equal(meta.symbol, 'AUTO');
  assert.equal(meta.image, 'https://example.test/flagship.png');
  assert.equal((await fetch(s.base + '/')).status, 200);
  assert.equal((await fetch(s.base + '/coin?id=flagship')).status, 200);
  assert.equal((await fetch(s.base + '/api/coins/nope')).status, 404);
  assert.equal((await fetch(s.base + '/api/coins', { method: 'POST' })).status, 404);
  assert.equal((await fetch(s.base + '/api/coins', { method: 'PUT' })).status, 405);
  assert.equal((await fetch(s.base + '/..%2fserver.mjs')).status, 404);
  assert.equal((await fetch(s.base + '/%2e%2e/server.mjs')).status, 404);
  s.close();
});

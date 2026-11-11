import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('claim button: claims for a launched coin, then waits for the cooldown', async () => {
  const sent = [];
  const ch = { ...chain, claimCreator: async (pool, to) => { sent.push(['c', to]); return 'TXC'; }, claimPartner: async (pool, to) => { sent.push(['p', to]); return 'TXP'; } };
  const vars = { FLAGSHIP_CREATOR: A, FLAGSHIP_MINT: B, FLAGSHIP_POOL: C, PLATFORM_WALLET: B };
  const e = (n, d = '') => String(vars[n] ?? d);
  const srv = http.createServer(createApp({ e, chain: ch, canClaim: true, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'k-')) }));
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = body => fetch(base + '/api/claim', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await (await fetch(base + '/api/config')).json()).claim, true);
  const r1 = await post({ id: 'flagship' }); const j1 = await r1.json();
  assert.equal(r1.status, 200); assert.equal(j1.creatorTx, 'TXC');
  assert.deepEqual(sent, [['c', A], ['p', B]]);
  assert.equal((await post({ id: 'flagship' })).status, 429);
  assert.equal((await post({ id: 'paycat' })).status, 404);
  srv.close();
});

test('claim button is off without the keeper', async () => {
  const s = await serve({ FLAGSHIP_CREATOR: A, FLAGSHIP_MINT: B, FLAGSHIP_POOL: C, PLATFORM_WALLET: B }, chain);
  assert.equal((await fetch(s.base + '/api/claim', { method: 'POST', body: '{}' })).status, 403);
  s.close();
});

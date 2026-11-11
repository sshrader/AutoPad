import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { createStore } from '../store.mjs';
import { checkLaunch, checkTrade, createLimiter } from '../launchcheck.mjs';

const W = '2H9r5ik8nqxkkr3tNtjW4KijXBygcRy7wNAGAmrTMxZ';
const CFG = '6MC8oeNvL4LQDXcxCQzzcoKpVsrbY3UJMYeKVQ5ew6TV';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString('base64');
const good = { wallet: W, name: 'Pay Dog', symbol: '$paydog', description: 'hi', buySol: 0.1, image: PNG };

test('checkLaunch accepts a good launch and cleans it', () => {
  const r = checkLaunch(good);
  assert.equal(r.ok.symbol, 'PAYDOG');
  assert.equal(r.ok.ext, 'png');
  assert.equal(r.ok.buySol, 0.1);
});

test('checkLaunch rejects bad input', () => {
  const bad = patch => checkLaunch({ ...good, ...patch }).error;
  assert.equal(bad({ wallet: 'nope' }), 'bad_wallet');
  assert.equal(bad({ name: '' }), 'bad_name');
  assert.equal(bad({ name: 'x'.repeat(33) }), 'bad_name');
  assert.equal(bad({ symbol: 'A' }), 'bad_symbol');
  assert.equal(bad({ symbol: 'BAD SYM' }), 'bad_symbol');
  assert.equal(bad({ buySol: 5 }), 'bad_buy');
  assert.equal(bad({ buySol: 0.001 }), 'bad_buy');
  assert.equal(bad({ buySol: -1 }), 'bad_buy');
  assert.equal(bad({ image: Buffer.from('<svg onload=alert(1)>').toString('base64') }), 'bad_image');
  assert.equal(bad({ image: '' }), 'bad_image');
  assert.equal(bad({ description: 'x'.repeat(201) }), 'bad_description');
  assert.equal(checkLaunch({ ...good, name: 'A<b>B' }).ok.name, 'AbB'); // angle brackets are stripped
});

test('checkTrade checks side and amounts', () => {
  assert.ok(checkTrade({ wallet: W, pool: CFG, side: 'buy', amount: 0.5 }).ok);
  assert.ok(checkTrade({ wallet: W, pool: CFG, side: 'sell', amount: 50 }).ok);
  assert.equal(checkTrade({ wallet: W, pool: CFG, side: 'sell', amount: 150 }).error, 'bad_amount');
  assert.equal(checkTrade({ wallet: W, pool: CFG, side: 'buy', amount: 0 }).error, 'bad_amount');
  assert.equal(checkTrade({ wallet: W, pool: CFG, side: 'steal', amount: 1 }).error, 'bad_request');
});

test('limiter blocks after the cap and frees up later', () => {
  let t = 0; const lim = createLimiter({ now: () => t });
  assert.ok(lim('a', 2, 1000)); assert.ok(lim('a', 2, 1000)); assert.equal(lim('a', 2, 1000), false);
  assert.ok(lim('b', 2, 1000));
  t = 2000; assert.ok(lim('a', 2, 1000));
});

async function serve(vars, chain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
  const e = (n, d = '') => String(vars[n] ?? d);
  const store = createStore({ dir });
  const srv = http.createServer(createApp({ e, chain, store, dataDir: dir, rand: () => 'ab12' }));
  await new Promise(r => srv.listen(0, r));
  return { base: 'http://127.0.0.1:' + srv.address().port, store, close: () => srv.close() };
}
const post = (s, p, body) => fetch(s.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fake = (over = {}) => ({
  poolInfo: async () => ({ quoteReserveSol: 1, isMigrated: false, progress: 1 }),
  fees: async () => ({ creatorPending: 0, partnerPending: 0, totalCollected: 0 }),
  prepareLaunch: async () => ({ tx: 'dHg=', mint: CFG, pool: W }),
  confirmLaunch: async () => true,
  prepareSwap: async () => ({ tx: 'dHg=', amountIn: '1', minOut: '1' }),
  ...over,
});
const ON = { LAUNCH: 'yes', DBC_CONFIG: CFG, SITE_URL: 'https://x.test' };

test('launch is refused unless switched on', async () => {
  const s = await serve({}, fake());
  assert.equal((await post(s, '/api/launch/prepare', good)).status, 403);
  assert.equal((await (await fetch(s.base + '/api/config')).json()).launch, false);
  s.close();
});

test('launch: prepare, then confirm lists the coin with its metadata and image', async () => {
  const s = await serve(ON, fake());
  const r = await post(s, '/api/launch/prepare', good);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.id, 'paydog-ab12');
  // not listed until confirmed
  assert.equal((await (await fetch(s.base + '/api/coins')).json()).some(c => c.id === out.id), false);
  const meta = await (await fetch(s.base + '/meta/' + out.id + '.json')).json();
  assert.equal(meta.name, 'Pay Dog');
  assert.equal(meta.image, 'https://x.test/img/paydog-ab12.png');
  assert.equal((await fetch(s.base + '/img/paydog-ab12.png')).headers.get('content-type'), 'image/png');
  assert.equal((await post(s, '/api/launch/confirm', { id: out.id })).status, 200);
  const coins = await (await fetch(s.base + '/api/coins')).json();
  assert.equal(coins[1].id, 'paydog-ab12');
  assert.equal(coins[1].creator, W);
  s.close();
});

test('confirm refuses a launch that is not on chain', async () => {
  const s = await serve(ON, fake({ confirmLaunch: async () => false }));
  const out = await (await post(s, '/api/launch/prepare', good)).json();
  assert.equal((await post(s, '/api/launch/confirm', { id: out.id })).status, 409);
  assert.equal((await post(s, '/api/launch/confirm', { id: 'nope-0000' })).status, 404);
  s.close();
});

test('bad launches are rejected before any transaction is built', async () => {
  let built = 0;
  const s = await serve(ON, fake({ prepareLaunch: async () => { built++; return {}; } }));
  assert.equal((await post(s, '/api/launch/prepare', { ...good, symbol: '!' })).status, 400);
  assert.equal(built, 0);
  s.close();
});

test('launch is rate limited', async () => {
  const s = await serve(ON, fake());
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await post(s, '/api/launch/prepare', good)).status);
  assert.equal(codes.filter(c => c === 429).length, 2);
  s.close();
});

test('trade only works on coins the site lists, and maps errors', async () => {
  const s = await serve({ ...ON, FLAGSHIP_CREATOR: W, FLAGSHIP_MINT: CFG, FLAGSHIP_POOL: '9xjjc45NsVmU4u6dSnRYe5Pwj6hKppoNvog3hcd8Rmnt' }, fake());
  const pool = '9xjjc45NsVmU4u6dSnRYe5Pwj6hKppoNvog3hcd8Rmnt';
  assert.equal((await post(s, '/api/trade/prepare', { wallet: W, pool, side: 'buy', amount: 0.1 })).status, 200);
  assert.equal((await post(s, '/api/trade/prepare', { wallet: W, pool: CFG, side: 'buy', amount: 0.1 })).status, 404);
  s.close();
  const s2 = await serve({ FLAGSHIP_CREATOR: W, FLAGSHIP_MINT: CFG, FLAGSHIP_POOL: pool }, fake({ prepareSwap: async () => { throw Object.assign(new Error('x'), { code: 'quote_failed' }); } }));
  const r = await post(s2, '/api/trade/prepare', { wallet: W, pool, side: 'sell', amount: 50 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'quote_failed');
  s2.close();
});

test('oversized bodies are refused', async () => {
  const s = await serve(ON, fake());
  const r = await post(s, '/api/launch/prepare', { ...good, image: 'A'.repeat(800000) });
  assert.equal(r.status, 413);
  s.close();
});

test('until the flagship exists only its creator may launch; then it becomes the pinned flagship', async () => {
  const s = await serve({ ...ON, FLAGSHIP_CREATOR: W }, fake());
  const stranger = '6MC8oeNvL4LQDXcxCQzzcoKpVsrbY3UJMYeKVQ5ew6TV';
  const no = await post(s, '/api/launch/prepare', { ...good, wallet: stranger });
  assert.equal(no.status, 403);
  assert.equal((await no.json()).error, 'flagship_first');
  const out = await (await post(s, '/api/launch/prepare', { ...good, name: 'AutoPayment', symbol: 'AUTO' })).json();
  assert.ok(out.id);
  assert.equal((await post(s, '/api/launch/confirm', { id: out.id })).status, 200);
  const coins = await (await fetch(s.base + '/api/coins')).json();
  assert.equal(coins[0].id, out.id);
  assert.equal(coins[0].flagship, true);
  assert.equal(coins.filter(c => c.flagship).length, 1);
  // now anyone can launch
  assert.equal((await post(s, '/api/launch/prepare', { ...good, wallet: stranger, symbol: 'OTHER' })).status, 200);
  s.close();
});

test('checkLaunch handles website, X and Telegram links', () => {
  const r = checkLaunch({ ...good, website: 'paydog.com', twitter: '@paydog', telegram: 't.me/paydog' });
  assert.equal(r.ok.website, 'https://paydog.com/');
  assert.equal(r.ok.twitter, 'https://x.com/paydog');
  assert.equal(r.ok.telegram, 'https://t.me/paydog');
  assert.equal(checkLaunch(good).ok.website, '');
  assert.equal(checkLaunch({ ...good, website: 'javascript:alert(1)' }).error, 'bad_link');
  assert.equal(checkLaunch({ ...good, twitter: 'https://evil.com/x' }).error, 'bad_link');
  assert.equal(checkLaunch({ ...good, website: 'a b.com' }).error, 'bad_link');
});

test('HIDE_COINS hides a coin by id, mint or pool, and an old flagship goes back to not launched', async () => {
  const { loadCoins } = await import('../coins.mjs');
  const mk = (id, mint, pool, creator) => ({ id, name: id, symbol: 'X', creator, mint, pool, status: 'live', createdAt: 1 });
  const store = { list: () => [mk('old-1', W, CFG, W), mk('new-1', CFG, W, 'someone')] };
  const e = vars => (n, d = '') => String(vars[n] ?? d);
  assert.deepEqual(loadCoins(e({ FLAGSHIP_CREATOR: W }), store).slice(0, 2).map(c => c.id), ['old-1', 'new-1']);
  assert.equal(loadCoins(e({ FLAGSHIP_CREATOR: W, HIDE_POOLS: CFG }), store).some(c => c.id === 'old-1'), false);
  assert.equal(loadCoins(e({ FLAGSHIP_CREATOR: W, HIDE_COINS: 'old-1' }), store).some(c => c.id === 'old-1'), false);
  assert.equal(loadCoins(e({ HIDE_COINS: W }), store).some(c => c.id === 'new-1'), false);
  const env = loadCoins(e({ FLAGSHIP_MINT: W, FLAGSHIP_POOL: CFG, HIDE_POOLS: W }), { list: () => [] })[0];
  assert.equal(env.pool, ''); assert.equal(env.flagship, true);
});

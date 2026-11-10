'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFreeLaunch, messageFor } = require('../freelaunch.js');
const { createLauncher } = require('../launch.js');
const { createLaunches } = require('../launches.js');
const { createApp } = require('../server.js');
const { fakeLoad } = require('./fakechain.js');
const { PublicKey } = require('./fakeweb3.js');

const quiet = { log() {}, error() {} };
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n = BigInt('0x' + buf.toString('hex')), s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b === 0) s = '1' + s; else break; } return s; }
function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { address: b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), sign: m => crypto.sign(null, Buffer.from(m), privateKey).toString('base64') };
}
const key = () => new PublicKey(crypto.randomBytes(32)).toBase58();

function setup(over) {
  const admin = wallet();
  let t = 1000000;
  const sent = [];
  const launcher = over && over.launcher || {
    async prepare(b) { return { status: 200, body: { mint: 'MINT' + sent.length, pool: 'MINT' + sent.length, transaction: 'tx-create', cluster: 'devnet', seen: b } }; },
    async step(b) { return { status: 200, body: this.n++ === 0 ? { step: 'split', transaction: 'tx-split' } : { step: 'done' } }; }, n: 0
  };
  const io = { payer: key(), async signSend(x) { sent.push(x); return 'sig'; } };
  const fl = createFreeLaunch({ launcher, io, admins: [admin.address], now: () => t, logger: quiet, sleep: async () => {} });
  const ask = () => { const ts = t; return fl.issue({ wallet: admin.address, ts, signature: admin.sign(messageFor(admin.address, ts)) }); };
  return { fl, admin, io, sent, ask, launcher, tick: ms => { t += ms; } };
}

test('only the admin wallet can make a code, and only with a fresh signature', () => {
  const { fl, admin, ask } = setup();
  assert.equal(ask().status, 200);
  const stranger = wallet();
  assert.equal(fl.issue({ wallet: stranger.address, ts: 1000000, signature: stranger.sign(messageFor(stranger.address, 1000000)) }).status, 403);
  assert.equal(fl.issue({ wallet: admin.address, ts: 1000000, signature: stranger.sign(messageFor(admin.address, 1000000)) }).status, 401);
  assert.equal(fl.issue({ wallet: admin.address, ts: 1, signature: admin.sign(messageFor(admin.address, 1)) }).status, 400);
});

test('a code launches one coin with the keeper wallet as creator, then is spent', async () => {
  const s = setup();
  const code = s.ask().body.code;
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const r = await s.fl.launch({ code: code.toLowerCase().replace('-', ' '), name: 'Pay Cat', symbol: 'PAYCAT' }, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.creator, s.io.payer);
  assert.deepEqual(s.sent, ['tx-create', 'tx-split']);
  const again = await s.fl.launch({ code, name: 'Two', symbol: 'TWO' }, {});
  assert.equal(again.status, 403);
  assert.equal(again.body.error, 'bad_code');
  assert.equal(s.fl.valid(code), false);
});

test('a bad or expired code is refused; a failed launch before the coin exists keeps the code', async () => {
  const s = setup({ launcher: { async prepare() { return { status: 400, body: { error: 'bad_symbol' } }; }, async step() { return { status: 200, body: { step: 'done' } }; } } });
  assert.equal((await s.fl.launch({ code: 'NOPE-NOPE', name: 'x', symbol: 'X' }, {})).status, 403);
  const code = s.ask().body.code;
  const r = await s.fl.launch({ code, name: 'x', symbol: '!!' }, {});
  assert.equal(r.body.error, 'bad_symbol');
  assert.equal(s.fl.valid(code), true);
  s.tick(8 * 86400000);
  assert.equal(s.fl.valid(code), false);
});

test('if the fee split fails after the coin exists, the code is spent and the coin address is returned', async () => {
  const s = setup({ launcher: { async prepare() { return { status: 200, body: { mint: 'M1', pool: 'M1', transaction: 'a' } }; }, async step() { return { status: 200, body: { step: 'split', transaction: 'b' } }; } } });
  s.io.signSend = async x => { if (x === 'b') throw new Error('boom'); return 'sig'; };
  const code = s.ask().body.code;
  const r = await s.fl.launch({ code, name: 'x', symbol: 'X' }, {});
  assert.equal(r.status, 502);
  assert.equal(r.body.mint, 'M1');
  assert.equal(s.fl.valid(code), false);
});

test('two launches at once with one code: only one runs', async () => {
  const s = setup();
  const code = s.ask().body.code;
  const [a, b] = await Promise.all([s.fl.launch({ code, name: 'a', symbol: 'A' }, {}), s.fl.launch({ code, name: 'b', symbol: 'B' }, {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 403]);
});

test('the website route launches with a code, records the coin, and the config says free launches are on', async () => {
  const st = {};
  const load = fakeLoad(st); st.putGlobal();
  const platform = key(), admin = wallet();
  const launcher = createLauncher({ platformWallet: platform, load, logger: quiet, maxPerMinute: 1000, maxReadsPerMinute: 1000 });
  const launches = createLaunches({ inspect: a => launcher.inspect(a), logger: quiet, listTtlMs: 0 });
  const io = { payer: key(), async signSend() { return 'sig'; } };
  const free = createFreeLaunch({ launcher: { info: () => launcher.info(), async prepare(b, c) { return launcher.prepare(b, c); }, async step() { return { status: 200, body: { step: 'done' } }; } }, io, admins: [admin.address], logger: quiet, sleep: async () => {} });
  const srv = createApp({ launcher, launches, freeLaunch: free });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'autopay.example' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(base + '/api/launch/config')).json()).free, true);
    assert.equal((await post('/api/launch/free', { code: 'AAAA-BBBB', name: 'Pay Cat', symbol: 'PAYCAT' })).status, 403);
    const ts = Date.now();
    const made = await (await post('/api/admin/freecode', { wallet: admin.address, ts, signature: admin.sign(messageFor(admin.address, ts)) })).json();
    assert.ok(made.code);
    const r = await post('/api/launch/free', { code: made.code, name: 'Pay Cat', symbol: 'PAYCAT' });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.creator, io.payer);
    assert.equal((await post('/api/launch/free', { code: made.code, name: 'Pay Cat', symbol: 'PAYCAT' })).status, 403);
    assert.equal(launches.size(), 1);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('the newest code is public until it is used, then reads as used', async () => {
  const s = setup();
  assert.deepEqual(s.fl.current(), { state: 'none' });
  const code = s.ask().body.code;
  assert.equal(s.fl.current().code, code);
  assert.equal(s.fl.current().state, 'ready');
  await s.fl.launch({ code, name: 'a', symbol: 'A' }, {});
  const after = s.fl.current();
  assert.equal(after.state, 'used');
  assert.equal(after.code, undefined);
  s.tick(1000);
  const next = s.ask().body.code;
  assert.equal(s.fl.current().code, next);
});

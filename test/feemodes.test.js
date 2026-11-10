'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLauncher } = require('../launch.js');
const { createLaunches } = require('../launches.js');
const { createApp } = require('../server.js');
const pump = require('../pump.js');
const { fakeLoad } = require('./fakechain.js');
const { PublicKey } = require('./fakeweb3.js');

const quiet = { log() {}, error() {} };
const key = () => new PublicKey(crypto.randomBytes(32)).toBase58();
const CREATOR = key(), PLATFORM = key(), PARTNER = key();
const SIG = '3uQi5xA7Dneip5qac73zDZV4CqysWxAmup8Moy4Rc8L5ro99LVcyeSvYB4GduFNYBJ8yiJJZg8eawjqvkJHJoAHZ';
const good = { name: 'Salt Lantern', symbol: 'LNTRN', creator: CREATOR };
const tx = b64 => JSON.parse(Buffer.from(b64, 'base64').toString());

async function withApp(fn) {
  const st = {};
  const load = fakeLoad(st); st.putGlobal();
  const launcher = createLauncher({ platformWallet: PLATFORM, load, logger: quiet, maxPerMinute: 1000, maxReadsPerMinute: 1000 });
  const launches = createLaunches({ inspect: a => launcher.inspect(a), logger: quiet, listTtlMs: 0 });
  const srv = createApp({ launcher, launches });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'autopay.example' }, body: JSON.stringify(body) });
  try { await fn({ base, post, st, launches }); } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
}

test('share with a wallet: the split is 70/30-style, kept with the coin, and used by the fee-split step', async () => {
  await withApp(async ({ post, st }) => {
    const r = await post('/api/launch/prepare', Object.assign({ feeMode: 'partner', partner: PARTNER, partnerPct: 20 }, good));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.split, { creatorPct: 60, ownerPct: 20, platformPct: 20 });
    st.putCurve(body.mint, { creator: CREATOR });
    const step = await (await post('/api/launch/step', { mint: body.mint, creator: CREATOR, firstBuySol: 0 })).json();
    assert.equal(step.step, 'split');
    const ix = tx(step.transaction).instructions.filter(i => i.program === pump.PUMP_FEES);
    const data = Buffer.from(ix[1].data, 'hex');
    for (const w of [CREATOR, PARTNER, PLATFORM]) assert.ok(data.includes(new PublicKey(w).toBuffer()), 'every shareholder is in the split');
  });
});

test('a partner share is refused when the wallet, the percentage or the choice is wrong', async () => {
  await withApp(async ({ post }) => {
    const ask = extra => post('/api/launch/prepare', Object.assign({}, good, extra));
    assert.equal((await (await ask({ feeMode: 'partner', partner: 'nope', partnerPct: 10 })).json()).error, 'bad_partner');
    assert.equal((await (await ask({ feeMode: 'partner', partner: CREATOR, partnerPct: 10 })).json()).error, 'partner_is_creator');
    for (const pct of [0, 31, 2.5, 'x']) assert.equal((await (await ask({ feeMode: 'partner', partner: PARTNER, partnerPct: pct })).json()).error, 'bad_partner_pct', String(pct));
    assert.equal((await (await ask({ feeMode: 'whatever' })).json()).error, 'bad_fee_mode');
    // the default and the explicit creator mode both work
    assert.equal((await ask({})).status, 200);
    assert.equal((await ask({ feeMode: 'creator' })).status, 200);
  });
});

test('holder rewards are only offered where the site has switched them on, and take no first buy', async () => {
  await withApp(async ({ post, base }) => {
    delete process.env.HOLDER_REWARDS;
    assert.equal((await (await post('/api/launch/prepare', Object.assign({ feeMode: 'holder' }, good))).json()).error, 'holder_not_ready');
    assert.equal((await (await fetch(base + '/api/launch/config')).json()).holderRewards, false);
    process.env.HOLDER_REWARDS = 'yes';
    try {
      assert.equal((await (await fetch(base + '/api/launch/config')).json()).holderRewards, true);
      const ok = await post('/api/launch/prepare', Object.assign({ feeMode: 'holder' }, good));
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.holderRewards, true);
      assert.equal(body.launchFeeSol, 0.05);
      assert.equal((await (await post('/api/launch/prepare', Object.assign({ feeMode: 'holder', firstBuySol: 0.5 }, good))).json()).error, 'holder_buy_not_ready');
    } finally { delete process.env.HOLDER_REWARDS; }
  });
});

test('a boost: the payment is checked on-chain, then the coin shows in the Promoted row', async () => {
  await withApp(async ({ post, base, st, launches }) => {
    const empty = await (await fetch(base + '/api/promoted')).json();
    assert.deepEqual(empty.items, []);
    assert.equal(empty.slots, 4);
    const cfg = await (await fetch(base + '/api/boost/config')).json();
    assert.deepEqual(cfg.tiers.map(t => t.sol), [0.1, 0.2, 0.3, 0.57, 1.31, 1.98]);

    const prep = await (await post('/api/launch/prepare', Object.assign({ boostSol: 0.2 }, good))).json();
    assert.deepEqual(prep.boost, { sol: 0.2, minutes: 31, lamports: 200000000 });
    assert.deepEqual(launches.boostIntent(prep.pool), { creator: CREATOR, lamports: 200000000, minutes: 31 });
    st.putCurve(prep.mint, { creator: CREATOR });

    // nothing on-chain yet
    assert.equal((await post('/api/launch/boost', { pool: prep.pool, sig: SIG })).status, 404);
    // a transaction that did not pay
    st.txs = new Map([[SIG, { meta: { err: null, preBalances: [5e9, 5e9, 5e9], postBalances: [5e9, 5e9, 5e9] }, transaction: { message: { accountKeys: [CREATOR, prep.mint, PLATFORM] } } }]]);
    assert.equal((await (await post('/api/launch/boost', { pool: prep.pool, sig: SIG })).json()).error, 'boost_not_paid');
    assert.deepEqual((await (await fetch(base + '/api/promoted')).json()).items, []);
    // the paid one
    st.txs.set(SIG, { meta: { err: null, preBalances: [5e9, 5e9, 5e9], postBalances: [5e9 - 2e8, 5e9, 5e9 + 2e8] }, transaction: { message: { accountKeys: [CREATOR, prep.mint, PLATFORM] } } });
    const ok = await post('/api/launch/boost', { pool: prep.pool, sig: SIG });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { started: true, minutes: 31 });
    const row = await (await fetch(base + '/api/promoted')).json();
    assert.equal(row.items.length, 1);
    assert.equal(row.items[0].pool, prep.pool);
    assert.equal(row.items[0].perHour, 0.387);
    assert.ok(row.items[0].endsAt > Date.now());
    // asking again with the same signature is fine; a coin with no boost asked for says so
    assert.equal((await post('/api/launch/boost', { pool: prep.pool, sig: SIG })).status, 200);
    const plain = await (await post('/api/launch/prepare', Object.assign({}, good, { symbol: 'PLAIN' }))).json();
    assert.equal((await post('/api/launch/boost', { pool: plain.pool, sig: SIG })).status, 404);
    assert.equal((await post('/api/launch/boost', { pool: 'x' })).status, 400);
  });
});

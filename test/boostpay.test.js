'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLauncher } = require('../launch.js');
const pump = require('../pump.js');
const { fakeLoad } = require('./fakechain.js');

const quiet = { log() {}, error() {} };
const key = () => new (require('./fakeweb3.js').PublicKey)(crypto.randomBytes(32)).toBase58();
const CREATOR = key(), PLATFORM = key();
const ctx = { ip: '1.2.3.4', baseUrl: 'https://autopay.example' };
const good = { name: 'Salt Lantern', symbol: 'LNTRN', creator: CREATOR };
const SIG = '3uQi5xA7Dneip5qac73zDZV4CqysWxAmup8Moy4Rc8L5ro99LVcyeSvYB4GduFNYBJ8yiJJZg8eawjqvkJHJoAHZ';
const tx = b64 => JSON.parse(Buffer.from(b64, 'base64').toString());
const SYSTEM = '11111111111111111111111111111111';

function make(state) {
  const st = state || {};
  const load = fakeLoad(st);
  st.putGlobal();
  return { st, launcher: createLauncher({ platformWallet: PLATFORM, load, logger: quiet, maxPerMinute: 1000, maxReadsPerMinute: 1000 }) };
}
// What the chain would return for a confirmed launch transaction.
const landed = (st, over) => {
  st.txs = st.txs || new Map();
  const mint = over.mint || key();
  const keys = over.keys || [CREATOR, mint, PLATFORM];
  st.txs.set(over.sig || SIG, { meta: { err: over.err || null, preBalances: keys.map(() => 5e9), postBalances: keys.map(k => (k === PLATFORM ? 5e9 + (over.paid === undefined ? 2e8 : over.paid) : 5e9)) }, transaction: { message: { accountKeys: keys } } });
  return mint;
};

test('a boost adds one SOL transfer to the platform wallet in the create transaction, for the quoted amount', async () => {
  const { launcher } = make();
  const r = await launcher.prepare(Object.assign({ boostSol: 0.2 }, good), ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.boost, { sol: 0.2, minutes: 31, lamports: 200000000 });
  const t = tx(r.body.transaction);
  const sys = t.instructions.filter(i => i.program === SYSTEM);
  assert.equal(sys.length, 1);
  const data = Buffer.from(sys[0].data, 'hex');
  assert.equal(data.readUInt32LE(0), 2);
  assert.equal(Number(data.readBigUInt64LE(4)), 200000000);
  assert.equal(t.instructions.filter(i => i.program === pump.PUMP).length, 1);
});

test('no boost means no extra transfer and no boost in the answer', async () => {
  const { launcher } = make();
  for (const none of [undefined, 0, '', null]) {
    const r = await launcher.prepare(Object.assign({ boostSol: none }, good), ctx);
    assert.equal(r.status, 200);
    assert.equal(r.body.boost, null);
    assert.equal(tx(r.body.transaction).instructions.filter(i => i.program === SYSTEM).length, 0);
  }
});

test('an amount outside the allowed range is refused before anything is built', async () => {
  const { launcher } = make();
  for (const bad of [0.05, 0.09, 2, 5, -1, 'lots']) assert.equal((await launcher.prepare(Object.assign({ boostSol: bad }, good), ctx)).body.error, 'bad_boost', String(bad));
});

test('the platform wallet launching its own coin pays itself nothing', async () => {
  const { launcher } = make();
  const r = await launcher.prepare({ name: 'Own', symbol: 'OWN', creator: PLATFORM, boostSol: 0.2 }, ctx);
  assert.equal(r.status, 200);
  assert.equal(tx(r.body.transaction).instructions.filter(i => i.program === SYSTEM).length, 0);
  assert.equal((await launcher.verifyBoost({ pool: key(), sig: SIG, creator: PLATFORM, lamports: 200000000 }, ctx)).body.paid, true);
});

test('the boost with a first buy stays one transaction: create, fee, buy', async () => {
  const TABLE = key();
  const st = {}; st.tables = new Map([[TABLE, { key: TABLE, state: { authority: null, addresses: [] } }]]);
  const load = fakeLoad(st); st.putGlobal();
  const launcher = createLauncher({ platformWallet: PLATFORM, load, logger: quiet, lookupTable: TABLE, maxPerMinute: 1000, maxReadsPerMinute: 1000 });
  const r = await launcher.prepare(Object.assign({ boostSol: 0.1, firstBuySol: 0.5 }, good), ctx);
  assert.equal(r.status, 200);
  const t = tx(r.body.transaction);
  assert.equal(t.instructions.filter(i => i.program === pump.PUMP).length, 2);
  assert.equal(t.instructions.filter(i => i.program === SYSTEM).length, 1);
  const order = t.instructions.map(i => (i.program === pump.PUMP ? 'pump' : i.program === SYSTEM ? 'fee' : 'other')).filter(x => x !== 'other');
  assert.deepEqual(order.slice(0, 3), ['pump', 'fee', 'pump']);
});

test('verifyBoost accepts a transaction that created the coin and moved the fee to the platform wallet', async () => {
  const { launcher, st } = make();
  const mint = landed(st, {});
  const r = await launcher.verifyBoost({ pool: mint, sig: SIG, creator: CREATOR, lamports: 200000000 }, ctx);
  assert.equal(r.status, 200); assert.equal(r.body.paid, true);
});

test('verifyBoost refuses a payment that is short, from someone else, for another coin, failed, or missing', async () => {
  const { launcher, st } = make();
  const mint = landed(st, { paid: 100000000 });
  assert.equal((await launcher.verifyBoost({ pool: mint, sig: SIG, creator: CREATOR, lamports: 200000000 }, ctx)).body.error, 'boost_not_paid');
  const m2 = landed(st, { sig: SIG.replace('3', '4') });
  assert.equal((await launcher.verifyBoost({ pool: m2, sig: SIG.replace('3', '4'), creator: key(), lamports: 200000000 }, ctx)).body.error, 'boost_not_paid');
  assert.equal((await launcher.verifyBoost({ pool: key(), sig: SIG.replace('3', '4'), creator: CREATOR, lamports: 200000000 }, ctx)).body.error, 'boost_not_paid');
  const m3 = landed(st, { sig: SIG.replace('3', '5'), err: { InstructionError: [0, 'x'] } });
  assert.equal((await launcher.verifyBoost({ pool: m3, sig: SIG.replace('3', '5'), creator: CREATOR, lamports: 200000000 }, ctx)).body.error, 'tx_failed');
  assert.equal((await launcher.verifyBoost({ pool: key(), sig: SIG.replace('3', '6'), creator: CREATOR, lamports: 200000000 }, ctx)).status, 404);
  assert.equal((await launcher.verifyBoost({ pool: 'nope', sig: SIG, creator: CREATOR, lamports: 1 }, ctx)).status, 400);
});

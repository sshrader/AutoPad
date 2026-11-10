'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLauncher } = require('../launch.js');
const pump = require('../pump.js');
const A = require('../airdrop.js');
const { fakeLoad } = require('./fakechain.js');

const quiet = { log() {}, error() {} };
const key = () => new (require('./fakeweb3.js').PublicKey)(crypto.randomBytes(32)).toBase58();
const CREATOR = key(), PLATFORM = key(), KEEPER = key(), MINT = key();
const ctx = { ip: '1.2.3.4', baseUrl: 'https://autopay.example' };
const good = { name: 'Salt Lantern', symbol: '$lntrn', creator: CREATOR };
const tx = b64 => JSON.parse(Buffer.from(b64, 'base64').toString());
const approves = t => t.instructions.filter(i => i.program === pump.TOKEN_2022 && i.data.startsWith('0d'));

function make(extra, state) {
  const st = state || {};
  const load = fakeLoad(st);
  st.putGlobal();
  const launcher = createLauncher(Object.assign({ platformWallet: PLATFORM, load, logger: quiet, maxPerMinute: 1000, maxReadsPerMinute: 1000 }, extra));
  return { launcher, st };
}

test('allocate splits exactly, in proportion, and skips empty holders', () => {
  const r = A.allocate(1000n, [{ key: 'a', weight: 1n }, { key: 'b', weight: 1n }, { key: 'c', weight: 1n }, { key: 'z', weight: 0n }]);
  assert.equal(r.length, 3);
  assert.equal(r.reduce((n, x) => n + x.amount, 0n), 1000n);
  const p = A.allocate(100n, [{ key: 'big', weight: 900n }, { key: 'small', weight: 100n }]);
  assert.deepEqual(p.map(x => [x.key, x.amount]), [['big', 90n], ['small', 10n]]);
  assert.deepEqual(A.allocate(0n, [{ key: 'a', weight: 1n }]), []);
  assert.deepEqual(A.allocate(5n, []), []);
  assert.equal(A.allocate(2n, [{ key: 'a', weight: 1n }, { key: 'b', weight: 1n }, { key: 'c', weight: 1n }]).length, 2);
});

test('airdrop settings are checked', () => {
  assert.equal(A.parseSettings({}), null);
  assert.deepEqual(A.parseSettings({ airdropPct: 10, airdropHolders: 50, airdropMinutes: 1440 }), { pct: 10, holders: 50, minutes: 1440 });
  for (const bad of [{ airdropPct: 0 }, { airdropPct: 51 }, { airdropPct: 10, airdropHolders: 1, airdropMinutes: 1440 }, { airdropPct: 10, airdropHolders: 50, airdropMinutes: 0 }, { airdropPct: 10, airdropHolders: 50, airdropMinutes: 20000 }, { airdropPct: 2.5, airdropHolders: 50, airdropMinutes: 1440 }, { airdropPct: 10, airdropHolders: 'x', airdropMinutes: 1440 }]) assert.equal(A.parseSettings(bad), false);
});

test('a launch asks for an airdrop only when it is on, with a first buy; the approval is inside the launch transaction', async () => {
  const TABLE = key();
  const st = { tables: new Map([[TABLE, { key: TABLE, state: { authority: null, addresses: [] } }]]) };
  const body = Object.assign({ firstBuySol: 0.5, airdropPct: 10, airdropHolders: 50, airdropMinutes: 1440 }, good);
  const off = make({ lookupTable: TABLE, keeperWallet: KEEPER }, st).launcher;
  assert.equal((await off.prepare(body, ctx)).body.error, 'airdrop_unavailable');
  const { launcher } = make({ lookupTable: TABLE, keeperWallet: KEEPER, airdrop: true }, st);
  assert.equal(launcher.info().airdrop, true);
  assert.equal((await launcher.prepare(Object.assign({}, body, { firstBuySol: 0 }), ctx)).body.error, 'airdrop_needs_buy');
  assert.equal((await launcher.prepare(Object.assign({}, body, { airdropPct: 99 }), ctx)).body.error, 'bad_airdrop');
  const r = await launcher.prepare(body, ctx);
  assert.equal(r.status, 200);
  assert.ok(BigInt(r.body.airdrop.tokens) > 0n);
  assert.equal(r.body.airdrop.minutes, 1440);
  const t = tx(r.body.transaction);
  assert.equal(approves(t).length, 1);
  // the approve is the last instruction, after the buy
  assert.ok(t.instructions.indexOf(approves(t)[0]) > t.instructions.findIndex(i => i.program === pump.PUMP && i.keys === 17));
  // no airdrop asked for: no approve
  assert.equal(approves(tx((await launcher.prepare(Object.assign({ firstBuySol: 0.5 }, good), ctx)).body.transaction)).length, 0);
});

test('the approval is off without the keeper wallet, even if the switch is on', () => {
  const { launcher } = make({ airdrop: true }, {});
  assert.equal(launcher.info().airdrop, false);
});

test('without a lookup table the approval rides in the separate buy step', async () => {
  const st = {};
  const { launcher } = make({ keeperWallet: KEEPER, airdrop: true }, st);
  const body = Object.assign({ firstBuySol: 0.5, airdropPct: 10, airdropHolders: 50, airdropMinutes: 1440 }, good);
  const r = await launcher.prepare(body, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.atomic, false);
  assert.equal(approves(tx(r.body.transaction)).length, 0);
  assert.ok(r.body.airdrop);
  st.putCurve(r.body.mint, { creator: st.B.sharingConfigOf(r.body.mint).toBase58() });
  const s = await launcher.step({ mint: r.body.mint, creator: CREATOR, firstBuySol: 0.5, airdropPct: 10, airdropHolders: 50, airdropMinutes: 1440 }, ctx);
  assert.equal(s.body.step, 'buy');
  assert.equal(approves(tx(s.body.transaction)).length, 1);
  const plain = await launcher.step({ mint: r.body.mint, creator: CREATOR, firstBuySol: 0.5 }, ctx);
  assert.equal(approves(tx(plain.body.transaction)).length, 0);
});

test('the launcher reads holders and the creator approval from the chain', async () => {
  const st = {};
  const { launcher } = make({ keeperWallet: KEEPER, airdrop: true }, st);
  const h1 = key(), h2 = key(), a1 = key(), a2 = key(), a3 = key();
  st.putTokenAccount(a1, { mint: MINT, owner: h1, amount: 5000 });
  st.putTokenAccount(a2, { mint: MINT, owner: h2, amount: 700 });
  st.putTokenAccount(a3, { mint: key(), owner: h2, amount: 9 });   // another coin: ignored
  const info = await launcher.airdropInfo(MINT, h1);
  assert.equal(info.accounts.length, 2);
  assert.equal(info.accounts[0].amount, 5000n);
  assert.equal(info.accounts[0].delegate, null);
  // the creator's own account: ata(creator, mint)
  const ata = st.B.ata(new st.web3.PublicKey(CREATOR), MINT, pump.TOKEN_2022).toBase58();
  st.putTokenAccount(ata, { mint: MINT, owner: CREATOR, amount: 1000, delegate: KEEPER, delegated: 400 });
  assert.deepEqual(await launcher.approval(MINT, CREATOR), { held: '1000', approved: '400' });
  st.putTokenAccount(ata, { mint: MINT, owner: CREATOR, amount: 1000, delegate: key(), delegated: 400 });
  assert.deepEqual(await launcher.approval(MINT, CREATOR), { held: '1000', approved: '0' });
  const t = tx((await launcher.airdropTransactions({ mint: MINT, creator: CREATOR, source: ata, keeper: KEEPER, recipients: [{ to: a1, amount: '10' }, { to: a2, amount: '20' }] }))[0]);
  assert.equal(t.feePayer, KEEPER);
  assert.equal(t.instructions.filter(i => i.program === pump.TOKEN_2022 && i.data.startsWith('0c')).length, 2);
});

test('when the RPC cannot list token accounts, holders come from the largest accounts, and it says if the list is partial', async () => {
  const st = { noGpa: true };
  const { launcher } = make({ keeperWallet: KEEPER, airdrop: true }, st);
  const a1 = key(), a2 = key();
  st.putTokenAccount(a1, { mint: MINT, owner: key(), amount: 5000 });
  st.putTokenAccount(a2, { mint: MINT, owner: key(), amount: 700 });
  let info = await launcher.airdropInfo(MINT, CREATOR);
  assert.equal(info.accounts.length, 2);
  assert.equal(info.complete, true);
  for (let i = 0; i < 20; i++) st.putTokenAccount(key(), { mint: MINT, owner: key(), amount: 10 + i });
  info = await launcher.airdropInfo(MINT, CREATOR);
  assert.equal(info.accounts.length, 20);
  assert.equal(info.complete, false);
  st.noGpa = false;
  assert.equal((await launcher.airdropInfo(MINT, CREATOR)).complete, true);
});

test('a partial holder list is never used to send; the job says why and keeps waiting', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG, BIG], t: 100000000 });
  const base = launcher.airdropInfo;
  launcher.airdropInfo = async (...a) => Object.assign(await base(...a), { complete: false });
  const store = A.createAirdrops({});
  store.add(job({ createdAt: 0 }));
  await A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet }).process();
  assert.equal(store.get(MINT).status, 'scheduled');
  assert.match(store.get(MINT).reason, /LAUNCH_RPC_URL/);
  assert.equal(w.sends.length, 0);
  launcher.airdropInfo = base;
  await A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet }).process();
  assert.equal(store.get(MINT).status, 'done');
  assert.equal(store.get(MINT).reason, '');
});

// A stand-in for the chain, to drive the runner: balances move when the "keeper" sends.
function world(opts) {
  const w = { t: 1000000, holders: [], approved: 1000n, held: 1000n, curve: 'CURVE', sends: [], failNext: 0, landButFail: false, balance: 1 };
  Object.assign(w, opts);
  const launcher = {
    async airdropInfo() {
      const accounts = [{ account: 'src', owner: CREATOR, amount: w.held, delegate: w.approved > 0n ? KEEPER : null, delegatedAmount: w.approved }]
        .concat(w.holders.map((h, i) => ({ account: 'acct' + i, owner: 'own' + i, amount: BigInt(h), delegate: null, delegatedAmount: 0n })));
      return { curve: w.curve, accounts };
    },
    async airdropTransactions(i) { return [JSON.stringify(i.recipients)]; }
  };
  const io = {
    payer: KEEPER, async balanceSol() { return w.balance; }, async sign(x) { return x; },
    async send(x) {
      const rec = JSON.parse(x);
      const sum = rec.reduce((n, r) => n + BigInt(r.amount), 0n);
      if (w.failNext > 0) { w.failNext--; if (w.landButFail) { w.approved -= sum; w.held -= sum; w.sends.push(rec); } throw new Error('timeout'); }
      w.approved -= sum; w.held -= sum; w.sends.push(rec); return 'sig' + w.sends.length;
    }
  };
  return { w, launcher, io };
}
const job = over => Object.assign({ pool: MINT, creator: CREATOR, pct: 10, minHolders: 3, afterMinutes: 60, tokens: '1000', createdAt: 1000000 }, over);
const BIG = 200000000000;

test('the runner waits for the time, then for enough holders, then sends pro rata and finishes', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG] });
  const store = A.createAirdrops({});
  store.add(job());
  const run = A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet, batch: 2 });
  await run.process();
  assert.equal(store.get(MINT).status, 'scheduled');           // not due yet
  assert.equal(w.sends.length, 0);
  w.t += 3600000;
  await run.process();
  assert.equal(store.get(MINT).status, 'scheduled');           // due, but only 2 of 3 holders
  assert.equal(store.get(MINT).holders, 2);
  w.holders = [BIG, BIG, BIG * 2, 5];                           // one holder is below the minimum and gets nothing
  await run.process();
  const j = store.get(MINT);
  assert.equal(j.status, 'done');
  assert.equal(j.recipients, 3);
  assert.equal(w.sends.length, 2);                              // 3 recipients in batches of 2
  const all = [].concat(...w.sends);
  assert.equal(all.reduce((n, r) => n + BigInt(r.amount), 0n), 1000n);
  assert.equal(BigInt(all.find(r => r.to === 'acct2').amount), 500n);
  assert.equal(w.approved, 0n);
  await run.process();
  assert.equal(w.sends.length, 2, 'a finished airdrop is never sent twice');
});

test('a send that fails is retried from where it stopped, and a batch that landed is not sent again', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG, BIG, BIG], failNext: 1, landButFail: true , t: 100000000 });
  const store = A.createAirdrops({});
  store.add(job({ createdAt: 0 }));
  const run = A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet, batch: 2 });
  await run.process();                                           // batch 1 lands but reports a failure
  assert.equal(store.get(MINT).status, 'sending');
  await run.process();
  const j = store.get(MINT);
  assert.equal(j.status, 'done');
  assert.equal(w.sends.length, 2, 'two batches, none doubled');
  assert.equal(w.approved, 0n);
});

test('a plain failure resumes cleanly', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG, BIG], failNext: 1 , t: 100000000 });
  const store = A.createAirdrops({});
  store.add(job({ createdAt: 0 }));
  const run = A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet, batch: 5 });
  await run.process();
  assert.equal(store.get(MINT).status, 'sending');
  await run.process();
  assert.equal(store.get(MINT).status, 'done');
  assert.equal(w.sends.length, 1);
});

test('if the creator sold or cancelled, nothing is sent and the airdrop says so', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG, BIG], approved: 0n , t: 100000000 });
  const store = A.createAirdrops({});
  store.add(job({ createdAt: 0 }));
  const run = A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet });
  await run.process();
  assert.equal(store.get(MINT).status, 'failed');
  assert.match(store.get(MINT).reason, /sold or cancelled/);
  assert.equal(w.sends.length, 0);
  // a launch still landing is given time
  const s2 = A.createAirdrops({});
  s2.add(job({ createdAt: w.t - 4000000, afterMinutes: 60 }));
  await A.createAirdropper({ store: s2, launcher, io, now: () => w.t, logger: quiet, graceMs: 99999999 }).process();
  assert.equal(s2.get(MINT).status, 'scheduled');
});

test('when less is held than approved, only what is held is sent; the creator, curve, keeper and platform are skipped', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG, BIG], held: 300n, approved: 1000n , t: 100000000 });
  const store = A.createAirdrops({});
  store.add(job({ createdAt: 0, minHolders: 2 }));
  const run = A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet, platformWallet: 'own1' });
  await run.process();
  const all = [].concat(...w.sends);
  assert.equal(all.reduce((n, r) => n + BigInt(r.amount), 0n), 300n);
  assert.equal(all.length, 2, 'the platform wallet holder was skipped');
});

test('the keeper holds back when its wallet is low on gas', async () => {
  const { w, launcher, io } = world({ holders: [BIG, BIG, BIG], balance: 0.001 });
  const store = A.createAirdrops({});
  store.add(job({ createdAt: 0 }));
  const r = await A.createAirdropper({ store, launcher, io, now: () => w.t, logger: quiet }).process();
  assert.equal(r.lowGas, true);
  assert.equal(w.sends.length, 0);
});

test('airdrops are saved to a file and reloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  const file = path.join(dir, 'airdrops.json');
  const a = A.createAirdrops({ file });
  a.add(job());
  a.update(MINT, { status: 'done' });
  assert.equal(A.createAirdrops({ file }).get(MINT).status, 'done');
  assert.equal(a.add(job()), null, 'one airdrop per coin');
});

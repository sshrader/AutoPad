'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBoost } = require('../boost');

test('the six ready-made boosts follow the curve and always buy at least their nominal time', () => {
  const b = createBoost();
  assert.deepEqual(b.tiers.map(t => t.sol), [0.1, 0.2, 0.3, 0.57, 1.31, 1.98]);
  for (const t of b.tiers) {
    const q = b.quote(t.sol);
    assert.ok(q.minutes >= t.minutes, t.minutes + ' min tier buys ' + q.minutes);
    assert.ok(q.minutes <= 1440);
  }
});

test('a custom amount runs the same curve in reverse, inside the limits', () => {
  const b = createBoost();
  assert.equal(b.quote(0.1).minutes, 10);
  assert.equal(b.quote(0.5).minutes, 146);
  assert.equal(b.quote(1.98).minutes, 1440);
  assert.equal(b.quote(0.09), null);
  assert.equal(b.quote(2.5), null);
  assert.equal(b.quote('abc'), null);
  assert.equal(b.quote(NaN), null);
  assert.equal(b.quote(0.5).lamports, 500000000);
});

test('shorter boosts cost more per hour, so they rank above longer ones', () => {
  const b = createBoost();
  const rates = b.tiers.map(t => b.quote(t.sol).perHour);
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i] < rates[i - 1]);
});

test('BOOST_PRICE_MULT scales every price', () => {
  const half = createBoost({ mult: 0.5 });
  assert.equal(half.minSol, 0.05);
  assert.deepEqual(half.tiers.map(t => t.sol).slice(0, 2), [0.05, 0.1]);
  assert.equal(half.quote(0.05).minutes, 10);
  assert.equal(createBoost({ mult: -3 }).minSol, 0.1); // nonsense falls back to the default
});

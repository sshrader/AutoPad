'use strict';
// Boost: a creator can pay a flat fee at launch to put their coin in the "Promoted" row on the home page for a while.
// One smooth curve sets the price, so the six buttons and a custom amount all follow the same rule:
//   price = BASE_SOL x (minutes / BASE_MIN) ^ 0.6
// Longer boosts cost more in total but less per hour. Promoted coins are ranked by how much is paid per hour.
const BASE_SOL = 0.1;      // the price of the shortest boost
const BASE_MIN = 10;       // minutes
const EXPONENT = 0.6;
const MIN_MIN = 10;
const MAX_MIN = 1440;      // 24 hours
const TIER_MINUTES = [10, 30, 60, 180, 720, 1440];
const SLOTS = 4;

const roundUp2 = n => Math.ceil(n * 100 - 1e-9) / 100;

function createBoost(opts) {
  const o = opts || {};
  const mult = Number.isFinite(o.mult) && o.mult > 0 ? o.mult : 1; // BOOST_PRICE_MULT: 0.5 is half price
  const base = BASE_SOL * mult;
  const slots = Number.isInteger(o.slots) && o.slots > 0 ? o.slots : SLOTS;

  const priceFor = minutes => base * Math.pow(minutes / BASE_MIN, EXPONENT);
  const minSol = roundUp2(base);
  const maxSol = roundUp2(priceFor(MAX_MIN));

  // What an amount buys: { sol, minutes, lamports, perHour } or null if the amount is outside the allowed range.
  function quote(sol) {
    const n = Number(sol);
    if (!Number.isFinite(n) || n < minSol - 1e-9 || n > maxSol + 1e-9) return null;
    const lamports = Math.round(n * 1e9);
    const exact = lamports / 1e9;
    const minutes = Math.max(MIN_MIN, Math.min(MAX_MIN, Math.floor(BASE_MIN * Math.pow(exact / base, 1 / EXPONENT) + 1e-9)));
    return { sol: exact, minutes, lamports, perHour: exact / (minutes / 60) };
  }

  // The ready-made choices: each amount is rounded up to 0.01 SOL, so it always buys at least its nominal time.
  const tiers = TIER_MINUTES.map(m => ({ minutes: m, sol: roundUp2(priceFor(m)) }));

  const config = () => ({ minSol, maxSol, baseSol: base, baseMinutes: BASE_MIN, exponent: EXPONENT, minMinutes: MIN_MIN, maxMinutes: MAX_MIN, slots, tiers });
  return { quote, tiers, config, minSol, maxSol, slots, priceFor };
}

module.exports = { createBoost, BASE_SOL, BASE_MIN, EXPONENT, MIN_MIN, MAX_MIN, SLOTS };

// Meteora Dynamic Bonding Curve spike, DEVNET ONLY. Proves the AutoPay idea on Meteora:
//   the keeper wallet is the on-chain pool creator, collects the creator fees, and pays them straight to
//   the real creator's wallet (a different address that never signs).
// Run the steps in order:  node 30-meteora-spike.mjs setup | config | pool | trade | claim | status
// Keys live in devnet/keys/ (git-ignored). Nothing here is used by the website.
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import * as sdk from '@meteora-ag/dynamic-bonding-curve-sdk';
import { connection, IS_MAIN, makeKey, loadKey, readState, writeState, send, sol, arg } from './lib.mjs';

if (IS_MAIN) { console.error('This spike is devnet only.'); process.exit(1); }
const { DynamicBondingCurveClient, buildCurveWithMarketCap, deriveDbcPoolAddress } = sdk;
// Enum names differ between SDK versions, so look each up and fall back to the program's own numbers.
const pick = (name, key, fallback) => (sdk[name] && sdk[name][key] !== undefined ? sdk[name][key] : fallback);
const ActivationType = { Slot: pick('ActivationType', 'Slot', 0) };
const CollectFeeMode = { QuoteToken: pick('CollectFeeMode', 'QuoteToken', 0) };
const BaseFeeMode = { FeeSchedulerLinear: pick('BaseFeeMode', 'FeeSchedulerLinear', 0) };
const MigrationOption = { MET_DAMM_V2: pick('MigrationOption', 'MET_DAMM_V2', 1) };
const MigrationFeeOption = { FixedBps100: pick('MigrationFeeOption', 'FixedBps100', 2) };
const TokenDecimal = { SIX: pick('TokenDecimal', 'SIX', 6), NINE: pick('TokenDecimal', 'NINE', 9) };
const TokenType = { Token2022: pick('TokenType', 'Token2022', 1) };
const TokenUpdateAuthorityOption = { Immutable: pick('TokenUpdateAuthorityOption', 'Immutable', pick('TokenAuthorityOption', 'Immutable', 1)) };
const step = process.argv[2];
const client = new DynamicBondingCurveClient(connection, 'confirmed');
const BIG = new BN('1000000000000000'); // "claim everything" cap for the max amounts

const bal = async pk => sol(await connection.getBalance(pk));
const need = (state, k, hint) => { if (!state[k]) { console.error('Missing ' + k + '. ' + hint); process.exit(1); } return state[k]; };
const keys = () => ({ keeper: loadKey('mt-keeper'), platform: loadKey('mt-platform'), buyer: loadKey('mt-buyer'), creator: loadKey('mt-creator') });

if (step === 'exports') {
  console.log(Object.keys(sdk).sort().join('\n'));
} else if (step === 'setup') {
  const roles = {
    'mt-keeper': 'pool creator on chain, signs launches and claims creator fees (needs ~1 SOL)',
    'mt-platform': 'platform fee claimer and config payer (needs ~0.5 SOL)',
    'mt-buyer': 'trades on the curve (needs ~3 SOL)',
    'mt-creator': 'the REAL creator: only receives money, never signs (needs 0 SOL)',
  };
  for (const [name, why] of Object.entries(roles)) {
    const { kp, created } = makeKey(name);
    console.log((created ? 'Created ' : 'Found   ') + name.padEnd(12) + kp.publicKey.toBase58() + '  ' + (await bal(kp.publicKey)).toFixed(3) + ' SOL');
    console.log('   ' + why);
    if (created && name !== 'mt-creator') { try { await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL); } catch { /* rate limited, use the faucet */ } }
  }
  console.log('\nTop up any low wallet at https://faucet.solana.com (choose devnet), then run: node 30-meteora-spike.mjs config');
} else if (step === 'config') {
  const { platform } = keys();
  const config = Keypair.generate();
  const creatorPct = Number(arg('creator-pct', '90'));
  const feeBps = Number(arg('fee-bps', '100'));
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022, // AutoPay's airdrop code already handles Token-2022
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenUpdateAuthorityOption.Immutable, // named tokenUpdateAuthority in older SDKs
      tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees in SOL only
      creatorTradingFeePercentage: creatorPct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    initialMarketCap: Number(arg('start-mcap', '20')),
    migrationMarketCap: Number(arg('grad-mcap', '60')), // small, so a test coin can graduate on devnet
  });
  const tx = await client.partner.createConfig({
    config: config.publicKey, feeClaimer: platform.publicKey, leftoverReceiver: platform.publicKey,
    payer: platform.publicKey, quoteMint: NATIVE_MINT, ...curve,
  });
  await send(tx, [platform, config], 'create config');
  writeState({ mtConfig: config.publicKey.toBase58(), mtCreatorPct: creatorPct });
  console.log('Config ' + config.publicKey.toBase58() + ' (creator share ' + creatorPct + '% of the fee left after Meteora\'s cut)');
} else if (step === 'pool') {
  const st = readState();
  const config = new PublicKey(need(st, 'mtConfig', 'Run the config step first.'));
  const { keeper, buyer } = keys();
  const mint = Keypair.generate();
  const name = arg('name', 'Pay Cat'), symbol = arg('symbol', 'PAYCAT');
  const firstBuy = new BN(Math.round(Number(arg('buy', '0.1')) * LAMPORTS_PER_SOL));
  const { createPoolTx } = await client.pool.createPoolWithFirstBuy({
    createPoolParam: { baseMint: mint.publicKey, config, name, symbol, uri: 'https://example.com/' + symbol.toLowerCase() + '.json', payer: keeper.publicKey, poolCreator: keeper.publicKey },
    firstBuyParam: { buyer: buyer.publicKey, buyAmount: firstBuy, minimumAmountOut: new BN(0), referralTokenAccount: null },
  });
  // keeper (pool creator + payer), the new mint, and the buyer all sign ONE transaction = atomic launch
  await send(createPoolTx, [keeper, mint, buyer], 'create pool + first buy');
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config);
  writeState({ mtMint: mint.publicKey.toBase58(), mtPool: pool.toBase58() });
  console.log('Mint ' + mint.publicKey.toBase58() + '\nPool ' + pool.toBase58());
} else if (step === 'trade') {
  const st = readState();
  const pool = new PublicKey(need(st, 'mtPool', 'Run the pool step first.'));
  const mint = new PublicKey(st.mtMint);
  const { buyer } = keys();
  const buy = new BN(Math.round(Number(arg('buy', '0.5')) * LAMPORTS_PER_SOL));
  const buyTx = await client.pool.swap({ owner: buyer.publicKey, amountIn: buy, minimumAmountOut: new BN(0), swapBaseForQuote: false, pool, poolAddress: pool, referralTokenAccount: null });
  await send(buyTx, [buyer], 'buy ' + sol(buy.toString()) + ' SOL');
  const ata = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const held = (await connection.getTokenAccountBalance(ata)).value.amount;
  const sellAmt = new BN(held).div(new BN(2));
  const sellTx = await client.pool.swap({ owner: buyer.publicKey, amountIn: sellAmt, minimumAmountOut: new BN(0), swapBaseForQuote: true, pool, poolAddress: pool, referralTokenAccount: null });
  await send(sellTx, [buyer], 'sell half');
  console.log('Buy and sell both worked. Now run: node 30-meteora-spike.mjs claim');
} else if (step === 'claim') {
  const st = readState();
  const pool = new PublicKey(need(st, 'mtPool', 'Run the pool step first.'));
  const { keeper, platform, creator } = keys();
  try {
    const m = await client.state.getPoolFeeMetrics(pool);
    console.log('Fee metrics (raw):', JSON.stringify(m, (k, v) => (v && v.toString && v.constructor && v.constructor.name === 'BN' ? v.toString() : v)));
  } catch (e) { console.log('(could not read fee metrics: ' + e.message + ')'); }

  const before = await bal(creator.publicKey);
  console.log('Real creator wallet before: ' + before.toFixed(6) + ' SOL (keeper wallet is the on-chain creator; it signs, the creator wallet does not)');
  let ok = false;
  try {
    const tx = await client.creator.claimCreatorTradingFee({
      creator: keeper.publicKey, payer: keeper.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: BIG,
      receiver: creator.publicKey,
      tempWSolAcc: getAssociatedTokenAddressSync(NATIVE_MINT, keeper.publicKey),
    });
    await send(tx, [keeper], 'keeper claims creator fee -> real creator');
    ok = true;
  } catch (e) {
    console.log('Claim with a separate receiver FAILED: ' + (e.message || e));
    console.log('Trying again with the keeper itself as receiver...');
    try {
      const tx = await client.creator.claimCreatorTradingFee({ creator: keeper.publicKey, payer: keeper.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: BIG });
      await send(tx, [keeper], 'keeper claims creator fee -> keeper');
      console.log('That worked, so a separate receiver is the problem (tempWSolAcc?). Send me the error above.');
    } catch (e2) { console.log('Also failed: ' + (e2.message || e2)); }
  }
  const after = await bal(creator.publicKey);
  console.log('Real creator wallet after:  ' + after.toFixed(6) + ' SOL  (change ' + (after - before).toFixed(6) + ')');
  console.log(ok ? 'RESULT: the keeper CAN pay creators directly.' : 'RESULT: not proven, see errors above.');

  try {
    const ptx = await client.partner.claimPartnerTradingFee({ pool, feeClaimer: platform.publicKey, payer: platform.publicKey, maxBaseAmount: new BN(0), maxQuoteAmount: BIG });
    const pb = await bal(platform.publicKey);
    await send(ptx, [platform], 'platform claims its share');
    console.log('Platform wallet change: ' + ((await bal(platform.publicKey)) - pb).toFixed(6) + ' SOL');
  } catch (e) { console.log('Platform claim failed: ' + (e.message || e)); }
} else if (step === 'status') {
  const st = readState();
  console.log(JSON.stringify({ config: st.mtConfig, mint: st.mtMint, pool: st.mtPool }, null, 2));
  if (st.mtPool) {
    const p = await client.state.getPool(new PublicKey(st.mtPool));
    console.log('quoteReserve ' + p.quoteReserve.toString() + ', baseReserve ' + p.baseReserve.toString() + ', isMigrated ' + p.isMigrated);
  }
} else {
  console.log('Usage: node 30-meteora-spike.mjs setup | config | pool | trade | claim | status');
}

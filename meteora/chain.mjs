// Everything that talks to Meteora's Dynamic Bonding Curve. The SDK is loaded only here, so the rest of the app (and its
// tests) run without it. Names that differ between SDK versions are looked up with fallbacks to the program's own numbers.
import { lamports as toLamports } from './lib.mjs';

const BIG = '1000000000000000'; // "claim everything" cap for the max amounts

export async function createChain({ connection, keeper }) {
  const sdk = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  const { default: BN } = await import('bn.js');
  const { PublicKey, Keypair, sendAndConfirmTransaction } = web3;
  const client = new sdk.DynamicBondingCurveClient(connection, 'confirmed');
  const pick = (name, key, fallback) => (sdk[name] && sdk[name][key] !== undefined ? sdk[name][key] : fallback);
  const pk = x => (x instanceof PublicKey ? x : new PublicKey(x));
  const num = x => (x && x.toString ? Number(x.toString()) : Number(x || 0));

  async function send(tx, signers) {
    tx.feePayer = signers[0].publicKey;
    return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  }

  // The curve. Creating a config is permanent (it cannot be edited), so callers show these numbers and ask first.
  function curveParams(o) {
    const feeBps = o.feeBps;
    return sdk.buildCurveWithMarketCap({
      token: {
        tokenType: pick('TokenType', 'Token2022', 1),
        tokenBaseDecimal: pick('TokenDecimal', 'SIX', 6),
        tokenQuoteDecimal: pick('TokenDecimal', 'NINE', 9),
        tokenAuthorityOption: pick('TokenUpdateAuthorityOption', 'Immutable', 1),
        tokenUpdateAuthority: pick('TokenUpdateAuthorityOption', 'Immutable', 1),
        totalTokenSupply: o.supply,
        leftover: 0,
      },
      fee: {
        baseFeeParams: { baseFeeMode: pick('BaseFeeMode', 'FeeSchedulerLinear', 0), feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
        dynamicFeeEnabled: false,
        collectFeeMode: pick('CollectFeeMode', 'QuoteToken', 0),
        creatorTradingFeePercentage: o.creatorPct,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },
      migration: {
        migrationOption: pick('MigrationOption', 'MET_DAMM_V2', 1),
        migrationFeeOption: pick('MigrationFeeOption', 'FixedBps100', 2),
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      },
      liquidityDistribution: {
        partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
        creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0,
      },
      lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
      activationType: pick('ActivationType', 'Slot', 0),
      initialMarketCap: o.startMcap,
      migrationMarketCap: o.gradMcap,
    });
  }

  return {
    keeperAddress: keeper.publicKey.toBase58(),
    curveParams,

    // Makes the config. The keeper is the fee claimer, so it can also claim the platform's share and send it on.
    async createConfig(o) {
      const config = Keypair.generate();
      const tx = await client.partner.createConfig({
        config: config.publicKey, feeClaimer: keeper.publicKey, leftoverReceiver: pk(o.leftoverReceiver || keeper.publicKey),
        payer: keeper.publicKey, quoteMint: spl.NATIVE_MINT, ...curveParams(o),
      });
      const sig = await send(tx, [keeper, config]);
      return { config: config.publicKey.toBase58(), sig };
    },

    // One transaction: the keeper creates the pool (it is the on-chain creator) and makes the first buy, tokens going to
    // `tokensTo` (the real creator's wallet). Only the keeper signs.
    async launch({ config, name, symbol, uri, tokensTo, buySol }) {
      const mint = Keypair.generate();
      const createPoolParam = { baseMint: mint.publicKey, config: pk(config), name, symbol, uri, payer: keeper.publicKey, poolCreator: keeper.publicKey };
      const buyAmount = new BN(toLamports(buySol || 0));
      let tx;
      if (buyAmount.gtn(0)) {
        const made = await client.creator.createPoolWithFirstBuy({
          createPoolParam,
          firstBuyParam: { buyer: keeper.publicKey, receiver: tokensTo ? pk(tokensTo) : undefined, buyAmount, minimumAmountOut: new BN(0), referralTokenAccount: null },
        });
        tx = made.createPoolTx || made;
      } else {
        tx = await client.creator.createPool(createPoolParam);
      }
      const sig = await send(tx, [keeper, mint]);
      const pool = sdk.deriveDbcPoolAddress(spl.NATIVE_MINT, mint.publicKey, pk(config));
      return { mint: mint.publicKey.toBase58(), pool: pool.toBase58(), sig };
    },

    // Live numbers for the coin page.
    async poolInfo(poolAddress) {
      const pool = pk(poolAddress);
      const p = await client.state.getPool(pool);
      let progress = null;
      try { progress = Math.round(Number(await client.state.getPoolQuoteTokenCurveProgress(pool)) * 1000) / 10; } catch { /* optional */ } // 0-1 from the SDK, shown as a percent
      return { quoteReserveSol: num(p.quoteReserve) / 1e9, isMigrated: Boolean(p.isMigrated), progress };
    },

    // Fees waiting to be claimed and fees collected so far, in lamports.
    async fees(poolAddress) {
      const m = await client.state.getPoolFeeMetrics(pk(poolAddress));
      return {
        creatorPending: num(m.current.creatorQuoteFee), partnerPending: num(m.current.partnerQuoteFee),
        totalCollected: num(m.total.totalTradingQuoteFee),
      };
    },

    // The keeper (pool creator) claims the creator's share and sends it straight to the creator's wallet.
    async claimCreator(poolAddress, receiver) {
      const base = { creator: keeper.publicKey, payer: keeper.publicKey, pool: pk(poolAddress), maxBaseAmount: new BN(0), maxQuoteAmount: new BN(BIG) };
      const tx = await client.creator.claimCreatorTradingFee({ ...base, receiver: pk(receiver), tempWSolAcc: spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, keeper.publicKey) });
      return send(tx, [keeper]);
    },

    // The keeper (fee claimer) claims the platform's share and sends it to the platform wallet.
    async claimPartner(poolAddress, receiver) {
      const base = { feeClaimer: keeper.publicKey, payer: keeper.publicKey, pool: pk(poolAddress), maxBaseAmount: new BN(0), maxQuoteAmount: new BN(BIG) };
      const tx = await client.partner.claimPartnerTradingFee({ ...base, receiver: pk(receiver), tempWSolAcc: spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, keeper.publicKey) });
      return send(tx, [keeper]);
    },
  };
}

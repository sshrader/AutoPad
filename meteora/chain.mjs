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
  // Newer SDKs return the pool wrapped as { poolState }; older ones return the pool itself. null = no such pool (yet).
  const getPoolState = async poolAddress => { const r = await client.state.getPool(pk(poolAddress)); return r ? (r.poolState || r) : null; };

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

    // A visitor's launch. The VISITOR pays (rent and the first buy) and signs as buyer; the keeper signs only as the on-chain
    // creator, so it can later claim the creator fees for them. Returns the transaction, already signed by the keeper and the
    // new mint, for the visitor's wallet to sign and send.
    async prepareLaunch({ config, name, symbol, uri, buyer, buySol }) {
      const mint = Keypair.generate(), buyerPk = pk(buyer);
      const createPoolParam = { baseMint: mint.publicKey, config: pk(config), name, symbol, uri, payer: buyerPk, poolCreator: keeper.publicKey };
      const buyAmount = new BN(toLamports(buySol || 0));
      let tx;
      if (buyAmount.gtn(0)) {
        const made = await client.creator.createPoolWithFirstBuy({
          createPoolParam,
          firstBuyParam: { buyer: buyerPk, buyAmount, minimumAmountOut: new BN(0), referralTokenAccount: null }, // same transaction as creation, so nobody can get in front
        });
        tx = made.createPoolTx || made;
      } else {
        tx = await client.creator.createPool(createPoolParam);
      }
      tx.feePayer = buyerPk;
      tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      tx.partialSign(keeper, mint);
      const pool = sdk.deriveDbcPoolAddress(spl.NATIVE_MINT, mint.publicKey, pk(config));
      return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), mint: mint.publicKey.toBase58(), pool: pool.toBase58() };
    },

    // Did this launch really happen, and is the keeper the pool's creator? Used before a coin is listed.
    async confirmLaunch({ pool, mint }) {
      try {
        const p = await getPoolState(pool);
        if (!p) { console.error('confirmLaunch: pool ' + pool + ' not on chain yet'); return false; }
        const str = x => (x && x.toBase58 ? x.toBase58() : x ? String(x) : '');
        const baseMint = str(p.baseMint || p.tokenMint), creator = str(p.creator || p.poolCreator);
        if (!baseMint || !creator) { console.error('confirmLaunch: unexpected pool fields: ' + Object.keys(p).join(', ')); return false; }
        const ok = baseMint === mint && creator === keeper.publicKey.toBase58();
        if (!ok) console.error('confirmLaunch: pool ' + pool + ' has baseMint=' + baseMint + ' (want ' + mint + '), creator=' + creator + ' (want ' + keeper.publicKey.toBase58() + ')');
        return ok;
      } catch (err) { console.error('confirmLaunch: pool ' + pool + ' not readable yet: ' + String((err && err.message) || err).slice(0, 160)); return false; }
    },

    // A buy (amount in SOL) or sell (amount = percent of the visitor's tokens). The minimum received comes from a quote with
    // 15% slippage; if no quote can be made the trade is refused instead of sent with no protection.
    async prepareSwap({ pool, wallet, side, amount }) {
      const owner = pk(wallet), poolPk = pk(pool);
      const p = await getPoolState(poolPk);
      if (!p) { const e = new Error('unknown_coin'); e.code = 'unknown_coin'; throw e; }
      if (p.isMigrated) { const e = new Error('migrated'); e.code = 'migrated'; throw e; }
      let amountIn;
      if (side === 'buy') amountIn = new BN(toLamports(amount));
      else {
        const ata = spl.getAssociatedTokenAddressSync(p.baseMint, owner, false, spl.TOKEN_2022_PROGRAM_ID);
        let held = '0';
        try { held = (await connection.getTokenAccountBalance(ata)).value.amount; } catch { held = '0'; }
        amountIn = new BN(held).muln(Math.round(amount * 100)).divn(10000);
        if (amountIn.isZero()) { const e = new Error('nothing_to_sell'); e.code = 'nothing_to_sell'; throw e; }
      }
      let minOut;
      const config0 = await client.state.getPoolConfig(p.config);
      const config = config0 && config0.config ? config0.config : config0; // unwrap if a newer SDK wraps it
      const point = Number(config.activationType) === 1 ? new BN(Math.floor(Date.now() / 1000)) : new BN(await connection.getSlot());
      const base = { virtualPool: p, config, swapBaseForQuote: side === 'sell', hasReferral: false, currentPoint: point, slippageBps: 1500 };
      const tries = [
        ['swapQuote', () => client.pool.swapQuote({ ...base, amountIn, eligibleForFirstSwapWithMinFee: false })],
        ['swapQuote2', () => client.pool.swapQuote2({ ...base, swapMode: pick('SwapMode', 'ExactIn', 0), amountIn })],
      ];
      for (const [label, run] of tries) {
        try {
          const q = await run(); // some SDK versions return a promise, some a value
          const m = q && (q.minimumAmountOut || q.minimumOutputAmount || q.outputAmount);
          if (m) { minOut = m; break; }
          console.error('prepareSwap: ' + label + ' gave no minimum; got keys: ' + Object.keys(q || {}).join(', '));
        } catch (err) { console.error('prepareSwap: ' + label + ' failed: ' + String((err && err.message) || err).slice(0, 200)); }
      }
      if (!minOut) { const e = new Error('quote_failed'); e.code = 'quote_failed'; throw e; }
      const tx = await client.pool.swap({ owner, amountIn, minimumAmountOut: minOut, swapBaseForQuote: side === 'sell', pool: poolPk, poolAddress: poolPk, referralTokenAccount: null });
      tx.feePayer = owner;
      tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), amountIn: amountIn.toString(), minOut: minOut.toString() };
    },

    // Live numbers for the coin page.
    async poolInfo(poolAddress) {
      const pool = pk(poolAddress);
      const p = await getPoolState(pool);
      if (!p) throw new Error('pool not found');
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

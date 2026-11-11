// The fee claimer. For each real coin it looks at the fees waiting, and (only when told to send) claims the creator's share and
// sends it to the creator's wallet, then claims the platform's share and sends it to the platform wallet. In dry mode it only
// reports what it would send. `chain` is injected so this logic can be tested without the network.
export async function runClaims({ chain, coins, platformWallet, minLamports = 0, send = false, now = Date.now }) {
  const out = [];
  for (const coin of coins) {
    if (coin.simulated || !coin.pool) continue;
    const entry = { id: coin.id, symbol: coin.symbol, at: now(), mode: send ? 'sent' : 'dry' };
    try {
      const f = await chain.fees(coin.pool);
      entry.creatorLamports = f.creatorPending;
      entry.platformLamports = f.partnerPending;
      entry.creator = coin.creator;
      entry.platform = platformWallet;
      if (f.creatorPending + f.partnerPending < minLamports) { entry.skipped = 'below_minimum'; out.push(entry); continue; }
      if (send) {
        if (f.creatorPending > 0) entry.creatorTx = await chain.claimCreator(coin.pool, coin.creator);
        if (f.partnerPending > 0) entry.platformTx = await chain.claimPartner(coin.pool, platformWallet);
      }
    } catch (e) {
      entry.error = String((e && e.message) || e).slice(0, 200);
    }
    out.push(entry);
  }
  return out;
}

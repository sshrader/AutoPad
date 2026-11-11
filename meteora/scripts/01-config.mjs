// Makes the curve config for the test site. A config is PERMANENT (it cannot be edited), so this shows the numbers and
// does nothing until you add --yes. The keeper wallet pays the small rent and becomes the fee claimer.
// Usage: node scripts/01-config.mjs [--supply N] [--start-mcap SOL] [--grad-mcap SOL] [--fee-start-bps N] [--fee-bps N] [--fee-periods N] [--fee-duration N] [--no-first-swap-min-fee] [--creator-pct N] [--yes]
import { Connection, Keypair } from '@solana/web3.js';
import { env, clusterName, rpcUrl, keeperBytes, requireMainnetOk, sol } from '../lib.mjs';
import { createChain } from '../chain.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const cluster = clusterName(); requireMainnetOk(cluster);
const o = { supply: Number(arg('supply', '1000000000')), startMcap: Number(arg('start-mcap', '144')), gradMcap: Number(arg('grad-mcap', '719')), feeStartBps: Number(arg('fee-start-bps', '5000')), feeBps: Number(arg('fee-bps', '350')), feePeriods: Number(arg('fee-periods', '8')), feeDuration: Number(arg('fee-duration', '8')), firstSwapMinFee: !process.argv.includes('--no-first-swap-min-fee'), creatorPct: Number(arg('creator-pct', '90')) };
const connection = new Connection(rpcUrl(cluster), 'confirmed');
const keeper = Keypair.fromSecretKey(keeperBytes());
console.log('Network:        ' + cluster);
console.log('Keeper wallet:  ' + keeper.publicKey.toBase58() + '  (' + sol(await connection.getBalance(keeper.publicKey)).toFixed(4) + ' SOL)');
console.log('Supply:         ' + o.supply.toLocaleString() + ' tokens (Token-2022, 6 decimals)');
console.log('Market cap:     starts ~' + o.startMcap + ' SOL, graduates at ~' + o.gradMcap + ' SOL');
console.log('Trading fee:    starts at ' + (o.feeStartBps / 100) + '% and falls in ' + o.feePeriods + ' steps over ' + o.feeDuration + ' slots (about ' + (o.feeDuration * 0.4).toFixed(1) + ' seconds) to ' + (o.feeBps / 100) + '%, then stays there. First swap (the launch buy) pays the lowest fee: ' + (o.firstSwapMinFee ? 'yes' : 'no') + '. Paid in SOL; creator share ' + o.creatorPct + '% (the rest is the platform\'s, before Meteora\'s own cut)');
console.log('Fee claimer:    the keeper wallet. After graduation, liquidity is locked for good.');
if (!process.argv.includes('--yes')) { console.log('\nNothing was created. Run again with --yes to create this config. It cannot be changed afterwards.'); process.exit(0); }
const chain = await createChain({ connection, keeper });
const r = await chain.createConfig(o);
console.log('\nConfig created: https://explorer.solana.com/tx/' + r.sig + (cluster === 'mainnet-beta' ? '' : '?cluster=devnet'));
console.log('Save this as DBC_CONFIG:  ' + r.config);

// Makes the curve config for the test site. A config is PERMANENT (it cannot be edited), so this shows the numbers and
// does nothing until you add --yes. The keeper wallet pays the small rent and becomes the fee claimer.
// Usage: node scripts/01-config.mjs [--supply N] [--start-mcap SOL] [--grad-mcap SOL] [--fee-bps N] [--creator-pct N] [--yes]
import { Connection, Keypair } from '@solana/web3.js';
import { env, clusterName, rpcUrl, keeperBytes, requireMainnetOk, sol } from '../lib.mjs';
import { createChain } from '../chain.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const cluster = clusterName(); requireMainnetOk(cluster);
const o = { supply: Number(arg('supply', '1000000000')), startMcap: Number(arg('start-mcap', '30')), gradMcap: Number(arg('grad-mcap', '330')), feeBps: Number(arg('fee-bps', '100')), creatorPct: Number(arg('creator-pct', '90')) };
const connection = new Connection(rpcUrl(cluster), 'confirmed');
const keeper = Keypair.fromSecretKey(keeperBytes());
console.log('Network:        ' + cluster);
console.log('Keeper wallet:  ' + keeper.publicKey.toBase58() + '  (' + sol(await connection.getBalance(keeper.publicKey)).toFixed(4) + ' SOL)');
console.log('Supply:         ' + o.supply.toLocaleString() + ' tokens (Token-2022, 6 decimals)');
console.log('Market cap:     starts ~' + o.startMcap + ' SOL, graduates at ~' + o.gradMcap + ' SOL');
console.log('Trading fee:    ' + (o.feeBps / 100) + '% flat, paid in SOL; creator share ' + o.creatorPct + '% (the rest is the platform\'s, before Meteora\'s own cut)');
console.log('Fee claimer:    the keeper wallet. After graduation, liquidity is locked for good.');
if (!process.argv.includes('--yes')) { console.log('\nNothing was created. Run again with --yes to create this config. It cannot be changed afterwards.'); process.exit(0); }
const chain = await createChain({ connection, keeper });
const r = await chain.createConfig(o);
console.log('\nConfig created: https://explorer.solana.com/tx/' + r.sig + (cluster === 'mainnet-beta' ? '' : '?cluster=devnet'));
console.log('Save this as DBC_CONFIG:  ' + r.config);

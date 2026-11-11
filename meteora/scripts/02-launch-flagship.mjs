// Launches the real flagship coin: ONE transaction creates the pool and makes the first buy, signed only by the keeper wallet.
// The tokens from the first buy and all future creator fees go to FLAGSHIP_CREATOR. Run 01-config.mjs first. Needs --yes.
// Before it spends anything it checks that the live site is serving this coin's metadata (name, symbol, image).
import { Connection, Keypair } from '@solana/web3.js';
import { env, clusterName, rpcUrl, keeperBytes, requireMainnetOk, sol, isAddress } from '../lib.mjs';
import { createChain } from '../chain.mjs';
import { flagshipFromEnv } from '../coins.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const cluster = clusterName(); requireMainnetOk(cluster);
const config = env('DBC_CONFIG'), siteUrl = env('SITE_URL').replace(/\/+$/, ''), buySol = Number(arg('buy', '0.05'));
const flag = flagshipFromEnv();
const fail = m => { console.error(m); process.exit(1); };
if (!isAddress(config)) fail('Set DBC_CONFIG to the config address printed by 01-config.mjs.');
if (!flag.creator) fail('Set FLAGSHIP_CREATOR to the flagship creator wallet address (a public address).');
if (!/^https:\/\//.test(siteUrl)) fail('Set SITE_URL to the live https address of the test site (its metadata must be reachable).');
const connection = new Connection(rpcUrl(cluster), 'confirmed');
const keeper = Keypair.fromSecretKey(keeperBytes());
const bal = sol(await connection.getBalance(keeper.publicKey));

const metaUrl = siteUrl + '/meta/flagship.json';
let meta; try { meta = await (await fetch(metaUrl)).json(); } catch { fail('Could not read ' + metaUrl + '. Deploy the site first.'); }
if (meta.name !== flag.name || meta.symbol !== flag.symbol) fail('The live site serves a different name/symbol than FLAGSHIP_NAME/FLAGSHIP_SYMBOL here.');
const img = await fetch(meta.image); if (!img.ok) fail('The coin image is not reachable at ' + meta.image);

console.log('Network:         ' + cluster);
console.log('Coin:            ' + flag.name + ' ($' + flag.symbol + ')');
console.log('Metadata:        ' + metaUrl);
console.log('Config:          ' + config);
console.log('Creator wallet:  ' + flag.creator + '  (gets the first-buy tokens and all creator fees)');
console.log('Keeper wallet:   ' + keeper.publicKey.toBase58() + '  (' + bal.toFixed(4) + ' SOL) pays rent and the ' + buySol + ' SOL first buy');
if (bal < buySol + 0.06) fail('The keeper needs at least ' + (buySol + 0.06).toFixed(2) + ' SOL for the buy plus rent. Top it up and run again.');
if (!process.argv.includes('--yes')) { console.log('\nNothing was launched. Run again with --yes to launch for real.'); process.exit(0); }
const chain = await createChain({ connection, keeper });
const r = await chain.launch({ config, name: flag.name, symbol: flag.symbol, uri: metaUrl, tokensTo: flag.creator, buySol });
console.log('\nLaunched: https://explorer.solana.com/tx/' + r.sig + (cluster === 'mainnet-beta' ? '' : '?cluster=devnet'));
console.log('Set these in the site\'s settings:\n  FLAGSHIP_MINT=' + r.mint + '\n  FLAGSHIP_POOL=' + r.pool);

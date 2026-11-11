// The fee claimer. Default is a DRY RUN: it lists the fees waiting and who they would go to, and sends nothing.
// Add --send to really claim: the creator's share goes to the creator wallet, the platform's share to PLATFORM_WALLET.
// Usage: node scripts/04-claim.mjs [--send] [--min-sol 0.001]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair } from '@solana/web3.js';
import { env, clusterName, rpcUrl, keeperBytes, requireMainnetOk, readJson, writeJson, isAddress, lamports } from '../lib.mjs';
import { createChain } from '../chain.mjs';
import { runClaims } from '../claimer.mjs';
import { loadCoins } from '../coins.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const send = process.argv.includes('--send');
const cluster = clusterName(); if (send) requireMainnetOk(cluster);
const platformWallet = env('PLATFORM_WALLET');
if (!isAddress(platformWallet)) { console.error('Set PLATFORM_WALLET to the platform wallet address (a public address).'); process.exit(1); }
const connection = new Connection(rpcUrl(cluster), 'confirmed');
const keeper = Keypair.fromSecretKey(keeperBytes());
const chain = await createChain({ connection, keeper });
const log = await runClaims({ chain, coins: loadCoins(), platformWallet, minLamports: lamports(arg('min-sol', '0')), send });
for (const e of log) console.log(e.symbol + ': creator ' + (e.creatorLamports / 1e9).toFixed(6) + ' SOL, platform ' + (e.platformLamports / 1e9).toFixed(6) + ' SOL, ' + (e.skipped || e.error || e.mode) + (e.creatorTx ? '\n   creator tx ' + e.creatorTx : '') + (e.platformTx ? '\n   platform tx ' + e.platformTx : ''));
if (!log.length) console.log('No launched coins found. Set FLAGSHIP_MINT and FLAGSHIP_POOL first.');
if (send && log.length) {
  const file = path.join(env('DATA_DIR', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')), 'payouts.json');
  writeJson(file, readJson(file, []).concat(log));
  console.log('Saved to ' + file);
} else if (!send) console.log('\nDry run: nothing was sent. Add --send to claim and pay out.');

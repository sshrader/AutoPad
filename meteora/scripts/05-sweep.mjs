// Moves SOL from the keeper wallet to another wallet of yours. Dry run unless you add --yes.
// Usage: node scripts/05-sweep.mjs --to <your wallet address> [--keep 0.05] [--yes]
// The keeper pays for launches and claims, so leave some SOL in it while the site is running (--keep).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { clusterName, rpcUrl, keeperBytes, requireMainnetOk, isAddress, sol, lamports } from '../lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const cluster = clusterName(); const yes = process.argv.includes('--yes'); if (yes) requireMainnetOk(cluster);
const to = arg('to', '');
if (!isAddress(to)) { console.error('Add --to followed by the wallet address that should receive the SOL.'); process.exit(1); }
const connection = new Connection(rpcUrl(cluster), 'confirmed');
const keeper = Keypair.fromSecretKey(keeperBytes());
if (keeper.publicKey.toBase58() === to) { console.error('That is the keeper wallet itself. Use your main wallet address.'); process.exit(1); }
const have = await connection.getBalance(keeper.publicKey);
const keep = lamports(arg('keep', '0'));
const send = have - keep - 5000; // 5000 lamports pays the network fee
console.log('Network:      ' + cluster);
console.log('From keeper:  ' + keeper.publicKey.toBase58() + '  (' + sol(have).toFixed(6) + ' SOL)');
console.log('To:           ' + to);
console.log('Keeping:      ' + sol(keep).toFixed(6) + ' SOL');
if (send <= 0) { console.log('\nNothing to send.'); process.exit(0); }
console.log('Sending:      ' + sol(send).toFixed(6) + ' SOL');
if (!yes) { console.log('\nDry run: nothing was sent. Add --yes to send.'); process.exit(0); }
const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: new PublicKey(to), lamports: send }));
const sig = await sendAndConfirmTransaction(connection, tx, [keeper], { commitment: 'confirmed' });
console.log('\nSent: https://explorer.solana.com/tx/' + sig + (cluster === 'mainnet-beta' ? '' : '?cluster=devnet'));

// Settings and small helpers shared by the site and the scripts. Secrets come ONLY from environment variables or key files
// kept outside the repo. Never paste them into chat or commit them.
import fs from 'node:fs';

export const env = (name, fallback = '') => String(process.env[name] ?? fallback).trim();
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddress = s => B58.test(String(s || ''));

export function clusterName() {
  const c = env('CLUSTER', 'devnet');
  if (c !== 'devnet' && c !== 'mainnet-beta') throw new Error('CLUSTER must be devnet or mainnet-beta.');
  return c;
}

export function rpcUrl(cluster = clusterName()) {
  const u = env('RPC_URL');
  if (cluster === 'devnet') {
    if (/mainnet/i.test(u)) throw new Error('RPC_URL looks like mainnet but CLUSTER is devnet.');
    return u || 'https://api.devnet.solana.com';
  }
  if (!u || /devnet|testnet/i.test(u)) throw new Error('Set RPC_URL to a mainnet RPC address.');
  return u;
}

// The keeper wallet: KEEPER_SECRET_KEY holds the wallet file's contents (a list of 64 numbers),
// KEEPER_KEYPAIR is the path of a wallet file instead (handy on your own computer).
export function keeperBytes() {
  let text = env('KEEPER_SECRET_KEY');
  if (!text && env('KEEPER_KEYPAIR')) text = fs.readFileSync(env('KEEPER_KEYPAIR'), 'utf8');
  let bytes = null;
  try { if (text.trim()[0] === '[') bytes = Uint8Array.from(JSON.parse(text)); } catch { bytes = null; }
  if (!bytes || bytes.length !== 64) throw new Error('Set KEEPER_KEYPAIR to the path of the keeper wallet file (or KEEPER_SECRET_KEY to its contents).');
  return bytes;
}

export const sol = lamports => Number(lamports) / 1e9;
export const lamports = solAmount => Math.round(Number(solAmount) * 1e9);

// Scripts that spend real money must be told twice.
export function requireMainnetOk(cluster) {
  if (cluster === 'mainnet-beta' && env('MAINNET_OK') !== 'yes') {
    console.error('Mainnet spends real money. Set MAINNET_OK=yes to continue.');
    process.exit(1);
  }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, data) {
  fs.mkdirSync(file.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

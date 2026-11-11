// The AutoPay-on-Meteora test site: a small read-only web server. It shows the real flagship coin (live from the chain once
// its pool is set) next to clearly labelled demo coins, plus the payout log. It holds NO secrets and cannot spend anything.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, clusterName, readJson, sol, isAddress } from './lib.mjs';
import { loadCoins, launched } from './coins.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createApp({ e = env, chain = null, now = Date.now, dataDir = e('DATA_DIR', path.join(HERE, 'data')) } = {}) {
  const cluster = e('CLUSTER', 'devnet');
  const siteUrl = e('SITE_URL').replace(/\/+$/, '');
  const platformWallet = e('PLATFORM_WALLET');
  const cache = new Map(); // coin id -> { at, value }

  async function live(coin) {
    if (!chain || coin.simulated || !launched(coin)) return null;
    const hit = cache.get(coin.id);
    if (hit && now() - hit.at < 20000) return hit.value;
    let value = null;
    try {
      const [info, fees] = await Promise.all([chain.poolInfo(coin.pool), chain.fees(coin.pool)]);
      value = { ...info, collectedSol: sol(fees.totalCollected), pendingCreatorSol: sol(fees.creatorPending), pendingPlatformSol: sol(fees.partnerPending) };
    } catch { value = null; }
    cache.set(coin.id, { at: now(), value });
    return value;
  }

  const payoutLog = () => readJson(path.join(dataDir, 'payouts.json'), []);

  async function view(coin) {
    const base = { id: coin.id, name: coin.name, symbol: coin.symbol, description: coin.description, creator: coin.creator, simulated: coin.simulated, flagship: coin.flagship, color: coin.color || '', image: coin.image || '', mint: coin.mint || '', pool: coin.pool || '', launched: coin.simulated ? true : launched(coin) };
    if (coin.simulated) return { ...base, stats: { progress: coin.progress, mcapSol: coin.mcapSol, collectedSol: coin.feesSol, paidSol: coin.paidSol, trades: coin.trades, ageHours: coin.ageHours } };
    return { ...base, live: await live(coin) };
  }

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read_only' });
    const coins = loadCoins(e);
    if (p === '/api/config') return json(res, 200, { cluster, platformWallet, siteUrl, explorer: 'https://explorer.solana.com', explorerSuffix: cluster === 'mainnet-beta' ? '' : '?cluster=devnet' });
    if (p === '/api/coins') return json(res, 200, await Promise.all(coins.map(view)));
    if (p.startsWith('/api/coins/')) {
      const coin = coins.find(c => c.id === decodeURIComponent(p.slice(11)));
      return coin ? json(res, 200, await view(coin)) : json(res, 404, { error: 'not_found' });
    }
    if (p === '/api/payouts') return json(res, 200, payoutLog().slice(-50).reverse());
    if (p === '/meta/flagship.json') {
      const f = coins[0];
      return json(res, 200, { name: f.name, symbol: f.symbol, description: f.description, image: siteUrl + '/flagship.png', external_url: siteUrl });
    }
    let file = p === '/' ? '/index.html' : p === '/coin' ? '/coin.html' : p;
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(full));
  }
  return (req, res) => handler(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'server_error' }); else res.end(); });
}

// Start the server only when run directly (not when a test imports it).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let chain = null;
  const c = clusterName();
  if (env('RPC_URL') && isAddress(env('FLAGSHIP_POOL'))) {
    // Read-only: a throwaway key that never holds anything, only so the SDK can be built.
    const { rpcUrl } = await import('./lib.mjs');
    const { Connection, Keypair } = await import('@solana/web3.js');
    const { createChain } = await import('./chain.mjs');
    chain = await createChain({ connection: new Connection(rpcUrl(c), 'confirmed'), keeper: Keypair.generate() });
  }
  const port = Number(env('PORT', '3000'));
  http.createServer(createApp({ chain })).listen(port, () => console.log('AutoPay on Meteora (' + c + ') on port ' + port));

  // OPTIONAL fee claimer inside the site, OFF by default. AUTOCLAIM=dry only logs what it would send; AUTOCLAIM=yes really
  // sends. Turning it on means putting the keeper wallet's key in this site's settings (KEEPER_SECRET_KEY).
  const mode = env('AUTOCLAIM');
  if ((mode === 'yes' || mode === 'dry') && isAddress(env('FLAGSHIP_POOL')) && isAddress(env('PLATFORM_WALLET'))) {
    const { Connection, Keypair } = await import('@solana/web3.js');
    const { rpcUrl, keeperBytes, readJson, writeJson, lamports } = await import('./lib.mjs');
    const { createChain } = await import('./chain.mjs');
    const { runClaims } = await import('./claimer.mjs');
    const keeper = Keypair.fromSecretKey(keeperBytes());
    const claimChain = await createChain({ connection: new Connection(rpcUrl(c), 'confirmed'), keeper });
    const file = path.join(env('DATA_DIR', path.join(HERE, 'data')), 'payouts.json');
    const everyMs = Math.max(1, Number(env('AUTOCLAIM_EVERY_MIN', '10'))) * 60000;
    const tick = async () => {
      try {
        const log = await runClaims({ chain: claimChain, coins: loadCoins(), platformWallet: env('PLATFORM_WALLET'), minLamports: lamports(env('AUTOCLAIM_MIN_SOL', '0.001')), send: mode === 'yes' });
        const acted = log.filter(x => !x.skipped);
        if (acted.length) writeJson(file, readJson(file, []).concat(acted).slice(-200));
      } catch (err) { console.error('claim run failed:', err.message); }
    };
    setInterval(tick, everyMs); setTimeout(tick, 15000);
    console.log('Fee claimer on (' + mode + '), every ' + everyMs / 60000 + ' min.');
  }
}

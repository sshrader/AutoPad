// The AutoPay-on-Meteora test site: a small read-only web server. It shows the real flagship coin (live from the chain once
// its pool is set) next to clearly labelled demo coins, plus the payout log. It holds NO secrets and cannot spend anything.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, clusterName, readJson, writeJson, sol, isAddress, lamports } from './lib.mjs';
import { runClaims } from './claimer.mjs';
import { loadCoins, launched } from './coins.mjs';
import { createStore } from './store.mjs';
import { checkLaunch, checkTrade, createLimiter } from './launchcheck.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createApp({ e = env, chain = null, canClaim = false, store = null, now = Date.now, rand = () => Math.random().toString(36).slice(2, 6), dataDir = e('DATA_DIR', path.join(HERE, 'data')) } = {}) {
  const cluster = e('CLUSTER', 'devnet');
  const siteUrl = e('SITE_URL').replace(/\/+$/, '');
  const platformWallet = e('PLATFORM_WALLET');
  const dbcConfig = e('DBC_CONFIG');
  const launchOn = e('LAUNCH') === 'yes' && Boolean(chain && chain.prepareLaunch && store && isAddress(dbcConfig) && /^https:\/\//.test(siteUrl));
  if (e('LAUNCH') !== 'yes') console.log('Launching is off: LAUNCH is "' + e('LAUNCH') + '" (it must be exactly yes).');
  else if (!isAddress(dbcConfig)) console.log('Launching is off: DBC_CONFIG is missing or not a valid address.');
  else if (!/^https:\/\//.test(siteUrl)) console.log('Launching is off: SITE_URL must start with https://.');
  else if (!(chain && chain.prepareLaunch && store)) console.log('Launching is off: the chain connection is not set up (check RPC_URL).');
  const tradeOn = e('TRADE') !== 'no' && Boolean(chain && chain.prepareSwap);
  const maxBuySol = Number(e('LAUNCH_MAX_BUY', '2'));
  const claimOn = Boolean(canClaim && chain && chain.claimCreator && chain.claimPartner && isAddress(platformWallet) && e('CLAIM_BUTTON') !== 'no');
  const claimMinLamports = lamports(e('CLAIM_BUTTON_MIN_SOL', '0.001'));
  const claimCooldownMs = Math.max(0, Number(e('CLAIM_BUTTON_COOLDOWN_MIN', '10'))) * 60000;
  const claimedAt = new Map(); // coin id -> time of the last claim attempt (or in progress)
  const limit = createLimiter({ now });
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
    const base = { id: coin.id, name: coin.name, symbol: coin.symbol, description: coin.description, creator: coin.creator, website: coin.website || '', twitter: coin.twitter || '', telegram: coin.telegram || '', simulated: coin.simulated, flagship: coin.flagship, color: coin.color || '', image: coin.image || '', mint: coin.mint || '', pool: coin.pool || '', launched: coin.simulated ? true : launched(coin) };
    if (coin.simulated) return { ...base, stats: { progress: coin.progress, mcapSol: coin.mcapSol, collectedSol: coin.feesSol, paidSol: coin.paidSol, trades: coin.trades, ageHours: coin.ageHours } };
    return { ...base, live: await live(coin) };
  }

  // Token metadata that wallets and trading sites read (name, picture, website, X, Telegram).
  const metaOf = (c, image, external) => {
    const m = { name: c.name, symbol: c.symbol, description: c.description, image, external_url: external };
    if (c.website) m.website = c.website;
    if (c.twitter) m.twitter = c.twitter;
    if (c.telegram) m.telegram = c.telegram;
    return m;
  };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  function readBody(req, max = 700000) {
    return new Promise((resolve, reject) => {
      let size = 0, over = false; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > 5000000) { req.destroy(); return; } // a huge upload is just cut off
        if (size > max) over = true; else chunks.push(c); // a big one is read and thrown away so we can answer it properly
      });
      req.on('end', () => {
        if (over) return reject(Object.assign(new Error('too_big'), { code: 'too_big' }));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('bad_json'), { code: 'bad_json' })); }
      });
      req.on('error', reject);
    });
  }

  async function post(req, res, p) {
    if (!['/api/launch/prepare', '/api/launch/confirm', '/api/trade/prepare', '/api/claim'].includes(p)) return json(res, 404, { error: 'not_found' });
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, err.code === 'too_big' ? 413 : 400, { error: err.code || 'bad_request' }); }
    const ip = ipOf(req);

    if (p === '/api/claim') {
      // Anyone may press it, but fees only ever go to the coin's creator wallet and the platform wallet.
      if (!claimOn) return json(res, 403, { error: 'claim_off' });
      if (!limit('k:' + ip, 20, 3600000)) return json(res, 429, { error: 'slow_down' });
      const coin = loadCoins(e, store).find(x => x.id === String(body.id || '') && !x.simulated && x.pool && launched(x));
      if (!coin) return json(res, 404, { error: 'unknown_coin' });
      const last = claimedAt.get(coin.id);
      if (last && now() - last < claimCooldownMs) return json(res, 429, { error: 'claimed_recently', waitMin: Math.max(1, Math.ceil((claimCooldownMs - (now() - last)) / 60000)) });
      claimedAt.set(coin.id, now()); // also blocks a second press while this one is running
      try {
        const [r] = await runClaims({ chain, coins: [coin], platformWallet, minLamports: claimMinLamports, send: true, now });
        if (!r || r.skipped) { claimedAt.delete(coin.id); return json(res, 400, { error: 'too_small', minSol: sol(claimMinLamports) }); }
        if (r.error) return json(res, 500, { error: 'claim_failed' });
        try { writeJson(path.join(dataDir, 'payouts.json'), readJson(path.join(dataDir, 'payouts.json'), []).concat(r).slice(-200)); } catch { /* the claim already happened; the log is a convenience */ }
        cache.delete(coin.id);
        return json(res, 200, { ok: true, creatorSol: sol(r.creatorLamports), platformSol: sol(r.platformLamports), creatorTx: r.creatorTx || '', platformTx: r.platformTx || '' });
      } catch { return json(res, 500, { error: 'claim_failed' }); }
    }

    if (p === '/api/trade/prepare') {
      if (!tradeOn) return json(res, 403, { error: 'trade_off' });
      if (!limit('t:' + ip, 60, 3600000)) return json(res, 429, { error: 'slow_down' });
      const c = checkTrade(body);
      if (c.error) return json(res, 400, { error: c.error });
      const known = loadCoins(e, store).find(x => x.pool === c.ok.pool && !x.simulated);
      if (!known) return json(res, 404, { error: 'unknown_coin' });
      try { return json(res, 200, await chain.prepareSwap(c.ok)); } catch (err) {
        const code = err && err.code;
        return json(res, ['migrated', 'nothing_to_sell', 'quote_failed'].includes(code) ? 400 : 500, { error: ['migrated', 'nothing_to_sell', 'quote_failed'].includes(code) ? code : 'trade_failed' });
      }
    }

    if (!launchOn) return json(res, 403, { error: 'launch_off' });
    if (p === '/api/launch/prepare') {
      if (!limit('l:' + ip, 8, 3600000)) return json(res, 429, { error: 'slow_down' });
      const c = checkLaunch(body, { maxBuySol });
      if (c.error) return json(res, 400, { error: c.error });
      // Until the flagship exists, only the flagship creator's wallet may launch.
      const top = loadCoins(e, store)[0];
      if (top.creator && !launched(top) && c.ok.wallet !== top.creator) return json(res, 403, { error: 'flagship_first' });
      const id = c.ok.symbol.toLowerCase() + '-' + rand();
      const uri = siteUrl + '/meta/' + id + '.json';
      try {
        const made = await chain.prepareLaunch({ config: dbcConfig, name: c.ok.name, symbol: c.ok.symbol, uri, buyer: c.ok.wallet, buySol: c.ok.buySol });
        store.addPending({ id, name: c.ok.name, symbol: c.ok.symbol, description: c.ok.description, website: c.ok.website, twitter: c.ok.twitter, telegram: c.ok.telegram, creator: c.ok.wallet, mint: made.mint, pool: made.pool }, c.ok.image, c.ok.ext);
        return json(res, 200, { id, tx: made.tx, mint: made.mint, pool: made.pool });
      } catch { return json(res, 500, { error: 'launch_failed' }); }
    }

    // confirm: only lists the coin once the pool exists on chain with the keeper as its creator
    const pending = store.get(String(body.id || ''));
    if (!pending) return json(res, 404, { error: 'unknown_launch' });
    if (pending.status === 'live') return json(res, 200, { id: pending.id, ok: true });
    if (!limit('c:' + ip, 40, 3600000)) return json(res, 429, { error: 'slow_down' });
    const real = await chain.confirmLaunch({ pool: pending.pool, mint: pending.mint });
    if (!real) return json(res, 409, { error: 'not_on_chain_yet' });
    store.markLive(pending.id);
    return json(res, 200, { id: pending.id, ok: true });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'POST') return post(req, res, p);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
    const coins = loadCoins(e, store);
    if (p === '/api/config') return json(res, 200, { cluster, platformWallet, siteUrl, launch: launchOn, trade: tradeOn, claim: claimOn, claimMinSol: sol(claimMinLamports), maxBuySol, explorer: 'https://explorer.solana.com', explorerSuffix: cluster === 'mainnet-beta' ? '' : '?cluster=devnet' });
    if (p === '/api/coins') return json(res, 200, await Promise.all(coins.map(view)));
    if (p.startsWith('/api/coins/')) {
      const coin = coins.find(c => c.id === decodeURIComponent(p.slice(11)));
      return coin ? json(res, 200, await view(coin)) : json(res, 404, { error: 'not_found' });
    }
    if (p === '/api/payouts') return json(res, 200, payoutLog().slice(-50).reverse());
    if (p === '/meta/flagship.json') {
      const f = coins[0];
      return json(res, 200, metaOf(f, siteUrl + '/flagship.png', f.website || siteUrl));
    }
    const metaId = /^\/meta\/([a-z0-9-]{3,40})\.json$/.exec(p);
    if (metaId && store) {
      const c = store.get(metaId[1]);
      if (!c) return json(res, 404, { error: 'not_found' });
      return json(res, 200, metaOf(c, siteUrl + c.image, c.website || siteUrl + '/coin?id=' + c.id));
    }
    const img = /^\/img\/([a-z0-9-]{3,40}\.(png|jpg))$/.exec(p);
    if (img && store) {
      const f = store.imageFile(img[1]);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': img[2] === 'png' ? 'image/png' : 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(f));
    }
    const PAGES = { '/': '/index.html', '/coin': '/coin.html', '/launch': '/launch.html', '/how': '/how.html', '/rules': '/rules.html' };
    const file = PAGES[p] || p;
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(full));
  }
  return (req, res) => handler(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'server_error' }); else res.end(); });
}

// Start the server only when run directly (not when a test imports it).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let chain = null, canClaim = false;
  const c = clusterName();
  const dataDir = env('DATA_DIR', path.join(HERE, 'data'));
  const store = createStore({ dir: dataDir });
  if (env('RPC_URL')) {
    const { rpcUrl, keeperBytes } = await import('./lib.mjs');
    const { Connection, Keypair } = await import('@solana/web3.js');
    const { createChain } = await import('./chain.mjs');
    // Only when LAUNCH=yes does the site hold the keeper key (it must co-sign each launch as the pool's creator).
    // Otherwise it runs with a throwaway key that holds nothing.
    let keeper = Keypair.generate();
    if (env('LAUNCH') === 'yes') {
      try { keeper = Keypair.fromSecretKey(keeperBytes()); canClaim = env('CLAIM_BUTTON') !== 'no'; } catch (err) {
        console.error('LAUNCH is on but the keeper key is not usable, so launching is switched off: ' + err.message);
        process.env.LAUNCH = 'no';
      }
    }
    chain = await createChain({ connection: new Connection(rpcUrl(c), 'confirmed'), keeper });
  }
  const port = Number(env('PORT', '3000'));
  http.createServer(createApp({ chain, canClaim, store })).listen(port, () => console.log('AutoPayment on Meteora (' + c + ') on port ' + port));

  // OPTIONAL fee claimer inside the site, OFF by default. AUTOCLAIM=dry only logs what it would send; AUTOCLAIM=yes really
  // sends. Turning it on means putting the keeper wallet's key in this site's settings (KEEPER_SECRET_KEY).
  const mode = env('AUTOCLAIM');
  if ((mode === 'yes' || mode === 'dry') && isAddress(env('PLATFORM_WALLET'))) {
    const { Connection, Keypair } = await import('@solana/web3.js');
    const { rpcUrl, keeperBytes, readJson, writeJson, lamports } = await import('./lib.mjs');
    const { createChain } = await import('./chain.mjs');
    const { runClaims } = await import('./claimer.mjs');
    let keeper = null;
    try { keeper = Keypair.fromSecretKey(keeperBytes()); } catch (err) { console.error('AUTOCLAIM is on but the keeper key is not usable, so the claimer is off: ' + err.message); }
    if (!keeper) { /* no key: no claimer */ } else {
    const claimChain = await createChain({ connection: new Connection(rpcUrl(c), 'confirmed'), keeper });
    const file = path.join(env('DATA_DIR', path.join(HERE, 'data')), 'payouts.json');
    const everyMs = Math.max(1, Number(env('AUTOCLAIM_EVERY_MIN', '10'))) * 60000;
    const tick = async () => {
      try {
        const log = await runClaims({ chain: claimChain, coins: loadCoins(env, store), platformWallet: env('PLATFORM_WALLET'), minLamports: lamports(env('AUTOCLAIM_MIN_SOL', '0.001')), send: mode === 'yes' });
        const acted = log.filter(x => !x.skipped);
        if (acted.length) writeJson(file, readJson(file, []).concat(acted).slice(-200));
      } catch (err) { console.error('claim run failed:', err.message); }
    };
    setInterval(tick, everyMs); setTimeout(tick, 15000);
    console.log('Fee claimer on (' + mode + '), every ' + everyMs / 60000 + ' min.');
    }
  }
}

// The coins the site shows: demo coins (clearly simulated, no chain behind them) plus the real flagship coin, which is
// described by environment variables set after it is launched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, isAddress } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function flagshipFromEnv(e = env) {
  const creator = e('FLAGSHIP_CREATOR');
  return {
    id: 'flagship', flagship: true, simulated: false,
    name: e('FLAGSHIP_NAME', 'AutoPayment'), symbol: e('FLAGSHIP_SYMBOL', 'AUTO'),
    description: e('FLAGSHIP_DESCRIPTION', 'The first coin on AutoPayment. It pays its fees automatically, no hassle required.'),
    creator: isAddress(creator) ? creator : '', mint: isAddress(e('FLAGSHIP_MINT')) ? e('FLAGSHIP_MINT') : '', pool: isAddress(e('FLAGSHIP_POOL')) ? e('FLAGSHIP_POOL') : '',
    website: e('FLAGSHIP_WEBSITE'), twitter: e('FLAGSHIP_TWITTER'), telegram: e('FLAGSHIP_TELEGRAM'),
    image: '/flagship.png',
  };
}

export function loadCoins(e = env, store = null) {
  const demo = JSON.parse(fs.readFileSync(path.join(HERE, 'demo-coins.json'), 'utf8')).map(c => ({ ...c, simulated: true, flagship: false }));
  let flagship = flagshipFromEnv(e);
  // The flagship is always first. Before it is launched it shows as "not launched yet" instead of pretending.
  // HIDE_COINS (or HIDE_POOLS) takes coin ids, mint addresses (the CA) or pool addresses, comma separated.
  const hidden = new Set((e('HIDE_COINS') + ',' + e('HIDE_POOLS')).split(',').map(x => x.trim()).filter(Boolean));
  const isHidden = x => hidden.has(x.id) || (x.mint && hidden.has(x.mint)) || (x.pool && hidden.has(x.pool));
  if (isHidden(flagship)) flagship = { ...flagship, mint: '', pool: '' }; // an old flagship set by FLAGSHIP_MINT/POOL goes back to "not launched"
  let made = store ? store.list().filter(x => !isHidden(x)).map(x => ({ ...x, simulated: false, flagship: false })) : [];
  // The flagship is the pool set in FLAGSHIP_POOL (launched by script), or else the first coin launched through the site by
  // the FLAGSHIP_CREATOR wallet. Until one exists it shows as "not launched".
  let top = flagship;
  if (!launched(flagship) && flagship.creator) {
    const mine = made.filter(x => x.creator === flagship.creator).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (mine) { top = { ...mine, flagship: true }; made = made.filter(x => x.id !== mine.id); }
  }
  return [top, ...made, ...demo];
}

export const launched = coin => Boolean(coin.pool && coin.mint);

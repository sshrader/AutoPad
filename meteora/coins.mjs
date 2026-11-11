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
    image: '/flagship.png',
  };
}

export function loadCoins(e = env) {
  const demo = JSON.parse(fs.readFileSync(path.join(HERE, 'demo-coins.json'), 'utf8')).map(c => ({ ...c, simulated: true, flagship: false }));
  const flagship = flagshipFromEnv(e);
  // The flagship is always first. Before it is launched it shows as "not launched yet" instead of pretending.
  return [flagship, ...demo];
}

export const launched = coin => Boolean(coin.pool && coin.mint);

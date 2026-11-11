// Coins launched through the site, kept in a JSON file (plus their pictures) in the data folder. On Railway attach a volume and
// point DATA_DIR at it, otherwise a redeploy forgets them. A coin is "pending" until its launch is confirmed on chain.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './lib.mjs';

export function createStore({ dir, now = Date.now }) {
  const file = path.join(dir, 'coins.json');
  const imgDir = path.join(dir, 'img');
  const all = () => readJson(file, { coins: [] }).coins || [];
  const save = coins => writeJson(file, { coins });
  return {
    list: () => all().filter(c => c.status === 'live').sort((a, b) => b.createdAt - a.createdAt),
    get: id => all().find(c => c.id === id) || null,
    bySymbol: symbol => all().filter(c => c.status === 'live' && c.symbol === symbol).length,
    addPending(coin, imageBuf, ext) {
      const coins = all().filter(c => !(c.status === 'pending' && now() - c.createdAt > 3600000)); // drop abandoned launches after an hour
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(imgDir, coin.id + '.' + ext), imageBuf);
      coins.push({ ...coin, status: 'pending', image: '/img/' + coin.id + '.' + ext, createdAt: now() });
      save(coins);
    },
    markLive(id) {
      const coins = all(); const c = coins.find(x => x.id === id);
      if (!c) return null;
      c.status = 'live'; c.liveAt = now(); save(coins); return c;
    },
    imageFile: name => path.join(imgDir, name),
  };
}

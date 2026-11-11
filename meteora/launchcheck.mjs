// Checks everything a visitor sends to launch or trade a coin. Pure functions, no network.
import { isAddress } from './lib.mjs';

const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

export function checkLaunch(body, { maxBuySol = 2, maxImageBytes = 400000 } = {}) {
  const b = body || {};
  const name = clean(b.name), symbol = String(b.symbol ?? '').trim().toUpperCase().replace(/^\$/, '');
  const description = clean(b.description);
  if (!isAddress(b.wallet)) return { error: 'bad_wallet' };
  if (name.length < 1 || name.length > 32) return { error: 'bad_name' };
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return { error: 'bad_symbol' };
  if (description.length > 200) return { error: 'bad_description' };
  const buySol = Number(b.buySol ?? 0);
  if (!Number.isFinite(buySol) || buySol < 0 || buySol > maxBuySol) return { error: 'bad_buy' };
  if (buySol > 0 && buySol < 0.01) return { error: 'bad_buy' };
  // The picture: base64 of a PNG or JPEG, checked by its first bytes, not by what the browser claims.
  let buf;
  try { buf = Buffer.from(String(b.image || ''), 'base64'); } catch { return { error: 'bad_image' }; }
  if (!buf.length || buf.length > maxImageBytes) return { error: 'bad_image' };
  let ext = '';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  if (!ext) return { error: 'bad_image' };
  return { ok: { name, symbol, description, wallet: b.wallet, buySol, image: buf, ext } };
}

export function checkTrade(body) {
  const b = body || {};
  if (!isAddress(b.wallet) || !isAddress(b.pool)) return { error: 'bad_request' };
  if (b.side === 'buy') {
    const sol = Number(b.amount);
    if (!Number.isFinite(sol) || sol < 0.001 || sol > 100) return { error: 'bad_amount' };
    return { ok: { wallet: b.wallet, pool: b.pool, side: 'buy', amount: sol } };
  }
  if (b.side === 'sell') {
    const pct = Number(b.amount);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: 'bad_amount' };
    return { ok: { wallet: b.wallet, pool: b.pool, side: 'sell', amount: pct } };
  }
  return { error: 'bad_request' };
}

// A small in-memory limit per caller so one visitor cannot hammer the endpoints that build transactions.
export function createLimiter({ now = Date.now } = {}) {
  const hits = new Map();
  return (key, max, windowMs) => {
    const t = now(); const list = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(t); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}

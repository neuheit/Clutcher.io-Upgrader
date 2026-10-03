// Builds prices.json (USD market prices per wear, incl. Doppler phases) from Skinport. Run by the GitHub Action.
import { writeFileSync } from 'node:fs';

const OK = /\| .* \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
const MIN = +(process.env.MIN_PRICES || 1000);
const get = async url => {
  const r = await fetch(url, { headers: { 'Accept-Encoding': 'br', Accept: 'application/json' } });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
};

const m = {};
function add(arr, fill) {            // fill = out-of-stock list: only fills gaps, uses the lower of its two prices
  for (const x of arr) {
    const n = x.market_hash_name;
    const p = fill ? Math.min(...[x.suggested_price, x.avg_sale_price].filter(Boolean)) : (x.suggested_price ?? x.min_price);
    if (!p || !isFinite(p) || !OK.test(n) || /StatTrak|Souvenir/.test(n)) continue;
    const vk = x.version ? n + '|' + x.version : null;
    if (fill) { if (vk && !(vk in m)) m[vk] = p; if (!(n in m)) m[n] = p; continue; }
    if (vk) { m[vk] = p; if (!(n in m) || p < m[n]) m[n] = p; } else m[n] = p;
  }
}

add(await get('https://api.skinport.com/v1/items?app_id=730&currency=USD'), false);
try { add(await get('https://api.skinport.com/v1/sales/out-of-stock?app_id=730&currency=USD'), true); }
catch (e) { console.warn('out-of-stock list failed:', e.message); }

const n = Object.keys(m).length;
if (n < MIN) { console.error('Only', n, 'prices, refusing to overwrite prices.json'); process.exit(1); }
writeFileSync('prices.json', JSON.stringify({ updated: new Date().toISOString(), prices: m }));
console.log('wrote', n, 'prices');

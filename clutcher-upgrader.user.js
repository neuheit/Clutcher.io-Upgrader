// ==UserScript==
// @name         Clutcher.io Upgrader
// @namespace    clutcher-upgrader
// @version      3.7.0
// @description  Upgrader (upgrader.pro style) for clutcher.io using your real skins and coins. Client-side only.
// @match        https://www.clutcher.io/*
// @match        https://clutcher.io/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/neuheit/Clutcher.io-Upgrader/main/clutcher-upgrader.user.js
// @downloadURL  https://raw.githubusercontent.com/neuheit/Clutcher.io-Upgrader/main/clutcher-upgrader.user.js
// ==/UserScript==

(async function () {
  'use strict';
  // Capture the game's own in-memory inventory object when it parses its save, so upgrades apply live.
  const origParse = JSON.parse;
  window.__gameInvs = window.__gameInvs || [];
  JSON.parse = function (t, r) {
    const o = origParse.call(this, t, r);
    try { if (o && typeof t === 'string' && Array.isArray(o.items) && 'coins' in o && 'equipped' in o) { window.__gameInvs.push(o); if (window.__gameInvs.length > 5) window.__gameInvs.shift(); } } catch (e) {}
    return o;
  };

  /* ---------- CONFIG ---------- */
  const EDGE = 0.05;        // house edge (0 = fair odds)
  const MAX_CHANCE = 95, MIN_CHANCE = 0;   // no minimum chance: any stake can go to any target
  const INV_KEY = 'clutcher_inv_v1';
  const PRICES_URL = 'https://raw.githubusercontent.com/neuheit/Clutcher.io-Upgrader/main/prices.json'; // refreshed daily by the GitHub Action
  const PRICE_TTL = 6 * 60 * 60 * 1000;  // re-download prices after 6 hours
  const TARGET_WEAR = 0.03; // wear given to a won skin
  const SHOW_LIMIT = 300;   // max cards drawn per list
  const COINS_PER_USD = 100; // how many game coins equal $1 (all prices are shown in coins = USD x this)
  const PRICE_MULT = 1;      // scale all market prices (e.g. 1.2 to mimic Steam wallet prices)

  /* ---------- INVENTORY IO ---------- */
  const origSet = Storage.prototype.setItem;
  const readInv = () => origParse.call(JSON, localStorage.getItem(INV_KEY));
  const getInv = () => (window.__gameInvs && window.__gameInvs.length ? window.__gameInvs[window.__gameInvs.length - 1] : readInv());
  const writeInv = o => origSet.call(localStorage, INV_KEY, JSON.stringify(o));
  const lockSaves = () => { Storage.prototype.setItem = function (k, v) { if (k === INV_KEY) return; return origSet.call(this, k, v); }; };

  /* ---------- NAMES + PRICING ---------- */
  const nice = id => {
    const t = id.split('_'), n = (x) => x.map(w => w.toUpperCase() === w ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
    const k = (t[0] === 'knife' || t[0] === 'glove') ? 2 : 1;
    let w = t.slice(0, k), rest = t.slice(k);
    if (rest[0] === w[w.length - 1]) rest = rest.slice(1);
    if (w.length === 1 && /\d/.test(w[0])) w = [w[0].toUpperCase()];
    return (n(w) + ' | ' + n(rest)).replace(/^(\S+) \| $/, '$1');
  };
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const baseFor = id => {
    const w = id.split('_')[0];
    if (/knife|bayonet|karambit|butterfly|talon|daggers/.test(w)) return 600;
    if (/glove/.test(w)) return 400;
    if (/^awp$/.test(w)) return 130;
    if (/^(ak|ak47|m4a1|m4a1s|m4a4|m4|deagle|sg553|aug|ssg08)/.test(w)) return 70;
    if (/^(usp|usps|p250|glock|fiveseven|tec9|cz75|p2000|dualies|revolver)/.test(w)) return 20;
    if (/^(mp9|mp7|mp5|mp5sd|ump|p90|bizon|mac10)/.test(w)) return 30;
    if (/^(nova|xm1014|mag7|sawedoff)/.test(w)) return 30;
    return 40;
  };
  const wearF = w => Math.max(0.5, 1.5 - (w || 0) * 1.6);
  const RAR = { consumer: 1, common: 1, industrial: 2, uncommon: 2, milspec: 4, 'mil-spec': 4, rare: 4, restricted: 8, epic: 8, classified: 16, legendary: 16, covert: 32, mythic: 32, contraband: 60, exceedingly: 60 };

  let catalog = new Map();   // skin id -> {rar?, price?}
  let source = 'estimated (weapon type x wear x per-skin factor)';

  const VALID = /^[a-z0-9_]+$/i;
  async function loadCatalog(samples) {
    try {
      const f = performance.getEntriesByType('resource').map(e => e.name).find(n => /\/src\/data-[^/]*\.js/.test(n));
      if (!f) return;
      const mod = await import(f);
      const seen = new Set();
      const find = (o, d) => {
        if (!o || typeof o !== 'object' || d > 4 || seen.has(o)) return null; seen.add(o);
        if (!Array.isArray(o) && samples.some(s => Object.prototype.hasOwnProperty.call(o, s))) return { map: o };
        if (Array.isArray(o) && o.some(e => e && typeof e === 'object' && samples.includes(e.id ?? e.skin ?? e.key))) return { arr: o };
        for (const v of Object.values(o)) { const r = find(v, d + 1); if (r) return r; }
        return null;
      };
      const hit = find(mod, 0);
      if (!hit) return;
      const entries = hit.map ? Object.entries(hit.map) : hit.arr.map(e => [e.id ?? e.skin ?? e.key, e]);
      let usedPrice = false, usedRar = false;
      entries.forEach(([id, e]) => {
        if (typeof id !== 'string' || !VALID.test(id) || !e || typeof e !== 'object') return;
        const rec = {};
        for (const [k, v] of Object.entries(e)) {
          if (k === 'name' && typeof v === 'string') rec.name = v;
          if (k === 'img' && typeof v === 'string') rec.img = v;
          if (k === 'kind' && typeof v === 'string') rec.kind = v;
          if (k === 'phase' && typeof v === 'string' && v) rec.phase = v;
          if (k === 'wmin' && typeof v === 'number') rec.wmin = v;
          if (k === 'wmax' && typeof v === 'number') rec.wmax = v;
          if (/^(price|value|cost|worth|coins?)$/i.test(k) && typeof v === 'number') { rec.price = v; usedPrice = true; }
          if (/rarity|tier|grade|quality|rank/i.test(k)) {
            const m = typeof v === 'number' ? Math.pow(1.8, v) : RAR[String(v).toLowerCase().replace(/[\s_]/g, '')];
            if (typeof v === 'string') { rec.rarName = v.toLowerCase().replace(/[\s_-]/g, ''); usedRar = true; }
            if (m) { rec.rar = m; usedRar = true; }
          }
        }
        catalog.set(id, rec);
      });
      source = usedPrice ? 'game data (price field)' : usedRar ? 'game data (rarity) x weapon type x wear' : source;
    } catch (e) { console.warn('[Upgrader] data module scan failed', e); }
  }

  const RB = { consumer: 0.1, common: 0.1, industrial: 0.3, uncommon: 0.3, milspec: 1, rare: 1, restricted: 5, epic: 5, classified: 20, legendary: 20, covert: 80, mythic: 80, contraband: 600, extraordinary: 600, gold: 600, ancient: 600 };
  const nm = id => (catalog.get(id) && catalog.get(id).name) || nice(id);
  const WEARS = [['Factory New', 0, 0.07], ['Minimal Wear', 0.07, 0.15], ['Field-Tested', 0.15, 0.38], ['Well-Worn', 0.38, 0.45], ['Battle-Scarred', 0.45, 1]];
  const SHORT = ['FN', 'MW', 'FT', 'WW', 'BS'];
  const wearIdx = w => { w = w || 0; return w < 0.07 ? 0 : w < 0.15 ? 1 : w < 0.38 ? 2 : w < 0.45 ? 3 : 4; };
  const isKG = id => /^(knife|glove)/.test(id) || /^(knife|glove|gloves)$/.test((catalog.get(id) || {}).kind || '');
  const hashName = (id, wi) => { const c = catalog.get(id) || {}; let n = nm(id).replace(/^\u2605\s*/, ''); if (c.phase) n = n.replace(/\s*\([^)]*\)\s*$/, ''); return (isKG(id) ? '\u2605 ' : '') + n + ' (' + WEARS[wi][0] + ')'; };
  const lookupKey = (id, wi) => { const c = catalog.get(id) || {}; return hashName(id, wi) + (c.phase ? '|' + c.phase : ''); };
  let med = {};
  const computeMed = () => { const g = {}; catalog.forEach((c, id) => { if (!c.rarName) return; for (let wi = 0; wi < 5; wi++) { const r = prices[lookupKey(id, wi)] ?? prices[hashName(id, wi)]; if (r) (g[c.rarName + '|' + wi + '|' + (isKG(id) ? 1 : 0)] ||= []).push(r); } }); med = {}; for (const k in g) { g[k].sort((a, b) => a - b); med[k] = g[k][g[k].length >> 1]; } };
  const PKEY = 'clutcher_upgrader_prices';
  let prices = {};
  const loadPrices = () => { try { const c = JSON.parse(localStorage.getItem(PKEY)); if (c && c.prices) { prices = c.prices; computeMed(); return c.t; } } catch (e) {} return 0; };
  const OKNAME = /\| .* \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
  const savePrices = arr => { const m = {}; arr.forEach(x => { const p = x.suggested_price ?? x.min_price, n = x.market_hash_name; if (!p || !OKNAME.test(n) || /StatTrak|Souvenir/.test(n)) return; if (x.version) { m[n + '|' + x.version] = p; if (!(n in m) || p < m[n]) m[n] = p; } else m[n] = p; }); origSet.call(localStorage, PKEY, JSON.stringify({ t: Date.now(), prices: m })); prices = m; };
  // ---- MANUAL PRICE OVERRIDES (USD). Key = market name without wear; value = price per wear (FN/MW/FT/WW/BS).
  // If you give only one wear, the other wears are scaled from the market data around that anchor.
  const OVERRIDES = {
    '★ Sport Gloves | Hedge Maze': { FN: 2000 },
    "★ Sport Gloves | Pandora's Box": { FN: 20000 },
    'AK-47 | Wild Lotus': { FN: 13000, MW: 8000 },
  };
  const nz = t => t.toLowerCase().replace(/[^a-z0-9|]/g, '');
  const OV = {}; Object.entries(OVERRIDES).forEach(([n, o]) => { const r = {}; Object.entries(o).forEach(([w, v]) => { r[SHORT.indexOf(w)] = v; }); OV[nz(n)] = r; });
  const priceInfo = (id, wear) => {
    const wi = wearIdx(wear), look = w => prices[lookupKey(id, w)] ?? prices[hashName(id, w)];
    const ov = OV[nz(hashName(id, wi).replace(/ \([^)]*\)$/, ''))];
    if (ov) {
      if (ov[wi] != null) return { p: ov[wi], real: true };
      const a = +Object.keys(ov)[0], sp = look(a), cur = look(wi), F = [1, 0.7, 0.45, 0.35, 0.3];
      return { p: Math.round((sp && cur ? cur * ov[a] / sp : ov[a] * F[wi] / F[a]) * 100) / 100, real: true };
    }
    let real = look(wi);
    // sanity: a wear can't be absurdly pricier than the next-worse wear (bad out-of-stock data)
    if (real && wi < 4) { const nb = look(wi + 1); if (nb && real > nb * 4) real = nb * (wi === 0 ? 2.5 : 2); }
    if (real) return { p: Math.round(real * PRICE_MULT * 100) / 100, real: true };
    const c = catalog.get(id) || {};
    const sib = c.phase && prices[hashName(id, wi)];
    if (sib && /Ruby|Sapphire|Emerald|Black Pearl/.test(c.phase)) return { p: Math.round(sib * 3 * PRICE_MULT * 100) / 100, real: false };
    const mm = med[c.rarName + '|' + wi + '|' + (isKG(id) ? 1 : 0)];
    if (mm) return { p: Math.round(mm * PRICE_MULT * (0.9 + (hash(id) % 1000) / 1000 * 0.2) * 100) / 100, real: false };
    const v = 0.9 + (hash(id) % 1000) / 1000 * 0.3;
    const wf = [1.4, 1, 0.8, 0.65, 0.55][wi];
    const base = RB[c.rarName] ? RB[c.rarName] * (isKG(id) ? 1 : Math.pow(baseFor(id) / 40, 0.3)) : baseFor(id) / 100;
    return { p: Math.max(0.03, Math.round(base * wf * v * 100) / 100), real: false };
  };
  const priceOf = (id, wear) => priceInfo(id, wear).p;
  const randWear = t => { const c = catalog.get(t.id) || {}, lo = Math.max(WEARS[t.wi][1], c.wmin ?? 0), hi = Math.min(WEARS[t.wi][2], c.wmax ?? 1); return Math.round((lo + Math.random() * Math.max(0, hi - lo - 0.0001)) * 10000) / 10000; };
  const colorFor = p => p >= 500 ? '#e4ae39' : p >= 100 ? '#eb4b4b' : p >= 25 ? '#d32ce6' : p >= 5 ? '#8847ff' : p >= 1 ? '#5b7bd5' : '#8aa0b8';
  const usd = n => Math.round(n * COINS_PER_USD).toLocaleString('en-US').replace(/,/g, '\u00a0'); // value in coins

  /* ---------- STATE ---------- */
  await new Promise(r => document.readyState === 'complete' ? r() : window.addEventListener('load', r, { once: true }));
  await new Promise(r => setTimeout(r, 800));
  let inv0 = readInv(); if (!inv0) return;
  console.log('[Upgrader] live inventory hooked:', window.__gameInvs.length ? window.__gameInvs.length + ' object(s), no reload needed' : 'NO (will reload after each upgrade)');
  const KNOWN = ['glove_handwraps_handwrap_camo_grey', 'xm1014_xm1014_mockingbird', 'glove_handwraps_handwrap_fabric_houndstooth_orange'];
  await loadCatalog([...new Set([...inv0.items.slice(0, 50).map(i => i.skin).filter(Boolean), ...KNOWN])]);
  loadPrices();
  const refreshPrices = async () => {
    try {
      const c = JSON.parse(localStorage.getItem(PKEY) || 'null');
      if (c && c.t && Date.now() - c.t < PRICE_TTL && Object.keys(c.prices || {}).length) return;
      const r = await fetch(PRICES_URL, { cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), m = j.prices || j;
      if (!m || Object.keys(m).length < 100) throw new Error('price file is empty (run the GitHub Action once)');
      origSet.call(localStorage, PKEY, JSON.stringify({ t: Date.now(), v: 4, prices: m }));
      loadPrices(); buildPool(getInv()); if (root.classList.contains('on')) render(true);
      console.log('[Upgrader] prices updated from GitHub:', Object.keys(m).length);
    } catch (e) { console.warn('[Upgrader] price download failed, using cached/estimated prices:', e.message || e); }
  };
  refreshPrices();
  console.log('[Upgrader] catalog entries:', catalog.size, '| market prices loaded:', Object.keys(prices).length, '(downloaded from GitHub, refreshed every 6h)');
  window.__upg = { priceInfo, lookupKey, hashName, get prices() { return prices; }, catalog };
  console.log('[Upgrader] build 3.7 (rig removed, no min chance)');

  const sel = new Set();
  let balUse = 0, target = null, busy = false, rot = 0, minP = '', maxP = '', sortDesc = true, q = '', tq = '', pool = [];
  const lockedUids = inv => { const s = JSON.stringify([inv.equipped, inv.loadout]); return u => s.includes(u); };

  function buildPool(inv) {
    let cached = []; try { cached = JSON.parse(localStorage.getItem('clutcher_upgrader_skins')) || []; } catch (e) {}
    const ids = [...new Set([...catalog.keys(), ...inv.items.map(i => i.skin), ...cached])].filter(id => typeof id === 'string' && VALID.test(id));
    try { origSet.call(localStorage, 'clutcher_upgrader_skins', JSON.stringify(ids)); } catch (e) {}
    pool = ids.flatMap(id => { const c = catalog.get(id) || {}, out = [];
      WEARS.forEach(([n, lo, hi], wi) => { const l2 = Math.max(lo, c.wmin ?? 0), h2 = Math.min(hi, c.wmax ?? 1); if (h2 <= l2) return;
        const pi = priceInfo(id, (l2 + h2) / 2); out.push({ key: id + '|' + wi, id, wi, name: nm(id) + ' (' + SHORT[wi] + ')', price: pi.p, real: pi.real, color: colorFor(pi.p) }); });
      return out; });
  }
  const mine = inv => inv.items.map(i => ({ uid: i.uid, id: i.skin, wear: i.wear, name: nm(i.skin) + ' (' + SHORT[wearIdx(i.wear)] + ')', price: priceOf(i.skin, i.wear), real: priceInfo(i.skin, i.wear).real }));
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 * 100;
  let M = new Map();
  const stake = () => balUse / COINS_PER_USD + [...sel].reduce((a, u) => a + (M.get(u)?.price || 0), 0);
  const tgt = () => target != null ? pool.find(s => s.key === target) : null;
  const chance = () => { const t = tgt(), s = stake(); return t && s > 0 ? Math.min(MAX_CHANCE, s / t.price * 100 * (1 - EDGE)) : 0; };

  /* ---------- ITEM IMAGES (auto-detects the game's own png path) ---------- */
  let imgBase = null, probing = false;
  const imgSrc = id => { const c = catalog.get(id); return c && c.img && imgBase ? imgBase.pre + c.img + '.' + imgBase.ext : ''; };
  const imgTag = id => { const u = imgSrc(id); return u ? `<img src="${u}" alt="" loading="lazy">` : `<span class="ph">${(nm(id).split('|')[1] || nm(id)).trim().slice(0, 2)}</span>`; };
  const detectImg = () => {
    if (imgBase) return;
    const set = new Set([...catalog.values()].map(c => c.img).filter(Boolean));
    for (const e of performance.getEntriesByType('resource')) {
      const m = e.name.match(/^(.*\/)([^\/?#]+)\.(png|webp|jpe?g|svg)(?:[?#].*)?$/i);
      if (m && set.has(decodeURIComponent(m[2]))) { imgBase = { pre: m[1], ext: m[3] }; console.log('[Upgrader] image path found:', imgBase); return render(); }
    }
    if (probing || !set.size) return; probing = true;
    const sample = [...set][0], dirs = ['', 'skins/', 'ui/skins/', 'ui/', 'img/', 'img/skins/', 'images/', 'images/skins/', 'assets/', 'assets/skins/', 'assets/img/', 'weapons/', 'ui/weapons/', 'icons/', 'ui/icons/', 'src/skins/', 'src/img/'];
    dirs.forEach(d => ['png', 'webp', 'jpg'].forEach(x => { const im = new Image(); im.onload = () => { if (!imgBase) { imgBase = { pre: location.origin + '/' + d, ext: x }; console.log('[Upgrader] image path found:', imgBase); render(); } }; im.src = location.origin + '/' + d + sample + '.' + x; }));
  };
  let coinUrl = '';
  const detectCoin = () => {
    if (!coinUrl) for (const e of performance.getEntriesByType('resource')) if (/coin/i.test(e.name) && /\.(png|webp|svg|jpe?g)(\?|$)/i.test(e.name)) { coinUrl = e.name; break; }
    if (!coinUrl) for (const im of document.querySelectorAll('img')) if (!im.closest('#upg') && /coin/i.test(im.src + im.alt + im.className)) { coinUrl = im.src; break; }
    if (!coinUrl) for (const el of document.querySelectorAll('[class*="coin" i],[id*="coin" i]')) {
      if (el.closest('#upg')) continue;
      const cs = getComputedStyle(el), m = ((cs.backgroundImage || '') + ' ' + (cs.getPropertyValue('--icon') || '') + ' ' + (cs.maskImage || '')).match(/url\(["']?([^"')]+)/);
      if (m) { coinUrl = m[1]; break; }
      const sv = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
      if (sv) { coinUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(new XMLSerializer().serializeToString(sv)); break; }
    }
    if (coinUrl) { root.style.setProperty('--coinbg', `url("${coinUrl}") center/contain no-repeat`); root.classList.add('coinimg'); console.log('[Upgrader] coin image:', coinUrl.slice(0, 100)); }
    else if (!detectCoin.warned) { detectCoin.warned = true; console.log('[Upgrader] game coin image not found, using default coin'); }
  };
  const RARC = { consumer: '#9fb0c4', common: '#9fb0c4', industrial: '#5e98d9', milspec: '#4b69ff', restricted: '#8847ff', classified: '#d32ce6', covert: '#eb4b4b', contraband: '#e4ae39', gold: '#e4ae39', extraordinary: '#e4ae39' };
  const rarCol = (id, p) => RARC[(catalog.get(id) || {}).rarName] || colorFor(p);
  const cn = n => Math.round(n).toLocaleString('en-US').replace(/,/g, '\u00a0');

  /* ---------- STYLE ---------- */
  const st = document.createElement('style'); st.textContent = `
  #upg{position:fixed;left:0;right:0;bottom:0;top:var(--upg-top,0px);z-index:99999;background:#0a0b0d;color:#e9e9ea;font-family:Bahnschrift,"Segoe UI",system-ui,sans-serif;overflow:auto;display:none}
  #upg.on{display:block}#upg *{box-sizing:border-box}
  #upg .wrap{max-width:1180px;margin:0 auto;padding:16px 20px 44px;position:relative}
  #upg .bar{position:absolute;right:20px;top:16px;display:flex;gap:10px;align-items:center}
  #upg .pill{background:#16171a;border:1px solid #25272b;border-radius:8px;padding:8px 14px;font-weight:700;display:flex;gap:7px;align-items:center}
  #upg h1{margin:6px 0 22px;font-size:26px;font-weight:800;text-align:center;display:flex;gap:8px;justify-content:center;align-items:center}
  #upg button{font:inherit;cursor:pointer;color:inherit}
  #upg .btn{background:#16171a;border:1px solid #25272b;border-radius:8px;padding:8px 14px}#upg .btn:hover{border-color:#ffd000}
  #upg .coin{display:inline-block;width:14px;height:14px;background:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23f3f6f9%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%239eaab5%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2246%22%20fill%3D%22url%28%23g%29%22%20stroke%3D%22%232f353c%22%20stroke-width%3D%226%22%2F%3E%3Cpath%20d%3D%22M68%2035%20A23%2023%200%201%200%2068%2065%22%20fill%3D%22none%22%20stroke%3D%22%23414d58%22%20stroke-width%3D%2211%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat;flex:none}
  #upg.coinimg .coin{box-shadow:none;border-radius:0}
  #upg .arena{display:grid;grid-template-columns:1fr 340px 1fr;gap:16px 22px;align-items:center}
  #upg .side{background:radial-gradient(circle at 50% 58%,rgba(255,208,0,.13),transparent 62%),#141518;border-radius:14px;height:360px;padding:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center}
  #upg .side .t1{font-weight:700;font-size:15px}#upg .sub{color:#80858c;font-size:12px}
  #upg .side .tot{display:flex;gap:7px;align-items:center;font-size:22px;font-weight:800;color:#ffd000}#upg .side .tot .coin{width:17px;height:17px}
  #upg .fan{display:flex;justify-content:center;height:150px;align-items:center}
  #upg .fi{width:130px;margin:0 -22px;transform:rotate(calc((var(--i) - (var(--n) - 1) / 2) * 9deg));filter:drop-shadow(0 8px 14px rgba(0,0,0,.6))}
  #upg .fi img,#upg .big img{width:100%;max-height:150px;object-fit:contain;display:block}
  #upg .big{width:230px;max-width:100%;height:150px;display:flex;align-items:center;justify-content:center}
  #upg .ph{display:flex;align-items:center;justify-content:center;width:70px;height:46px;border-radius:8px;background:#1d1f24;color:#6c717a;font-weight:800;font-size:16px}
  #upg .chev{width:90px;opacity:.9}
  #upg .gauge{position:relative;width:340px;height:340px}#upg .gauge svg{width:100%;height:100%}
  #upg .pointer{position:absolute;inset:0;transition:transform 4.6s cubic-bezier(.12,.6,.1,1)}
  #upg .pointer i{position:absolute;left:50%;bottom:0;margin-left:-9px;border:9px solid transparent;border-bottom:24px solid #ffd000;border-top:0;filter:drop-shadow(0 0 6px rgba(255,208,0,.7))}
  #upg .center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
  #upg .pct{font-size:46px;font-weight:800;line-height:1}#upg .lbl{font-size:14px;margin-top:6px}
  #upg .go{background:#ffd000;color:#171200;font-weight:800;font-size:19px;border:0;border-radius:10px;padding:15px;width:100%;display:flex;gap:8px;justify-content:center;align-items:center}
  #upg .go:disabled{background:#6f5d00;color:#2c2500;cursor:not-allowed}
  #upg .balbox{background:#141518;border-radius:10px;padding:10px 14px}#upg .balbox .sub{display:flex;justify-content:space-between;margin-bottom:6px}#upg .balbox b{color:#ffd000}
  #upg input[type=range]{width:100%;accent-color:#ffd000}
  #upg .quick{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
  #upg .quick .btn{min-width:48px;padding:10px 12px}#upg .quick .r{border-color:#7a2b2b}#upg .quick .g{border-color:#4d6b22}
  #upg .lists{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px}
  #upg .panel{background:#141518;border-radius:14px;padding:14px}#upg .panel h3{margin:0 0 10px;font-size:16px}
  #upg .filters{display:flex;gap:8px;margin-bottom:10px}
  #upg .filters input{background:#0d0e10;border:1px solid #25272b;border-radius:8px;padding:8px 10px;color:#e9e9ea;width:100%;min-width:0}
  #upg .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;max-height:400px;overflow:auto;padding:2px}
  #upg .card{position:relative;background:linear-gradient(#17181c,#101114);border:1px solid var(--c);box-shadow:inset 0 -26px 34px -26px var(--c);border-radius:10px;padding:8px;min-height:150px;display:flex;flex-direction:column;align-items:center;gap:1px;text-align:center}
  #upg .card:hover{transform:translateY(-1px)}#upg .card.sel{outline:2px solid #ffd000;background:#1d1a08}#upg .card.dis{opacity:.35;cursor:not-allowed}
  #upg .card .p{align-self:flex-start;display:flex;gap:5px;align-items:center;color:#ffd000;font-weight:800;font-size:12px}#upg .card .p .coin{width:10px;height:10px}
  #upg .card .w{position:absolute;right:8px;top:8px;font-size:10px;color:#9aa0a8;font-weight:700}
  #upg .card .im{width:100%;height:78px;display:flex;align-items:center;justify-content:center}#upg .card .im img{max-width:100%;max-height:78px;object-fit:contain}
  #upg .card .n1{font-size:10px;color:#80858c;line-height:1.2}#upg .card .n2{font-size:12px;font-weight:700;line-height:1.2}
  #upg .empty{color:#80858c;padding:20px;text-align:center;grid-column:1/-1}
  #upg .toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);padding:14px 22px;border-radius:10px;font-weight:800;background:#17191d;border:1px solid #262a30;opacity:0;transition:opacity .25s;pointer-events:none}
  #upg .toast.show{opacity:1}#upg .toast.win{border-color:#6ad34a;color:#8cf06b}#upg .toast.lose{border-color:#d34a4a;color:#f06b6b}
 #upg .sidew{position:relative}
  #upg .fxl{position:absolute;inset:0;pointer-events:none;border-radius:14px;overflow:hidden}
  #upg .go.loading .gl::before{content:'';display:inline-block;width:14px;height:14px;margin-right:8px;border:2px solid #2c2500;border-top-color:transparent;border-radius:50%;animation:upgSpin .8s linear infinite;vertical-align:-2px}
  @keyframes upgSpin{to{transform:rotate(360deg)}}
  #upg .sidew.hit .side{animation:upgPulse 1.2s ease-out}
  @keyframes upgPulse{0%{box-shadow:0 0 0 0 var(--rc)}30%{box-shadow:0 0 50px 4px var(--rc),inset 0 0 70px -10px var(--rc)}100%{box-shadow:0 0 0 0 transparent}}
  #upg .sidew.hit .big{animation:upgPop .6s cubic-bezier(.2,1.6,.4,1)}
  @keyframes upgPop{0%{transform:scale(.7)}100%{transform:scale(1)}}
  #upg .burst{position:absolute;left:50%;top:46%;width:20px;height:20px;margin:-10px;border-radius:50%;background:radial-gradient(circle,var(--rc),transparent 70%);animation:upgBurst 1.3s ease-out forwards}
  @keyframes upgBurst{0%{transform:scale(.2);opacity:.95}100%{transform:scale(24);opacity:0}}
  #upg .sp{position:absolute;left:50%;top:46%;width:6px;height:6px;border-radius:50%;background:var(--rc);box-shadow:0 0 9px var(--rc);animation:upgSp 1.2s ease-out forwards}
  @keyframes upgSp{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(.2);opacity:0}}
  #upg .badge{position:absolute;left:50%;top:46%;width:100px;height:100px;margin:-50px;animation:upgBadge .8s ease-out forwards}
  @keyframes upgBadge{0%{transform:scale(.3);opacity:0}35%{transform:scale(1.1);opacity:1}100%{transform:scale(1.7);opacity:0}}
  #upg .sidew.miss .side{animation:upgShake .5s;filter:saturate(.3)}
  @keyframes upgShake{20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
  @media(max-width:960px){#upg .arena,#upg .lists{grid-template-columns:1fr}#upg .gauge{margin:auto}#upg .quick{justify-content:center}#upg .bar{position:static;justify-content:center;margin-bottom:8px}}
  @media(prefers-reduced-motion:reduce){#upg .pointer{transition-duration:.01s}}`;
  document.head.appendChild(st);

  /* ---------- UI ---------- */
  const CHEV = d => `<svg class="chev" viewBox="0 0 90 90" fill="none" stroke="#ffd000" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"><path opacity=".35" d="M18 ${d ? 14 : 76} l27 ${d ? 14 : -14} l27 ${d ? -14 : 14}"/><path opacity=".6" d="M18 ${d ? 34 : 56} l27 ${d ? 14 : -14} l27 ${d ? -14 : 14}"/><path d="M18 ${d ? 54 : 36} l27 ${d ? 14 : -14} l27 ${d ? -14 : 14}"/></svg>`;
  const root = document.createElement('div'); root.id = 'upg';
  root.innerHTML = `<div class="wrap">
    <div class="bar"><span class="pill"><i class="coin"></i><span id="u-bal"></span></span></div>
    <h1><svg width="26" height="26" viewBox="0 0 90 90" fill="none" stroke="#ffd000" stroke-width="12" stroke-linejoin="round"><path d="M12 44 l33 -26 l33 26"/><path d="M12 72 l33 -26 l33 26"/></svg>UPGRADER</h1>
    <div class="arena">
      <div class="side" id="u-left"></div>
      <div class="gauge"><svg viewBox="0 0 200 200"><defs><linearGradient id="u-g" gradientUnits="userSpaceOnUse" x1="100" y1="14" x2="100" y2="186" gradientTransform="rotate(-90 100 100)"><stop offset="0" stop-color="#ffd000"/><stop offset=".55" stop-color="#ffb000"/><stop offset="1" stop-color="#ff4d1a"/></linearGradient></defs>
        <circle cx="100" cy="100" r="97" fill="none" stroke="#2c2f34" stroke-width="3" stroke-dasharray="1 5.1"/>
        <circle cx="100" cy="100" r="86" fill="none" stroke="#1b1d21" stroke-width="14"/>
        <circle id="u-arc" cx="100" cy="100" r="86" fill="none" stroke="url(#u-g)" stroke-width="14" transform="rotate(90 100 100)" stroke-dasharray="0 541"/>
        <circle cx="100" cy="100" r="70" fill="#101114"/></svg>
        <div class="pointer" id="u-ptr"><i></i></div>
        <div class="center"><div class="pct" id="u-pct">0%</div><div class="lbl" id="u-lbl"></div></div></div>
      <div class="sidew" id="u-rw"><div class="side" id="u-right"></div><div class="fxl" id="u-fx"></div></div>
      <div class="balbox"><div class="sub"><span>Balance amount: <b id="u-bu">0</b></span><span>(max <span id="u-mx">0</span>)</span></div><input type="range" id="u-slide" min="0" max="0" value="0"></div>
      <button class="go" id="u-go" disabled><svg width="18" height="18" viewBox="0 0 90 90" fill="none" stroke="currentColor" stroke-width="13" stroke-linejoin="round"><path d="M12 44 l33 -26 l33 26"/><path d="M12 76 l33 -26 l33 26"/></svg><span class="gl">Upgrade</span></button>
      <div class="quick"><button class="btn" data-x="2">x2</button><button class="btn" data-x="4">x4</button><button class="btn" data-x="8">x8</button>
        <button class="btn r" data-p="35">35%</button><button class="btn g" data-p="55">55%</button><button class="btn g" data-p="75">75%</button></div>
    </div>
    <div class="lists">
      <div class="panel"><h3>My skins</h3><div class="filters"><input id="u-q" placeholder="Search your skins"></div><div class="grid" id="u-inv"></div></div>
      <div class="panel"><h3>Select skin</h3><div class="filters"><button class="btn" id="u-sort">Price ↓</button><input id="u-tq" placeholder="Search skins"><input id="u-min" type="number" placeholder="from"><input id="u-max" type="number" placeholder="to"></div><div class="grid" id="u-shop"></div></div>
    </div><div class="toast" id="u-toast"></div></div>`;
  document.body.appendChild(root);
  root.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
  const $ = id => root.querySelector('#' + id);
  const card = (s, cls, attrs, extra = '') => {
    const wi = s.wi ?? wearIdx(s.wear), full = s.name.replace(/\s\((FN|MW|FT|WW|BS)\)$/, ''), [a, ...b] = full.split(' | ');
    return `<button class="card ${cls}" style="--c:${rarCol(s.id, s.price)}" ${attrs}><span class="p"><i class="coin"></i>${usd(s.price)}${s.real === false ? '~' : ''}</span><span class="w">${SHORT[wi]}</span><span class="im">${imgTag(s.id)}</span><span class="n1">${b.length ? a : ''}${extra}</span><span class="n2">${b.length ? b.join(' | ') : a}</span></button>`;
  };

  function render(fresh) {
    if (fresh || !M.size) { const inv = getInv(); inv0 = inv; M = new Map(mine(inv).map(m => [m.uid, m])); if (!pool.length) buildPool(inv); }
    const inv = inv0, isLocked = lockedUids(inv);
    [...sel].forEach(u => { if (!M.has(u)) sel.delete(u); });
    balUse = Math.min(balUse, inv.coins);
    $('u-bal').textContent = cn(inv.coins); $('u-mx').textContent = cn(inv.coins);
    const sl = $('u-slide'); sl.max = inv.coins; sl.value = balUse; $('u-bu').textContent = cn(balUse);
    const sv = stake(), t = tgt(), ch = chance(), tooHigh = false;   // any skin to any skin is allowed
    const chosen = [...sel].map(u => M.get(u)).filter(Boolean).sort((a, b) => b.price - a.price).slice(0, 4);
    $('u-left').innerHTML = sv > 0
      ? (chosen.length ? `<div class="fan">${chosen.map((m, i) => `<div class="fi" style="--i:${i};--n:${chosen.length}">${imgTag(m.id)}</div>`).join('')}</div>` : `<div class="big"><i class="coin" style="width:70px;height:70px"></i></div>`) +
        `<div class="tot"><i class="coin"></i>${usd(sv)}</div><div class="sub">${sel.size} skin${sel.size === 1 ? '' : 's'}${balUse ? ' + ' + cn(balUse) + ' coins' : ''}</div>`
      : `${CHEV(true)}<div class="t1">Select skins or balance to use</div><div class="sub">You can select multiple skins</div>`;
    $('u-right').innerHTML = t
      ? `<div class="big">${imgTag(t.id)}</div><div class="t1" style="color:${rarCol(t.id, t.price)}">${t.name}</div><div class="tot"><i class="coin"></i>${usd(t.price)}${t.real === false ? ' ~' : ''}</div>`
      : `${CHEV(false)}<div class="t1">Select skin for upgrade</div>`;
    const circ = 2 * Math.PI * 86;
    $('u-arc').setAttribute('stroke-dasharray', `${circ * ch / 100} ${circ}`);
    $('u-pct').textContent = ch ? (ch < 0.01 ? '<0.01%' : ch.toFixed(2) + '%') : '0%';
    $('u-lbl').textContent = !t || !sv ? 'Pick skins and a target' : tooHigh ? 'Target must cost more' : ch >= 60 ? 'high chance' : ch >= 25 ? 'medium chance' : 'low chance';
    $('u-lbl').style.color = ch >= 60 ? '#8cf06b' : ch >= 25 ? '#a6d52b' : '#f06b6b';
    $('u-go').disabled = busy || !t || !sv || tooHigh || ch < MIN_CHANCE;
    $('u-go').classList.toggle('loading', busy); $('u-go').querySelector('.gl').textContent = busy ? 'Loading…' : 'Upgrade';

    const ql = q.toLowerCase();
    const mineL = [...M.values()].filter(m => !ql || m.name.toLowerCase().includes(ql)).sort((a, b) => b.price - a.price);
    $('u-inv').innerHTML = mineL.length ? mineL.slice(0, SHOW_LIMIT).map(m => card(m, sel.has(m.uid) ? 'sel' : isLocked(m.uid) ? 'dis' : '', `data-u="${m.uid}"`, isLocked(m.uid) ? ' (equipped)' : '')).join('') + (mineL.length > SHOW_LIMIT ? `<div class="empty">Showing ${SHOW_LIMIT} of ${mineL.length}. Use search.</div>` : '') : '<div class="empty">No skins found.</div>';
    const lo = parseFloat(minP) || 0, hi = parseFloat(maxP) || Infinity;
    const tl = tq.toLowerCase(); const list = pool.filter(s => s.price * COINS_PER_USD >= lo && s.price * COINS_PER_USD <= hi && (!tl || s.name.toLowerCase().includes(tl))).sort((a, b) => sortDesc ? b.price - a.price : a.price - b.price);
    $('u-shop').innerHTML = list.length ? list.slice(0, SHOW_LIMIT).map(s => card(s, target === s.key ? 'sel' : '', `data-s="${s.key}"`)).join('') : '<div class="empty">No skins in this price range.</div>';
    $('u-sort').textContent = sortDesc ? 'Price ↓' : 'Price ↑';
  }

  const toast = (m, k) => { const t = $('u-toast'); t.textContent = m; t.className = 'toast show ' + k; setTimeout(() => t.classList.remove('show'), 2400); };
  const resultFx = (win, t) => {
    const w = $('u-rw'), fx = $('u-fx'); w.style.setProperty('--rc', win ? rarCol(t.id, t.price) : '#d34a4a'); fx.innerHTML = '';
    if (win) {
      fx.insertAdjacentHTML('beforeend', '<svg class="badge" viewBox="0 0 90 90" fill="none" stroke="var(--rc)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M18 52 l27 -22 l27 22"/><path d="M18 74 l27 -22 l27 22"/></svg><i class="burst"></i>');
      for (let i = 0; i < 28; i++) { const a = Math.random() * 6.283, d = 80 + Math.random() * 170, e = document.createElement('i'); e.className = 'sp'; e.style.cssText = `--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px;animation-delay:${(Math.random() * 0.15).toFixed(2)}s`; fx.appendChild(e); }
    }
    w.classList.remove('hit', 'miss'); void w.offsetWidth; w.classList.add(win ? 'hit' : 'miss');
    setTimeout(() => { w.classList.remove('hit', 'miss'); fx.innerHTML = ''; }, 1500);
  };
  function pickTarget(price) {
    let best = null; pool.forEach(s => { if (s.price > stake() && (!best || Math.abs(s.price - price) < Math.abs(best.price - price))) best = s; });
    target = best ? best.key : null; render();
  }

  function upgrade() {
    if (busy || $('u-go').disabled) return;
    const live = !!(window.__gameInvs && window.__gameInvs.length), inv = getInv(), t = tgt(), isLocked = lockedUids(inv);
    const uids = [...sel];
    if (inv.coins < balUse || uids.some(u => !inv.items.find(i => i.uid === u) || isLocked(u))) { toast('Inventory changed, refreshed', 'lose'); sel.clear(); render(true); return; }
    busy = true; $('u-go').disabled = true; $('u-go').classList.add('loading'); $('u-go').querySelector('.gl').textContent = 'Loading…';
    const ch = chance(), r = rnd(), win = r < ch;
    inv.coins -= balUse;
    for (let n = inv.items.length - 1; n >= 0; n--) if (uids.includes(inv.items[n].uid)) inv.items.splice(n, 1);
    if (win) {
      const wears = [...new Set(inv.items.map(i => i.wear))];
      inv.items.push({ uid: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), skin: t.id, wear: randWear(t), seed: Math.floor(Math.random() * 1000), st: false, kills: 0, t: Date.now() });
    }
    if (live) { window.__gameInvs.forEach(c => { if (c !== inv) { c.coins = inv.coins; c.items.splice(0, c.items.length, ...inv.items); } }); writeInv(inv); }
    else { lockSaves(); writeInv(inv); }   // fallback: block the game's save, then reload
    rot += 360 * 5 + (((r * 3.6 - (rot % 360)) + 360) % 360);
    $('u-ptr').style.transform = `rotate(${rot}deg)`;
    setTimeout(() => {
      toast(win ? `Success! You won ${t.name}` : 'Upgrade failed', win ? 'win' : 'lose');
      sel.clear(); balUse = 0; M = new Map(); if (live) busy = false; render(true);
      resultFx(win, t);
      if (!live) { try { sessionStorage.setItem('upg_reopen', '1'); } catch (e) {} setTimeout(() => location.reload(), 2300); }
    }, 4800);
  }

  /* ---------- EVENTS ---------- */
  root.addEventListener('click', e => {
    const c = e.target.closest('[data-u],[data-s],[data-x],[data-p]'); if (!c || busy) return;
    if (c.dataset.u) { if (c.classList.contains('dis')) return; sel.has(c.dataset.u) ? sel.delete(c.dataset.u) : sel.add(c.dataset.u); render(); }
    else if (c.dataset.s) { target = target === c.dataset.s ? null : c.dataset.s; render(); }
    else if (c.dataset.x && stake() > 0) pickTarget(stake() * +c.dataset.x);
    else if (c.dataset.p && stake() > 0) pickTarget(stake() * (1 - EDGE) * 100 / +c.dataset.p);
  });
  $('u-slide').addEventListener('input', e => { if (!busy) { balUse = +e.target.value; render(); } });
  $('u-go').addEventListener('click', upgrade);
  $('u-sort').addEventListener('click', () => { sortDesc = !sortDesc; render(); });
  $('u-min').addEventListener('change', e => { minP = e.target.value; render(); });
  $('u-max').addEventListener('change', e => { maxP = e.target.value; render(); });
  $('u-q').addEventListener('input', e => { q = e.target.value; render(); });
  $('u-tq').addEventListener('input', e => { tq = e.target.value; render(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('on') && !busy) close(); });
  let navRow = null, navTab = null;
  const setTop = () => {
    let t = 0;
    if (navRow) { const r = navRow.getBoundingClientRect(); t = r.height < 140 && r.bottom > 0 ? r.bottom : (navTab ? navTab.getBoundingClientRect().bottom : 0); }
    root.style.setProperty('--upg-top', (t ? Math.ceil(t) + 6 : 0) + 'px');
  };
  const ACT = /(^|[-_])(active|selected|current|on|sel)($|[-_])/i;
  let saved = [], markCls = [];
  const dim = () => {      // remove the game's "active" marker from the other tabs while we are open
    saved = []; if (!navRow) return;
    [...navRow.children].forEach(el => {
      if (el === navTab) return;
      const extra = [...el.classList].filter(c => ACT.test(c)), aria = ['aria-selected', 'aria-current'].filter(a => el.getAttribute(a) === 'true');
      if (extra.length || aria.length) { saved.push({ el, extra, aria }); el.classList.remove(...extra); aria.forEach(a => el.setAttribute(a, 'false')); }
    });
  };
  const undim = () => { saved.forEach(({ el, extra, aria }) => { el.classList.add(...extra); aria.forEach(a => el.setAttribute(a, 'true')); }); saved = []; };
  const markOpen = () => {
    if (!navTab || root.classList.contains('on')) return;
    dim(); markCls = [...new Set(saved.flatMap(x => x.extra))];
    if (markCls.length) navTab.classList.add(...markCls); else navTab.style.boxShadow = 'inset 0 -3px 0 #fff';
  };
  const close = fromNav => {
    root.classList.remove('on');
    if (navTab) { navTab.style.boxShadow = ''; markCls.forEach(c => navTab.classList.remove(c)); }
    if (!fromNav) return undim();
    setTimeout(() => {     // the game has handled the click by now: restore the old tab only if it did not mark a new one
      const anyActive = navRow && [...navRow.children].some(el => el !== navTab && [...el.classList].some(c => ACT.test(c)));
      anyActive ? (saved = []) : undim();
    }, 150);
  };
  // clicking any other top-bar tab (Play Game, Loadout, Inventory...) leaves the Upgrader
  document.addEventListener('click', e => { if (root.classList.contains('on') && navRow && navRow.contains(e.target) && !e.target.closest('#upg-nav')) close(true); }, true);
  window.addEventListener('resize', () => { if (root.classList.contains('on')) setTop(); });
  const open = () => { markOpen(); root.classList.add('on'); setTop(); loadPrices(); buildPool(getInv()); render(true); detectImg(); };

  /* ---------- NAV BUTTON ---------- */
  function addNav() {
    if (document.getElementById('upg-nav') || document.getElementById('upg-fab')) return;
    const els = [...document.querySelectorAll('a,button,div,span,li')].filter(el => el.children.length === 0);
    const ref = ['MARKETPLACE', 'CASES', 'INVENTORY'].map(n => els.find(el => el.textContent.trim().toUpperCase() === n)).find(Boolean);
    if (ref) {
      const tab = ref.cloneNode(true); tab.id = 'upg-nav'; tab.textContent = 'UPGRADER'; tab.removeAttribute('href'); tab.style.cursor = 'pointer';
      [...tab.classList].filter(c => ACT.test(c)).forEach(c => tab.classList.remove(c)); tab.removeAttribute('aria-selected'); tab.removeAttribute('aria-current');
      tab.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); open(); });
      ref.parentNode.insertBefore(tab, ref.nextSibling); navRow = ref.parentElement; navTab = tab;
    } else {
      const b = document.createElement('button'); b.id = 'upg-fab'; b.textContent = 'UPGRADER';
      b.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:99998;background:#ffd000;color:#141000;font:800 14px Bahnschrift,sans-serif;border:0;border-radius:8px;padding:10px 16px;cursor:pointer';
      b.addEventListener('click', () => root.classList.contains('on') ? close() : open()); document.body.appendChild(b);
    }
  }
  addNav();
  try { if (sessionStorage.getItem('upg_reopen')) { sessionStorage.removeItem('upg_reopen'); open(); } } catch (e) {}
  new MutationObserver(addNav).observe(document.body, { childList: true, subtree: true });
})();

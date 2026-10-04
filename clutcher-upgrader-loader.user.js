// ==UserScript==
// @name         Clutcher.io Upgrader (Loader)
// @namespace    clutcher-upgrader
// @version      1.0.0
// @description  Kleiner Loader: startet immer die neueste Upgrader-Version von GitHub
// @match        https://www.clutcher.io/*
// @match        https://clutcher.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const URL_MAIN = 'https://raw.githubusercontent.com/neuheit/Clutcher.io-Upgrader/main/clutcher-upgrader.user.js';
  const KEY = 'upg_loader_code';

  // 1) Sofort das Spielinventar abgreifen, auch wenn der Upgrader-Code noch nicht da ist
  if (!window.__upgParseHook) {
    window.__upgParseHook = true;
    const real = JSON.parse;
    window.__origJSONParse = real;
    window.__gameInvs = window.__gameInvs || [];
    JSON.parse = function (t, r) {
      const o = real.call(this, t, r);
      try { if (o && typeof t === 'string' && Array.isArray(o.items) && 'coins' in o && 'equipped' in o && !window.__gameInvs.includes(o)) { window.__gameInvs.push(o); if (window.__gameInvs.length > 5) window.__gameInvs.shift(); } } catch (e) {}
      return o;
    };
  }

  // 2) Code ausfuehren: erst eval, bei gesperrtem eval als Inline-Script
  const run = code => {
    try { (0, eval)(code); return true; }
    catch (e) {
      if (!(e instanceof EvalError)) { console.error('[Upgrader loader]', e); return true; }   // Laufzeitfehler: nicht doppelt starten
    }
    try { const s = document.createElement('script'); s.textContent = code; document.documentElement.appendChild(s); s.remove(); return true; }
    catch (e) { console.warn('[Upgrader loader] Ausfuehren blockiert (CSP). Installiere stattdessen das volle Skript.', e); return false; }
  };

  // 3) Gespeicherte Version sofort starten (kein Warten aufs Netz), neueste im Hintergrund holen
  let cached = ''; try { cached = localStorage.getItem(KEY) || ''; } catch (e) {}
  let started = cached ? run(cached) : false;

  fetch(URL_MAIN, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(t => {
    if (!t || t.length < 1000 || !t.includes('==UserScript==')) return;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    if (!started) run(t);   // erster Start ohne Cache
  }).catch(e => console.warn('[Upgrader loader] Download fehlgeschlagen:', e.message || e));
})();

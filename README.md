# Clutcher.io Upgrader

An upgrader (upgrader.pro style) for clutcher.io using your real skins and coins. Client-side only.

## How to install:
1. Download the Tampermonkey extension.
2. Click on the Extension and Click "Create New Script".
3. Delete all existing code and paste this:
// ==UserScript==
// @name         Clutcher.io Upgrader (Loader)
// @namespace    clutcher-upgrader
// @version      1.0.2
// @description  upgrader.io built by .gg/neuheit <3
// @match        https://www.clutcher.io/*
// @match        https://clutcher.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_URL = 'https://raw.githubusercontent.com/neuheit/Clutcher.io-Upgrader/main/clutcher-upgrader.user.js';
  const CACHE_KEY = 'upg_loader_code';

  if (!window.__upgParseHook) {
    window.__upgParseHook = true;
    const originalParse = JSON.parse;
    window.__origJSONParse = originalParse;
    window.__gameInvs = window.__gameInvs || [];

    JSON.parse = function (text, reviver) {
      const result = originalParse.call(this, text, reviver);
      try {
        const looksLikeInventory = result && typeof text === 'string' &&
          Array.isArray(result.items) && 'coins' in result && 'equipped' in result;
        if (looksLikeInventory && !window.__gameInvs.includes(result)) {
          window.__gameInvs.push(result);
          if (window.__gameInvs.length > 5) window.__gameInvs.shift();
        }
      } catch (err) {}
      return result;
    };
  }

  function runCode(code) {
    try {
      (0, eval)(code);
      return true;
    } catch (err) {
      if (!(err instanceof EvalError)) {
        console.error('[Upgrader loader]', err);
        return true;
      }
    }
    try {
      const tag = document.createElement('script');
      tag.textContent = code;
      document.documentElement.appendChild(tag);
      tag.remove();
      return true;
    } catch (err) {
      console.warn('[Upgrader loader] Konnte nicht ausgeführt werden.', err);
      return false;
    }
  }

  let savedCode = '';
  try { savedCode = localStorage.getItem(CACHE_KEY) || ''; } catch (err) {}
  const alreadyStarted = savedCode ? runCode(savedCode) : false;

  fetch(SCRIPT_URL, { cache: 'no-cache' })
    .then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then(latestCode => {
      const looksValid = latestCode && latestCode.length > 1000 && latestCode.includes('==UserScript==');
      if (!looksValid) return;
      try { localStorage.setItem(CACHE_KEY, latestCode); } catch (err) {}
      if (!alreadyStarted) runCode(latestCode);
    })
    .catch(err => console.warn('[Upgrader loader] Download hat nicht geklappt:', err.message || err));
})();
4. Youre Done!
Have fun with the script.



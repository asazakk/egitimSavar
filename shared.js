/**
 * Katalog bağlantısı ayrıştırma — content script ve popup paylaşır.
 * Platform kuralları platforms.js (EgitimPlatforms) üzerinden yürütülür;
 * mevcut UEKLinks API'si geriye dönük uyumluluk için korunur.
 */
(function (root) {
  'use strict';

  const P = root.EgitimPlatforms;

  function parseUrl(href, base) {
    if (P) return P.parseUrl(href, base);
    try {
      return new URL(href, base || undefined);
    } catch (_) {
      return null;
    }
  }

  function cleanTitle(text) {
    if (P) return P.cleanTitle(text);
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return t || 'Eğitim';
  }

  function isDirectPlayerUrl(href, base) {
    return !!(P && P.isDirectPlayerUrl(href, base));
  }

  function isTrainingUrl(href, base) {
    return !!(P && P.isTrainingUrl(href, base));
  }

  function addLink(map, href, title, base, done) {
    if (!P || !P.isTrainingUrl(href, base)) return;
    const u = parseUrl(href, base);
    if (!u) return;
    u.hash = '';
    const url = u.href;
    const plat = P.detectByHost(u.hostname);
    const key = P.courseKey(url);
    const item = {
      url,
      title: cleanTitle(title),
      done: !!done,
      platform: plat ? plat.id : '',
    };
    const prev = map.get(key);
    if (!prev || P.rankUrl(url) > P.rankUrl(prev.url)) {
      map.set(key, {
        url,
        title: item.title !== 'Eğitim' ? item.title : (prev && prev.title) || item.title,
        done: item.done || !!(prev && prev.done),
        platform: item.platform || (prev && prev.platform) || '',
      });
      return;
    }
    if (item.done) prev.done = true;
    if (prev.title === 'Eğitim' && item.title !== 'Eğitim') prev.title = item.title;
    if (!prev.platform && item.platform) prev.platform = item.platform;
  }

  function titleFrom(el, plat) {
    if (plat && typeof plat.titleFrom === 'function') return plat.titleFrom(el);
    return cleanTitle(el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '');
  }

  function looksDone(el, plat) {
    if (plat && typeof plat.looksDone === 'function') return !!plat.looksDone(el);
    return false;
  }

  function collectFromDocument(doc) {
    const map = new Map();
    const base = doc.location ? doc.location.href : undefined;
    doc.querySelectorAll('a[href], [data-href], [data-url]').forEach((el) => {
      const raw = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url');
      if (!raw || /^\s*javascript:/i.test(raw)) return;
      const u = parseUrl(raw, base);
      const plat = u && P ? P.detectByHost(u.hostname) : null;
      if (!plat) return;
      addLink(map, raw, titleFrom(el, plat), base, looksDone(el, plat));
    });
    return [...map.values()];
  }

  function parseText(text) {
    const map = new Map();
    const matches = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
    matches.forEach((raw) => {
      addLink(map, raw.replace(/[),.;]+$/, ''), '', undefined);
    });
    return [...map.values()];
  }

  function mergeItems(list) {
    const map = new Map();
    (list || []).forEach((item) => addLink(map, item && item.url, item && item.title, undefined, item && item.done));
    return [...map.values()];
  }

  root.UEKLinks = {
    collectFromDocument,
    parseText,
    mergeItems,
    isDirectPlayerUrl,
    isTrainingUrl,
  };
})(globalThis);

/**
 * Katalog bağlantısı ayrıştırma — content script ve popup paylaşır.
 */
(function (root) {
  'use strict';

  function parseUrl(href, base) {
    try {
      return new URL(href, base || undefined);
    } catch (_) {
      return null;
    }
  }

  function isUekHost(hostname) {
    return /(?:^|\.)uzaktanegitimkapisi\.gov\.tr$/i.test(hostname)
      || /(?:^|\.)cbiko\.gov\.tr$/i.test(hostname);
  }

  function isDirectPlayerUrl(href) {
    const u = parseUrl(href);
    if (!u || !isUekHost(u.hostname)) return false;
    return /\/Egitimler\/(ScormV2|Video)(\/|$)/i.test(u.pathname);
  }

  function isTrainingUrl(href, base) {
    const u = parseUrl(href, base);
    if (!u || !isUekHost(u.hostname)) return false;
    if (!/\/Egitimler\//i.test(u.pathname)) return false;
    if (isDirectPlayerUrl(u.href)) return true;
    return u.searchParams.has('Uniq') || u.searchParams.has('uniq');
  }

  function rank(href) {
    if (/\/ScormV2/i.test(href)) return 3;
    if (/\/Video/i.test(href)) return 2;
    return 1;
  }

  function cleanTitle(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return t || 'Eğitim';
  }

  function fold(s) {
    return String(s == null ? '' : s)
      .replace(/[İIı]/g, 'i')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function addLink(map, href, title, base, done) {
    if (!isTrainingUrl(href, base)) return;
    const u = parseUrl(href, base);
    u.hash = '';
    const url = u.href;
    const uniq = (u.searchParams.get('Uniq') || u.searchParams.get('uniq') || '').toLowerCase();
    const key = uniq || url;
    const item = { url, title: cleanTitle(title), done: !!done };
    const prev = map.get(key);
    if (!prev || rank(url) > rank(prev.url)) {
      map.set(key, {
        url,
        title: item.title !== 'Eğitim' ? item.title : (prev && prev.title) || item.title,
        done: item.done || !!(prev && prev.done),
      });
      return;
    }
    if (item.done) prev.done = true;
    if (prev.title === 'Eğitim' && item.title !== 'Eğitim') prev.title = item.title;
  }

  /** Kart metni veya rozeti eğitimin bittiğini söylüyorsa true. "Devam et" varsa bitmiş sayılmaz. */
  function looksDone(el) {
    let node = el && el.parentElement;
    let card = null;
    for (let i = 0; node && node !== el.ownerDocument.body && i < 6; i += 1) {
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 40 && text.length < 700) {
        card = node;
        break;
      }
      node = node.parentElement;
    }
    if (!card) return false;
    const text = fold(card.innerText || '');
    if (/egitime devam et|\bdevam et\b/.test(text)) return false;
    if (/egitime tekrar katil|\btamamlandi\b|\btamamlanmis\b/.test(text)) return true;
    try {
      return !!card.querySelector(
        '[title*="tamamland" i], [aria-label*="tamamland" i], [class*="tamamland" i], [class*="completed" i]'
      );
    } catch (_) {
      return false;
    }
  }

  function titleFrom(el) {
    const own = cleanTitle(el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '');
    if (own !== 'Eğitim') return own;
    const card = el.closest && el.closest('article, li, tr, .card, .egitim, .course');
    if (!card) return own;
    const heading = card.querySelector('h1, h2, h3, h4, strong');
    return heading ? cleanTitle(heading.innerText) : own;
  }

  function collectFromDocument(doc) {
    const map = new Map();
    const base = doc.location ? doc.location.href : undefined;
    doc.querySelectorAll('a[href], [data-href], [data-url]').forEach((el) => {
      const raw = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url');
      if (!raw || /^\s*javascript:/i.test(raw)) return;
      addLink(map, raw, titleFrom(el), base, looksDone(el));
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
    (list || []).forEach((item) => addLink(map, item.url, item.title, undefined, item && item.done));
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

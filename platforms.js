/**
 * egitimSavar — platform kayıt defteri ve adaptör deposu.
 * Arka plan betiği, içerik betikleri ve popup bu dosyayı paylaşır.
 * Yeni bir eğitim platformu eklemek için:
 *   1) EgitimPlatforms.register(...) ile alan adı / URL / katalog kurallarını tanımla
 *   2) adapters/<platform>.js içinde EgitimAdapters.register(...) ile oynatıcı adaptörünü ekle
 *   3) manifest.json host_permissions ve content_scripts eşleşmelerine ekle
 */
(function (root) {
  'use strict';

  /**
   * Türkçe büyük/küçük harf ve aksan farklarını ortadan kaldırır.
   * JS'te /ileri/i "İLERİ" ile, "ÇIKIŞ".toLowerCase() "çıkış" ile eşleşmez.
   */
  function fold(s) {
    return String(s == null ? '' : s)
      .replace(/[İIı]/g, 'i')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseUrl(href, base) {
    try {
      return new URL(href, base || undefined);
    } catch (_) {
      return null;
    }
  }

  function cleanTitle(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return t || 'Eğitim';
  }

  // --- Platform tanımları ---
  const platforms = [];
  const platformById = Object.create(null);

  function registerPlatform(def) {
    if (!def || !def.id) return;
    if (platformById[def.id]) {
      const idx = platforms.findIndex((p) => p.id === def.id);
      if (idx >= 0) platforms[idx] = def;
    } else {
      platforms.push(def);
    }
    platformById[def.id] = def;
  }

  function detectByHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return null;
    return platforms.find((p) => typeof p.matchHost === 'function' && p.matchHost(host)) || null;
  }

  function detectByUrl(href, base) {
    const u = href instanceof URL ? href : parseUrl(href, base);
    if (!u) return null;
    return detectByHost(u.hostname);
  }

  function isDirectPlayerUrl(href, base) {
    const u = parseUrl(href, base);
    const p = u && detectByHost(u.hostname);
    return !!(p && typeof p.isDirectPlayerUrl === 'function' && p.isDirectPlayerUrl(u));
  }

  function isPlayerUrl(href, base) {
    const u = parseUrl(href, base);
    const p = u && detectByHost(u.hostname);
    return !!(p && typeof p.isPlayerUrl === 'function' && p.isPlayerUrl(u));
  }

  function isTrainingUrl(href, base) {
    const u = parseUrl(href, base);
    const p = u && detectByHost(u.hostname);
    return !!(p && typeof p.isTrainingUrl === 'function' && p.isTrainingUrl(u));
  }

  function rankUrl(href, base) {
    const u = parseUrl(href, base);
    const p = u && detectByHost(u.hostname);
    return p && typeof p.rankUrl === 'function' ? p.rankUrl(u) : 0;
  }

  function courseKey(href, base) {
    const u = parseUrl(href, base);
    if (!u) return String(href || '').toLowerCase();
    const p = detectByHost(u.hostname);
    if (p && typeof p.courseKey === 'function') return p.courseKey(u);
    return u.href;
  }

  function sessionKey(href, base) {
    const u = parseUrl(href, base);
    if (!u) return String(href || '').toLowerCase();
    const p = detectByHost(u.hostname);
    if (p && typeof p.sessionKey === 'function') return p.sessionKey(u);
    return (u.origin + u.pathname).toLowerCase();
  }

  function platformLabel(idOrUrl) {
    if (!idOrUrl) return '';
    const byId = platformById[idOrUrl];
    if (byId) return byId.shortName || byId.name || byId.id;
    const byUrl = detectByUrl(idOrUrl);
    return byUrl ? (byUrl.shortName || byUrl.name || byUrl.id) : '';
  }

  // --- 1) Uzaktan Eğitim Kapısı (UEK / CBİKO) ---
  registerPlatform({
    id: 'uek',
    name: 'Uzaktan Eğitim Kapısı',
    shortName: 'UEK',
    matchHost(hostname) {
      return /(?:^|\.)uzaktanegitimkapisi\.gov\.tr$/i.test(hostname)
        || /(?:^|\.)cbiko\.gov\.tr$/i.test(hostname);
    },
    isDirectPlayerUrl(u) {
      return /\/Egitimler\/(ScormV2|Video)(\/|$)/i.test(u.pathname);
    },
    isPlayerUrl(u) {
      return this.isDirectPlayerUrl(u)
        || /story\.html/i.test(u.href)
        || /vod\d*\.uzaktanegitimkapisi/i.test(u.hostname);
    },
    isTrainingUrl(u) {
      if (!/\/Egitimler\//i.test(u.pathname)) return false;
      if (this.isDirectPlayerUrl(u)) return true;
      return u.searchParams.has('Uniq') || u.searchParams.has('uniq');
    },
    rankUrl(u) {
      if (/\/ScormV2/i.test(u.href)) return 3;
      if (/\/Video/i.test(u.href)) return 2;
      return 1;
    },
    courseKey(u) {
      const uniq = (u.searchParams.get('Uniq') || u.searchParams.get('uniq') || '').toLowerCase();
      return uniq || u.href;
    },
    sessionKey(u) {
      return (u.searchParams.get('Uniq') || u.searchParams.get('uniq') || (u.origin + u.pathname)).toLowerCase();
    },
    /** Kart metni veya rozeti eğitimin bittiğini söylüyorsa true. "Devam et" varsa bitmiş sayılmaz. */
    looksDone(el) {
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
    },
    titleFrom(el) {
      const own = cleanTitle(el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '');
      if (own !== 'Eğitim') return own;
      const card = el.closest && el.closest('article, li, tr, .card, .egitim, .course');
      if (!card) return own;
      const heading = card.querySelector('h1, h2, h3, h4, strong');
      return heading ? cleanTitle(heading.innerText) : own;
    },
  });

  // --- 2) Udemy & Udemy Business (*.udemy.com) ---
  const UDEMY_NOISE_TITLE_RE = /^(start course|continue|continue course|resume|resume course|go to course|leave a rating|edit your rating|share|archive|favorite|unfavorite|kursa basla|devam et|kursa devam et|kursa git|puan ver|degerlendirme birak|yorum birak|paylas|arsivle|egitim|course)$/i;

  function findUdemyCard(el) {
    if (!el) return null;
    if (el.closest) {
      const explicit = el.closest(
        '[data-purpose="enrolled-course-card"], [class*="enrolled-course-card--container"], [class*="course-card--container"], article, li'
      );
      if (explicit) return explicit;
    }
    let node = el.parentElement;
    for (let i = 0; node && node !== el.ownerDocument.body && i < 6; i += 1) {
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 20 && text.length < 900) return node;
      node = node.parentElement;
    }
    return null;
  }

  registerPlatform({
    id: 'udemy',
    name: 'Udemy',
    shortName: 'Udemy',
    matchHost(hostname) {
      return /(?:^|\.)udemy\.com$/i.test(hostname);
    },
    isDirectPlayerUrl(u) {
      return /^\/course\/(?!draft(?:\/|$))[^/]+\/learn(\/|$)/i.test(u.pathname);
    },
    isPlayerUrl(u) {
      return this.isDirectPlayerUrl(u);
    },
    isTrainingUrl(u) {
      if (this.isDirectPlayerUrl(u)) return true;
      if (/^\/course-dashboard-redirect\/?$/i.test(u.pathname) && u.searchParams.has('course_id')) {
        return true;
      }
      const m = u.pathname.match(/^\/course\/([^/]+)\/?$/i);
      if (m && !/^(draft|subscribe|gift|create|new)$/i.test(m[1])) return true;
      return false;
    },
    rankUrl(u) {
      if (/\/learn\/lecture\//i.test(u.pathname)) return 4;
      if (/\/learn(\/|$)/i.test(u.pathname)) return 3;
      if (/^\/course-dashboard-redirect/i.test(u.pathname)) return 2;
      return 1;
    },
    courseKey(u) {
      const cid = u.searchParams.get('course_id');
      if (cid) return `udemy:id:${cid}`;
      const m = u.pathname.match(/^\/course\/([^/]+)/i);
      if (m) return `udemy:slug:${m[1].toLowerCase()}`;
      return `udemy:${u.origin}${u.pathname}`.toLowerCase();
    },
    sessionKey(u) {
      return this.courseKey(u);
    },
    looksDone(el) {
      const card = findUdemyCard(el);
      if (!card) return false;
      try {
        const meter = card.querySelector(
          '[role="progressbar"][aria-valuenow], [data-purpose="course-progress-meter"], meter, progress'
        );
        if (meter) {
          const val = Number(meter.getAttribute('aria-valuenow') || meter.getAttribute('value') || meter.value);
          const max = Number(meter.getAttribute('aria-valuemax') || meter.getAttribute('max') || meter.max || 100);
          if (isFinite(val) && isFinite(max) && max > 0 && val >= max) return true;
          if (isFinite(val) && isFinite(max) && max > 0 && val < max) return false;
        }
      } catch (_) { /* ignore */ }
      const text = fold(card.innerText || '');
      if (/\b100%\s*(complete|completed|tamamland|bitti)?\b|%100\s*(tamamland|bitti)?/.test(text)) {
        return true;
      }
      return false;
    },
    titleFrom(el) {
      const card = findUdemyCard(el);
      if (card) {
        const heading = card.querySelector(
          'h3[data-purpose="course-title-url"], [data-purpose="course-title-url"], [data-purpose="course-title"], h3, h2, h4'
        );
        if (heading) {
          const t = cleanTitle(heading.innerText || heading.textContent || '');
          if (t !== 'Eğitim' && !UDEMY_NOISE_TITLE_RE.test(fold(t))) return t;
        }
      }
      const own = cleanTitle(el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '');
      if (own !== 'Eğitim' && !UDEMY_NOISE_TITLE_RE.test(fold(own))) return own;
      // Son çare: URL slug'ından okunabilir başlık üret
      const raw = (el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href'))) || '';
      const m = raw.match(/\/course\/([^/?#]+)/i);
      if (m && m[1]) {
        return cleanTitle(decodeURIComponent(m[1]).replace(/[-_]+/g, ' '));
      }
      return 'Eğitim';
    },
  });

  // --- İçerik betiği oynatıcı adaptör deposu ---
  const adapters = [];
  const adapterById = Object.create(null);

  function registerAdapter(adapter) {
    if (!adapter || !adapter.id) return;
    if (adapterById[adapter.id]) {
      const idx = adapters.findIndex((a) => a.id === adapter.id);
      if (idx >= 0) adapters[idx] = adapter;
    } else {
      adapters.push(adapter);
    }
    adapterById[adapter.id] = adapter;
  }

  function resolveAdapter(loc) {
    const locationObj = loc || (typeof location !== 'undefined' ? location : null);
    if (!locationObj) return adapters[0] || null;
    const plat = detectByHost(locationObj.hostname);
    if (plat && adapterById[plat.id]) return adapterById[plat.id];
    const direct = adapters.find((a) => typeof a.matches === 'function' && a.matches(locationObj));
    return direct || null;
  }

  root.EgitimPlatforms = {
    fold,
    parseUrl,
    cleanTitle,
    register: registerPlatform,
    list: () => platforms.slice(),
    get: (id) => platformById[id] || null,
    detectByHost,
    detectByUrl,
    isDirectPlayerUrl,
    isPlayerUrl,
    isTrainingUrl,
    rankUrl,
    courseKey,
    sessionKey,
    platformLabel,
  };

  root.EgitimAdapters = {
    register: registerAdapter,
    get: (id) => adapterById[id] || null,
    list: () => adapters.slice(),
    resolve: resolveAdapter,
  };
})(globalThis);

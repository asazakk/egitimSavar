/**
 * egitimSavar — content script (all_frames)
 * ScormV2 (Storyline / vod3) + Video.js (CbikoPl) destekler.
 */
(() => {
  'use strict';

  const TAG = '[egitimSavar]';
  const extApi = typeof browser !== 'undefined' ? browser : chrome;
  const CONFIG = {
    // Storyline 16x + agresif tık = advanceSlide crash → platform Anasayfa'ya atıyor
    targetRateScorm: 4,
    targetRateVideoJs: 8,
    pollMs: 300,
    endedRatio: 0.99,
    nextCooldownMs: 450,
    hotspotCooldownMs: 2500,
    playerRetryMs: 500,
    postAdvanceLockMs: 500,
    // Video.js'te sonraki derse tıklayınca sayfa yenilenir; tekrar tıklamayı önle
    videoJsLockMs: 4000,
    postEndedWaitMs: 300,
    // Sıra Sizde özel handler açık
    siraSizdeCooldownMs: 1100,
    // Rapor: içerik betiği durum bilgisini bu aralıkla arka plana yollar
    heartbeatMs: 4000,
    // İLERİ açık olsa bile medya bitene kadar beklenecek ek süre (güvenlik payı)
    mediaWaitExtraMs: 20000,
    modalClickCooldownMs: 1200,
    // Video içi "Gönder": tıklama/seçenek denemeleri arası ve ekran başına üst sınır
    gonderCooldownMs: 1200,
    maxGonderPerSlide: 12,
    maxRuntimeMs: 6 * 60 * 60 * 1000,
    maxNextClicks: 1500,
    stuckSlideMs: 3 * 60 * 1000,
  };

  if (window.__uekExt && typeof window.__uekExt.stop === 'function') {
    window.__uekExt.stop();
  }

  const state = {
    stopped: false,
    mode: 'unknown',
    quizPaused: false,
    quizLogged: false,
    advancing: false,
    slideLockUntil: 0,
    lastAdvanceAt: 0,
    lastHotspotAt: 0,
    passSlideKey: '',
    passClicked: {},
    advanceFromSlide: null,
    boundMedia: null,
    boundPlayer: null,
    mediaEndedArmed: false,
    muteHooked: false,
    lastSiraAt: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    nextClicks: 0,
    heldSlide: '',
    activitySlide: '',
    lastMediaTime: 0,
    deepRoots: null,
    deepRootsUntil: 0,
    limitLogged: false,
    mediaWaitSince: 0,
    lastGonderAt: 0,
    gonderCount: 0,
    lastModalAt: 0,
    lastTickError: '',
    lastTickErrorAt: 0,
    finishSent: false,
    finishReason: '',
    finishSince: 0,
    finishPollAt: 0,
    managedTab: false,
    lastStartClickAt: 0,
    messageListener: null,
    intervals: [],
    timeouts: [],
    observers: [],
    listeners: [],
  };

  /**
   * Türkçe büyük/küçük harf ve aksan farklarını ortadan kaldırır.
   * JS'te /ileri/i "İLERİ" ile, "ÇIKIŞ".toLowerCase() "çıkış" ile eşleşmez; tüm
   * metin eşleştirmeleri bu fonksiyondan geçirilmiş ASCII metin üzerinde yapılır.
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

  // --- günlük / rapor ---
  // Rapor sayfası için olaylar arka plana yollanır. İçeriksiz (about:blank vb.) alt
  // çerçeveler raporu kirletmesin diye yalnız üst çerçeve veya oynatıcı çerçeveleri bildirir.
  function shouldReport() {
    return window === window.top || state.mode !== 'parent';
  }

  function sendToBackground(msg) {
    try {
      const p = extApi.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* eklenti bağlamı yok */ }
  }

  function emit(level, args) {
    const text = args.map(String).join(' ');
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(TAG, text);
    if (shouldReport()) {
      sendToBackground({ type: 'uek-log', level, text, url: location.href });
    }
  }

  function log(...args) { emit('info', args); }
  function ok(...args) { emit('ok', args); }
  function warn(...args) { emit('warn', args); }
  function fail(...args) { emit('error', args); }

  function trackInterval(fn, ms) {
    const id = setInterval(() => {
      if (!state.stopped) fn();
    }, ms);
    state.intervals.push(id);
    return id;
  }

  function trackTimeout(fn, ms) {
    const id = setTimeout(() => {
      if (!state.stopped) fn();
    }, ms);
    state.timeouts.push(id);
    return id;
  }

  function on(target, type, handler, options) {
    const wrapped = (...a) => {
      if (!state.stopped) handler(...a);
    };
    target.addEventListener(type, wrapped, options);
    state.listeners.push({ target, type, wrapped, options });
  }

  function detectMode() {
    const href = location.href;
    const host = location.host || '';
    // #ScoFrame (içerik iframe'i) olan sayfa üst çerçevedir; URL'de "ScormV2" geçse de
    // medya/tıklama mantığı yalnız içerik çerçevesinde çalışmalı.
    if (document.querySelector('#ScoFrame')) return 'parent';
    if (/story\.html/i.test(href) || /vod\d*\.uzaktanegitimkapisi/i.test(host) || /SCORM/i.test(href)) {
      return 'scorm';
    }
    if (/\/Egitimler\/Video/i.test(href) || document.querySelector('#CbikoPl, .video-js')) {
      return 'videojs';
    }
    if (document.querySelector('video, audio')) return 'media';
    return 'parent';
  }

  // --- media helpers ---
  function getVideoEl(player) {
    if (!player) return null;
    if (player.tagName === 'VIDEO' || player.tagName === 'AUDIO') return player;
    try {
      if (typeof player.el === 'function') {
        const el = player.el();
        if (el) return el.querySelector('video') || el.querySelector('audio');
      }
      if (player.tech_ && player.tech_.el_) return player.tech_.el_;
    } catch (_) { /* ignore */ }
    return null;
  }

  function findVideoJsPlayer() {
    try {
      if (typeof videojs === 'undefined' || typeof videojs.getPlayer !== 'function') return null;
      const p = videojs.getPlayer('CbikoPl');
      if (p) return p;
      const all = typeof videojs.getPlayers === 'function' ? videojs.getPlayers() : {};
      const keys = Object.keys(all || {});
      return keys.length ? all[keys[0]] : null;
    } catch (_) {
      return null;
    }
  }

  function findHtmlMedia() {
    return (
      document.querySelector('video:not([data-uek-ignore])') ||
      document.querySelector('audio:not([data-uek-ignore])')
    );
  }

  function resolveBundle() {
    const player = findVideoJsPlayer();
    const media = getVideoEl(player) || findHtmlMedia();
    return { player, media };
  }

  function readTime(player, media) {
    try {
      if (player && typeof player.currentTime === 'function') return player.currentTime() || 0;
    } catch (_) { /* ignore */ }
    return media ? media.currentTime || 0 : 0;
  }

  function readDuration(player, media) {
    try {
      if (player && typeof player.duration === 'function') {
        const d = player.duration();
        if (d && isFinite(d) && d > 0) return d;
      }
    } catch (_) { /* ignore */ }
    const d = media && media.duration;
    return d && isFinite(d) && d > 0 ? d : 0;
  }

  function isPaused(player, media) {
    try {
      if (player && typeof player.paused === 'function') return player.paused();
    } catch (_) { /* ignore */ }
    return !media || media.paused;
  }

  function isEnded(player, media) {
    try {
      if (player && typeof player.ended === 'function') return player.ended();
    } catch (_) { /* ignore */ }
    return !!(media && media.ended);
  }

  function setMuted(player, media, muted) {
    try {
      if (player && typeof player.muted === 'function') player.muted(muted);
    } catch (_) { /* ignore */ }
    try {
      if (player && typeof player.volume === 'function') player.volume(0);
    } catch (_) { /* ignore */ }
    if (media) {
      media.muted = muted;
      try {
        media.volume = 0;
      } catch (_) { /* ignore */ }
      try {
        media.setAttribute('muted', muted ? 'true' : 'false');
      } catch (_) { /* ignore */ }
    }
  }

  /** Açık shadow kökleri dahil. Iframe’ler all_frames ile ayrı dokümanda çalışır. */
  function collectDeepRoots(start) {
    const roots = [];
    const seen = new Set();
    const stack = [start || document];
    while (stack.length) {
      const root = stack.pop();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
      let nodes = [];
      try {
        nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
      } catch (_) {
        continue;
      }
      for (let i = 0; i < nodes.length; i += 1) {
        if (nodes[i].shadowRoot) stack.push(nodes[i].shadowRoot);
      }
    }
    return roots;
  }

  function queryDeepAll(selector, start) {
    let roots;
    if (!start && state.deepRoots && Date.now() < state.deepRootsUntil) {
      roots = state.deepRoots;
    } else {
      roots = collectDeepRoots(start || document);
      if (!start) {
        state.deepRoots = roots;
        state.deepRootsUntil = Date.now() + 1000;
      }
    }
    const found = new Set();
    roots.forEach((root) => {
      try {
        root.querySelectorAll(selector).forEach((el) => found.add(el));
      } catch (_) { /* geçersiz seçici */ }
    });
    return [...found];
  }

  function queryDeep(selector, start) {
    return queryDeepAll(selector, start)[0] || null;
  }

  function parentNodeOf(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    if (root && root.host) return root.host;
    return null;
  }

  function noteActivity() {
    state.lastActivityAt = Date.now();
    state.heldSlide = '';
  }

  function mediaMoved() {
    const { media } = resolveBundle();
    if (!media || media.paused || media.ended) return false;
    const t = media.currentTime || 0;
    if (t > state.lastMediaTime + 0.25) {
      state.lastMediaTime = t;
      return true;
    }
    return false;
  }

  // Gizli sekmede tarayıcı sessiz videoyu durdurur. Kısık ama kapalı olmayan ses oynatmayı ayakta tutar.
  const KEEPALIVE_VOLUME = 0.02;

  /** İzole dünyada document.hidden gerçektir; sayfa dünyasındaki sahte "görünür" buraya sızmaz. */
  function tabHidden() {
    return document.hidden || visibility.hidden;
  }

  function mediaRolling(el) {
    return !!(el && !el.ended && !el.paused && (el.currentTime || 0) > 0.2);
  }

  function keepAliveElement(el) {
    try {
      // Henüz başlamamış videoyu gizli sekmede sesli açmak tarayıcının play() çağrısını reddeder.
      // Önce sessiz başlar; ilerledikten sonra kısık sese geçilir.
      if (!mediaRolling(el)) {
        el.muted = true;
        el.volume = 0;
        el.setAttribute('muted', 'true');
        return;
      }
      el.muted = false;
      el.removeAttribute('muted');
      el.volume = KEEPALIVE_VOLUME;
    } catch (_) { /* ignore */ }
  }

  /** Kilitten bağımsız: tüm HTML medya + Video.js + Storyline sesi */
  function muteAll() {
    if (tabHidden()) {
      queryDeepAll('audio, video').forEach((el) => {
        if (!el.ended) keepAliveElement(el);
      });
      try {
        const player = findVideoJsPlayer();
        if (player) {
          if (typeof player.muted === 'function') player.muted(false);
          if (typeof player.volume === 'function') player.volume(KEEPALIVE_VOLUME);
        }
      } catch (_) { /* ignore */ }
      try {
        if (typeof GetPlayer === 'function') {
          const sp = GetPlayer();
          if (sp && typeof sp.SetVolume === 'function') sp.SetVolume(2);
        }
      } catch (_) { /* ignore */ }
      return;
    }
    queryDeepAll('audio, video').forEach((el) => {
      try {
        el.muted = true;
        el.volume = 0;
        el.setAttribute('muted', 'true');
      } catch (_) { /* ignore */ }
    });
    try {
      const player = findVideoJsPlayer();
      if (player) {
        if (typeof player.muted === 'function') player.muted(true);
        if (typeof player.volume === 'function') player.volume(0);
      }
    } catch (_) { /* ignore */ }
    try {
      if (typeof GetPlayer === 'function') {
        const sp = GetPlayer();
        if (sp && typeof sp.SetVolume === 'function') sp.SetVolume(0);
      }
    } catch (_) { /* ignore */ }
  }

  function installMuteHooks() {
    if (state.muteHooked) return;
    state.muteHooked = true;
    on(document, 'play', (ev) => {
      const t = ev.target;
      if (!t || (t.tagName !== 'AUDIO' && t.tagName !== 'VIDEO')) return;
      try {
        if (tabHidden()) {
          keepAliveElement(t);
          return;
        }
        t.muted = true;
        t.volume = 0;
      } catch (_) { /* ignore */ }
      muteAll();
    }, true);
  }

  function setRate(player, media, rate) {
    try {
      if (player && typeof player.playbackRate === 'function') player.playbackRate(rate);
    } catch (_) { /* ignore */ }
    if (media) media.playbackRate = rate;
  }

  function playSafe(player, media) {
    try {
      if (player && typeof player.play === 'function') {
        const p = player.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return;
      }
    } catch (_) { /* ignore */ }
    if (media) {
      const p = media.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  function currentTargetRate() {
    return state.mode === 'videojs' ? CONFIG.targetRateVideoJs : CONFIG.targetRateScorm;
  }

  function applyPlayback(player, media) {
    muteAll();
    if (!player && !media) return;
    // Slayt geçişi sırasında play/rate spam Storyline'ı düşürüyor
    if (Date.now() < state.slideLockUntil) return;
    if (tabHidden()) {
      if (media) keepAliveElement(media);
      const rate = currentTargetRate();
      setRate(player, media, rate);
      if (!isEnded(player, media) && isPaused(player, media)) playSafe(player, media);
      return;
    }
    setMuted(player, media, true);
    const rate = currentTargetRate();
    setRate(player, media, rate);
    if (media && media.playbackRate !== rate) {
      try {
        media.playbackRate = rate;
      } catch (_) { /* ignore */ }
    }
    if (!isEnded(player, media) && isPaused(player, media)) {
      playSafe(player, media);
    }
  }

  // --- quiz / modal ---
  function isQuizLike(root) {
    if (!root) return false;
    if (root.querySelector('input[type="radio"], input[type="checkbox"], textarea, select')) {
      return true;
    }
    const text = fold(root.textContent || '');
    const hints = ['soru', 'sik', 'sinav', 'cevap', 'sira sizde'];
    return hints.filter((h) => text.includes(h)).length >= 2;
  }

  function pageHasQuiz() {
    if (state.mode === 'parent') return false;
    // Sıra Sizde artık otomatik çözülür; burada sadece gerçek sınav formu
    const bodyText = fold((document.body && document.body.innerText) || '');
    if (/sira sizde/.test(bodyText)) return false;
    if (!/soru ?\d|sinav/.test(bodyText)) return false;
    return !!document.querySelector('input[type="radio"], input[type="checkbox"], textarea');
  }

  function isSiraSizdeSlide() {
    const text = fold((document.body && document.body.innerText) || '');
    if (/sira sizde/.test(text)) return true;
    return !!queryDeep(
      '[data-acc-text*="Sıra Sizde" i], [data-acc-text*="Sira Sizde" i], .acc-checkbox'
    );
  }

  function isShownSlideObject(el) {
    if (!el || !el.classList) return visible(el);
    if (el.classList.contains('hidden')) return false;
    return el.classList.contains('shown') || visible(el);
  }

  /** Storyline seçimi çoğu zaman checkbox.checked değil; görsel state ile gelir */
  function countVisualSelections() {
    return queryDeepAll(
      '.slide-object.shown[data-acc-text*="coklu_secim_secim"], .slide-object.shown[data-acc-text*="coklu_secim_dogru"], [data-acc-text*="coklu_secim_secim"].shown'
    ).length;
  }

  function findKontrolEt() {
    const nodes = queryDeepAll(
      'button.acc-button, .slide-object.shown[data-acc-text], .slide-object.shown, button'
    );
    return nodes.find((el) => {
      const label = fold(controlLabel(el));
      const acc = fold(el.getAttribute('data-acc-text') || '');
      if (!/kontrol ?et/.test(label) && !/kontrol ?et/.test(acc)) return false;
      if (el.classList && el.classList.contains('hidden')) return false;
      if (/pasif/.test(fold(String(el.className)) + ' ' + acc)) return false;
      return isShownSlideObject(el) || visible(el);
    });
  }

  /**
   * Sıra Sizde: seçenek işaretle → Kontrol Et → (gerekirse) Doğru Cevabı Gör
   * İLERİ ancak bundan sonra açılıyor.
   */
  function handleSiraSizde() {
    if (Date.now() < state.slideLockUntil) return false;
    const now = Date.now();
    if (now - state.lastSiraAt < CONFIG.siraSizdeCooldownMs) return false;

    // 1) Doğru Cevabı Gör
    const reveal = Array.from(
      queryDeepAll('button.acc-button, .slide-object, [data-acc-text], button')
    ).find((el) => {
      return /dogru ?cevabi ?gor/.test(fold(controlLabel(el))) && isShownSlideObject(el);
    });
    if (reveal && !isDangerousNav(reveal)) {
      state.lastSiraAt = now;
      log('Sıra Sizde: Doğru Cevabı Gör');
      softClick(reveal);
      return true;
    }

    const visualSel = countVisualSelections();
    const boxes = queryDeepAll('input.acc-checkbox, input[type="checkbox"]');
    const checkedBoxes = boxes.filter((el) => el.checked).length;
    const hasSelection = visualSel > 0 || checkedBoxes > 0;

    // 2) Seçim varsa önce Kontrol Et (checkbox.checked Storyline'da çoğu zaman false kalıyor)
    const kontrol = findKontrolEt();
    if (hasSelection && kontrol && !isDangerousNav(kontrol)) {
      state.lastSiraAt = now;
      log('Sıra Sizde: Kontrol Et (seçim=', visualSel || checkedBoxes, ')');
      softClick(kontrol);
      // acc-button yedek
      const accKontrol = queryDeepAll('button.acc-button').find((el) =>
        /^kontrol ?et$/.test(fold(el.textContent))
      );
      if (accKontrol) softClick(accKontrol);
      return true;
    }

    // 3) Seçim yoksa seçeneklere tıkla (görsel state group / metin)
    const optionEls = Array.from(
      queryDeepAll(
        '.slide-object.shown.cursor-hover, .slide-object.shown.slide-object-stategroup, .slide-object.shown[data-acc-text], button.acc-button'
      )
    ).filter((el) => {
      if (isDangerousNav(el)) return false;
      const label = controlLabel(el).trim();
      if (!label || label.length < 10) return false;
      if (/kontrol ?et|ileri|geri|next|previous|rectangle|coklu_secim|png|group|casgem|asset|sira ?sizde|tekrar ?dene|dogru ?cevab|image ?\d/.test(fold(label))) {
        return false;
      }
      return isShownSlideObject(el);
    });

    // Checkbox'lara da bas (Storyline bazen bunları dinler)
    const unchecked = boxes.filter((el) => !el.checked);
    if (!hasSelection && unchecked.length) {
      state.lastSiraAt = now;
      const box = unchecked[Math.min(state._siraOptIdx || 0, unchecked.length - 1)];
      state._siraOptIdx = (state._siraOptIdx || 0) + 1;
      log('Sıra Sizde: checkbox tık', box.id || '');
      try {
        box.click();
      } catch (_) {
        softClick(box);
      }
      return true;
    }

    if (!hasSelection && optionEls.length) {
      state.lastSiraAt = now;
      const idx = (state._siraOptIdx || 0) % optionEls.length;
      state._siraOptIdx = idx + 1;
      log('Sıra Sizde: seçenek tık', controlLabel(optionEls[idx]).slice(0, 70));
      softClick(optionEls[idx]);
      return true;
    }

    // Seçim var ama kontrol bulunamadı — yine dene / tüm seçenekleri doldur
    if (!hasSelection && optionEls.length === 0) {
      log('Sıra Sizde: seçenek DOM bulunamadı');
    }
    if (hasSelection && !kontrol) {
      state.lastSiraAt = now;
      log('Sıra Sizde: Kontrol Et bulunamadı, acc-button aranıyor');
      const accKontrol = queryDeepAll('button.acc-button').find((el) =>
        /kontrol ?et/.test(fold(el.textContent))
      );
      if (accKontrol) {
        softClick(accKontrol);
        return true;
      }
    }

    return false;
  }

  // --- "Gönder" (video içi soru / anket) ---
  // Videonun ortasında çıkan soru/anket "Gönder"e basılana kadar oynatmayı duraklatır.
  const GONDER_RE = /^((cevabi|yaniti) )?gonder$|^submit$|^send$/;

  function gonderLabel(el) {
    const raw = (el.tagName === 'INPUT' ? el.value : '')
      || el.getAttribute('aria-label')
      || el.getAttribute('data-acc-text')
      || el.textContent
      || '';
    return fold(raw);
  }

  function findGonder() {
    const nodes = queryDeepAll(
      'button, a, input[type="submit"], input[type="button"], [role="button"], .acc-button, [data-acc-text]'
    );
    const hits = nodes.filter((el) => {
      const label = gonderLabel(el);
      if (label.length > 24 || !GONDER_RE.test(label)) return false;
      if (isDangerousNav(el)) return false;
      return isShownSlideObject(el);
    });
    // İç içe aynı etiket (slide-object > button): en içtekini seç
    const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    return inner[0] || null;
  }

  function isGonderDisabled(el) {
    if (!looksEnabled(el)) return true;
    return /pasif|disabled/.test(fold(`${el.className} ${el.getAttribute('data-acc-text') || ''}`));
  }

  /** Gönder pasifken (seçim yapılmadan açılmıyorsa) bir seçenek işaretler; her denemede sıradakini dener. */
  function pickAnyOption() {
    const inputs = queryDeepAll('input[type="radio"], input[type="checkbox"]')
      .filter((el) => !el.disabled && !el.checked);
    if (inputs.length) {
      const idx = (state._gonderOptIdx || 0) % inputs.length;
      state._gonderOptIdx = idx + 1;
      log('Gönder pasif — seçenek işaretleniyor (input).');
      try {
        inputs[idx].click();
      } catch (_) {
        softClick(inputs[idx]);
      }
      return true;
    }
    const options = queryDeepAll(
      '.slide-object.shown.cursor-hover, .slide-object.shown.slide-object-stategroup, .slide-object.shown[data-acc-text], button.acc-button'
    ).filter((el) => {
      if (isDangerousNav(el)) return false;
      const label = controlLabel(el).trim();
      if (!label || label.length < 10) return false;
      if (/kontrol ?et|gonder|submit|ileri|geri|next|previous|rectangle|png|group|casgem|asset|tekrar ?dene|image ?\d/.test(fold(label))) {
        return false;
      }
      return isShownSlideObject(el);
    });
    if (options.length) {
      const idx = (state._gonderOptIdx || 0) % options.length;
      state._gonderOptIdx = idx + 1;
      log('Gönder pasif — seçenek tıklanıyor:', controlLabel(options[idx]).slice(0, 60));
      return softClick(options[idx]);
    }
    return false;
  }

  /** true: bu turda bir işlem yapıldı (Gönder tıklandı ya da seçenek işaretlendi). */
  function handleGonder() {
    const now = Date.now();
    if (now < state.slideLockUntil) return false;
    if (now - state.lastGonderAt < CONFIG.gonderCooldownMs) return false;
    const btn = findGonder();
    if (!btn) return false;

    // Gerçek sınav sayfasında otomatik gönderme yok (içinde "sınav" geçen soru formları)
    if (pageHasQuiz() && /sinav/.test(fold((document.body && document.body.innerText) || ''))) {
      if (!state._loggedGonderExam) {
        state._loggedGonderExam = true;
        warn('"Gönder" bir sınav formunda — otomatik gönderilmedi, elle gönderin.');
      }
      return false;
    }
    if (state.gonderCount >= CONFIG.maxGonderPerSlide) {
      if (!state._loggedGonderLimit) {
        state._loggedGonderLimit = true;
        warn('"Gönder" bu ekranda otomatik geçilemedi — elle tıklamanız gerekebilir.');
      }
      return false;
    }

    if (!isGonderDisabled(btn)) {
      state.lastGonderAt = now;
      state.gonderCount += 1;
      ok('"Gönder" tıklandı.');
      return softClick(btn);
    }
    if (pickAnyOption()) {
      state.lastGonderAt = now;
      state.gonderCount += 1;
      return true;
    }
    return false;
  }

  function dialogLooksLikeContinue(root) {
    const text = fold(root.textContent || '');
    // Dar tut: "tamam/devam/evet" tek başına çıkış/anasayfa modalını da yakalıyordu
    return [
      'izlemeye devam',
      'devam ediyor mus',
      'devam etmek istiyor',
      'hala izliyor',
      'continue watching',
      'are you still watching',
    ].some((k) => text.includes(k));
  }

  function isDangerousNav(el) {
    if (!el) return true;
    const label = fold(controlLabel(el));
    const href = (el.getAttribute && (el.getAttribute('href') || '')) || '';
    if (/ana ?sayfa|anasayfa|cikis|cikmak|katalog|home|logout|exit|kapat/.test(label)) return true;
    if (/Anasayfa|AnaSayfa|Giris|Logout|Home/i.test(href)) return true;
    return false;
  }

  function clickContinueModals() {
    const now = Date.now();
    if (now - state.lastModalAt < CONFIG.modalClickCooldownMs) return;
    // [class*="swal"] kullanılmaz: swal-overlay + swal-modal aynı diyaloğu iki kez işliyordu
    const roots = document.querySelectorAll(
      '.swal-modal, .swal2-popup, .sweet-alert, .modal.show, .modal.in, [role="dialog"]'
    );
    for (const root of roots) {
      // Sınav modalını updateQuizState bildirir; burada dokunma
      if (isQuizLike(root)) continue;
      // Yalnız "izlemeye devam ediyor musunuz" türü diyalog. Eskiden her SweetAlert onay
      // düğmesi (çıkış / ana sayfa onayı dahil) tıklanıyordu.
      if (!dialogLooksLikeContinue(root)) continue;
      if (/cikis|cikmak|ana ?sayfa|oturumu kapat|logout/.test(fold(root.textContent))) continue;
      const btn =
        root.querySelector('.swal-button--confirm') ||
        root.querySelector('.swal2-confirm') ||
        Array.from(root.querySelectorAll('button, .swal-button, .btn')).find((b) =>
          /\b(devam|tamam|onay|evet|ok)\b/.test(fold(b.textContent))
        );
      if (btn && !btn.disabled) {
        state.lastModalAt = now;
        ok('"İzlemeye devam" onayı tıklandı:', (btn.textContent || '').trim());
        btn.click();
        return;
      }
    }
  }

  function updateQuizState() {
    if (pageHasQuiz() || [...document.querySelectorAll('.swal-modal, .swal2-popup, [role="dialog"]')].some(isQuizLike)) {
      if (!state.quizLogged) {
        state.quizPaused = true;
        state.quizLogged = true;
        warn('Sınav/Sıra Sizde göründü — cevabı elle verin; İLERİ yine denenecek.');
      }
      return true;
    }
    if (state.quizPaused) {
      state.quizPaused = false;
      state.quizLogged = false;
      log('Sınav görünümü kalktı — otomatik ilerleme devam ediyor.');
    }
    return false;
  }

  // --- visibility ---
  /**
   * Sekme görünürlüğü. Sayfa tarafı page-guard.js (world: MAIN) ile yapılır: sahte "görünür"
   * durum, olay kesme ve arka plandayken pause() engeli. Bu fonksiyon yalnızca o betiğin
   * bildirdiği gerçek durumu takip eder, oynatmayı geri açar ve raporlar.
   */
  const visibility = {
    hidden: false,
    guardReady: false,
    pauseBlocked: 0,
    lastPauseLogAt: 0,
    lastGuardTickAt: 0,
    lastBeatAt: 0,
  };

  function resumeAfterVisibility() {
    const { player, media } = resolveBundle();
    if (!isEnded(player, media)) {
      playSafe(player, media);
      applyPlayback(player, media);
    }
  }

  /** page-guard.js (MAIN dünya) mesajları. İki dünya ayrı window nesnesi gördüğü için postMessage. */
  function onGuardMessage(ev) {
    if (ev.source !== window || !ev.data || ev.data.__egitimSavar !== true) return;
    const d = ev.data;
    if (d.kind === 'ready') {
      visibility.guardReady = true;
    } else if (d.kind === 'tick') {
      // Gizli sekmede kendi setInterval'imiz kısılır; page-guard'ın worker saati sürücü olur
      visibility.lastGuardTickAt = Date.now();
      safeTick();
      if (Date.now() - visibility.lastBeatAt > 3500) {
        visibility.lastBeatAt = Date.now();
        sendHeartbeat();
      }
    } else if (d.kind === 'visibility') {
      const was = visibility.hidden;
      visibility.hidden = !!d.hidden;
      if (visibility.hidden && !was) {
        ok('Sekme arka plana geçti — oynatma sürdürülüyor.');
      } else if (!visibility.hidden && was) {
        ok('Sekme yeniden öne geldi.');
        resumeAfterVisibility();
      }
    } else if (d.kind === 'pause-blocked') {
      visibility.pauseBlocked = d.count;
      // Log taşmasın: en fazla 15 sn'de bir özetle. Oynatma zaten sürüyor (pause yok sayıldı).
      const now = Date.now();
      if (now - visibility.lastPauseLogAt > 15000) {
        visibility.lastPauseLogAt = now;
        ok(`Arka plandayken sayfanın duraklatması engellendi (toplam ${d.count}).`);
      }
    }
  }

  function installFocusGuards() {
    on(window, 'message', onGuardMessage);
    on(window, 'focus', resumeAfterVisibility, true);
    // page-guard hiç çalışmadıysa (eski tarayıcı, sayfa CSP vb.) bunu raporla
    trackTimeout(() => {
      if (!visibility.guardReady) {
        warn('Sayfa koruması (page-guard) yüklenmedi — arka plan oynatması garanti değil.');
      }
    }, 2500);
  }

  // --- SCORM next / hotspots ---
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function getSlideIndex() {
    try {
      if (typeof GetPlayer === 'function') {
        const player = GetPlayer();
        if (player && typeof player.GetCurrentSlideIndex === 'function') {
          return player.GetCurrentSlideIndex();
        }
      }
    } catch (_) { /* ignore */ }
    const root = queryDeep('#slide');
    if (root) {
      return root.getAttribute('data-index') || root.getAttribute('data-slide-id') || null;
    }
    return null;
  }

  function releaseAdvanceLockIfSlideChanged() {
    if (state.advanceFromSlide == null) return;
    const cur = getSlideIndex();
    if (cur == null || String(cur) === String(state.advanceFromSlide)) return;
    state.slideLockUntil = 0;
    state.advancing = false;
    state.advanceFromSlide = null;
    state.mediaEndedArmed = false;
    state._loggedLocked = false;
    state._loggedWaitNext = false;
    state.passSlideKey = '';
    state.passClicked = {};
    log('Slayt değişti — İLERİ kilidi açıldı.');
  }

  function isSlideLocked() {
    releaseAdvanceLockIfSlideChanged();
    return Date.now() < state.slideLockUntil || state.advancing;
  }

  function lockSlide(ms) {
    state.slideLockUntil = Date.now() + (ms || CONFIG.postAdvanceLockMs);
    state.advancing = true;
    trackTimeout(() => {
      state.advancing = false;
    }, Math.min(ms || CONFIG.postAdvanceLockMs, 1500));
  }

  /** Storyline: class/DOM zorlamadan yumuşak tık — sentetik event crash'e yol açıyordu */
  function softClick(el) {
    if (!el || isDangerousNav(el)) return false;
    try {
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function looksEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList && (el.classList.contains('disabled') || el.classList.contains('nav-disabled'))) {
      return false;
    }
    // Storyline nav: üstte aria-disabled / disabled class varsa kilitli
    const lockHost = el.closest
      ? el.closest('[aria-disabled="true"], .disabled, .nav-disabled, .cs-disabled')
      : null;
    if (lockHost && lockHost !== document.body) return false;
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === 'none') {
      // İkon/label pointer-events:none olabilir; üst düğmeyi dene
      const parent = el.parentElement;
      if (!parent || window.getComputedStyle(parent).pointerEvents === 'none') return false;
    }
    if (parseFloat(style.opacity) < 0.35) return false;
    return true;
  }

  function controlLabel(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('data-acc-text'),
      el.getAttribute('title'),
      el.id,
      el.className,
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Storyline nav: .next-icon / data-ref=label "İLERİ" → tıklanabilir üst düğme */
  function resolveClickable(el) {
    if (!el) return null;
    let cur = el;
    for (let i = 0; i < 8 && cur; i += 1) {
      if (cur.matches && cur.matches('button, a, [role="button"], #next, #btnnext, .cs-button, .nav-button')) {
        return cur;
      }
      const id = (cur.id || '').toLowerCase();
      if (id === 'next' || id === 'btnnext') return cur;
      if (cur.getAttribute && cur.getAttribute('tabindex') != null && looksEnabled(cur) && visible(cur)) {
        return cur;
      }
      cur = parentNodeOf(cur);
    }
    return el.closest ? (el.closest('button, a, [role="button"], #next, .cs-button') || el) : el;
  }

  function findStorylineNextButton() {
    const byIcon = queryDeep(
      'svg.cs-icon.next-icon, svg.next-icon, .btn-icon .next-icon, .cs-icon.next-icon'
    );
    if (byIcon) {
      const btn = resolveClickable(byIcon);
      if (btn && visible(btn) && !isDangerousNav(btn)) return btn;
    }

    const labels = queryDeepAll(
      'span[data-ref="label"], .view-content [data-ref="label"], .text.resizeable-text'
    );
    for (const label of labels) {
      // "İLERİ" /^ileri$/i ile eşleşmez; fold() ile karşılaştır
      const text = fold(label.textContent);
      if (text !== 'ileri' && text !== 'next') continue;
      const btn = resolveClickable(label);
      if (!btn || isDangerousNav(btn)) continue;
      if (!visible(btn)) continue;
      return btn;
    }

    const byId = queryDeep('#next, #btnnext, [id="next"]');
    if (byId && visible(byId) && !isDangerousNav(byId)) return byId;
    return null;
  }

  function findNextControl() {
    const story = findStorylineNextButton();
    if (story) return story;

    // Yedek: nav içindeki İLERİ / Next
    const navPreferred = [
      queryDeep('#next'),
      queryDeep('#btnnext'),
      ...queryDeepAll(
        '#nav button, #nav a, #nav [role="button"], .nav-controls button, .nav-controls a, .cs-button[data-acc-text*="İleri" i], .cs-button[data-acc-text*="LERİ"], .cs-button[data-acc-text*="ileri" i], .cs-button[data-acc-text*="Next" i]'
      ),
    ].filter(Boolean);

    const score = (el) => {
      const id = (el.id || '').toLowerCase();
      const label = fold(controlLabel(el));
      const inNav = !!(el.closest && el.closest('#nav, #controls, .controls-container, .nav-controls, #control-bar, .control-bar'));
      if (/geri|previous|prev|back/.test(label) && !/ileri|next/.test(label)) return -1;
      if (id === 'next' || id === 'btnnext') return inNav ? 120 : 110;
      if (/^(ileri|>? ?ileri|ileri ?>|next)$/.test(label)) return inNav ? 115 : 100;
      if (inNav && /\bileri\b|\bnext\b|sonraki/.test(label)) return 105;
      if (/\bileri\b|\bnext\b|sonraki/.test(label)) return inNav ? 95 : 55;
      if (/nav.*next|next.*button|btnnext|nextbtn/.test(label)) return 70;
      return 0;
    };

    const candidates = Array.from(new Set([
      ...navPreferred,
      ...queryDeepAll(
        'button, a, [role="button"], [data-acc-text], .nav-button, [class*="next"], [class*="Next"], [class*="ileri"], [class*="forward"]'
      ),
    ]));

    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (r.width <= 0 && r.height <= 0) continue;
      const s = score(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    return bestScore >= 70 ? best : null;
  }

  /**
   * SCORM güvenli ilerleme: yalnız İLERİ gerçekten açıksa tek soft click.
   * Kısayol / DOM zorlama / rastgele hotspot YOK (Anasayfa'ya düşürme).
   */
  function advanceNext() {
    if (isSlideLocked()) return false;
    const now = Date.now();
    if (now - state.lastAdvanceAt < CONFIG.nextCooldownMs) return false;

    const next = findNextControl();
    if (!next || !looksEnabled(next) || isDangerousNav(next)) {
      if (next && !looksEnabled(next) && !state._loggedLocked) {
        state._loggedLocked = true;
        log('İLERİ kilitli — Sıra Sizde/medya bekleniyor.');
      }
      return false;
    }

    state.lastAdvanceAt = now;
    state.advanceFromSlide = getSlideIndex();
    lockSlide(CONFIG.postAdvanceLockMs);
    state.mediaEndedArmed = false;
    state._loggedLocked = false;
    log('İLERİ soft click (güvenli):', controlLabel(next).slice(0, 80));
    const clicked = softClick(next);
    if (clicked) {
      state.nextClicks += 1;
      noteActivity();
    }
    return clicked;
  }

  function isNavChrome(el) {
    if (!el || !el.closest) return false;
    if (el.closest('#nav, #controls, .controls-container, .nav-controls, #control-bar, .control-bar')) {
      return true;
    }
    const id = (el.id || '').toLowerCase();
    return id === 'next' || id === 'prev' || id === 'previous' || id === 'submit';
  }

  function slideIdentity(root) {
    try {
      if (typeof GetPlayer === 'function') {
        const player = GetPlayer();
        const idx = player && typeof player.GetCurrentSlideIndex === 'function'
          ? player.GetCurrentSlideIndex()
          : null;
        if (idx != null && idx !== '') return 'slide:' + idx;
      }
    } catch (_) { /* Storyline API yoksa metin anahtarı */ }
    const attr = root && (root.getAttribute('data-index') || root.getAttribute('data-slide-id'));
    if (attr) return 'dom:' + attr;
    const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return 'text:' + text;
  }

  function passTargetKey(el) {
    return el.getAttribute('data-model-id')
      || el.id
      || controlLabel(el).slice(0, 80);
  }

  /**
   * İLERİ kilitliyken slayt içindeki "tıklayınca geçilen" alanlar.
   * Yalnız yumuşak click. Nav, çıkış, dev video ve tam ekran arka plan yok.
   */
  function passScore(el) {
    if (isDangerousNav(el) || isNavChrome(el)) return -1;
    if (el.closest && el.closest('video, .slide-object-video, .video-container')) return -1;
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) return -1;

    const text = fold(el.innerText);
    const blob = fold(text + ' ' + controlLabel(el));
    if (/geri\b|previous|\bonceki\b|volume|mute|fullscreen|tam ?ekran|\bmenu\b|yardim/.test(blob)) {
      return -1;
    }
    if (/devam etmek icin|ilerlemek icin|tiklayin|tiklayiniz|buraya tik|click to continue|click next|anladim|okudum|baslamak icin/.test(blob)) {
      return 100;
    }
    if (/^(devam|ileri|sonraki|basla|start|continue|next|gec|oynat|play)$/.test(text)) return 90;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'tab' && el.getAttribute('aria-selected') === 'false') return 85;
    if (el.getAttribute && el.getAttribute('aria-expanded') === 'false' && text.length > 0 && text.length <= 80) {
      return 75;
    }
    const interactive = el.classList && (
      el.classList.contains('cursor-hover')
      || el.classList.contains('slide-object-button')
      || el.classList.contains('slide-object-hotspot')
    );
    if (el.matches && el.matches('button.acc-button, [role="button"]') && text.length > 0 && text.length <= 48) {
      return 70;
    }
    if (interactive) return 40;
    return 0;
  }

  function clickPassableScreens() {
    if (isSiraSizdeSlide()) return false;
    if (Date.now() < state.slideLockUntil) return false;
    const now = Date.now();
    if (now - state.lastHotspotAt < CONFIG.hotspotCooldownMs) return false;

    const slide = queryDeep('#slide');
    const layers = queryDeepAll('.slide-layer.shown, #lightbox, .lightbox-wrapper');
    const roots = [slide, ...layers].filter(Boolean);
    const strictOnly = roots.length === 0;
    const searchRoots = roots.length ? roots : [document.body];
    const rootForSize = slide || searchRoots[0];
    const rootRect = rootForSize.getBoundingClientRect();
    const key = slideIdentity(slide || document.body);
    if (key !== state.passSlideKey) {
      state.passSlideKey = key;
      state.passClicked = {};
      state._loggedNoPass = false;
    }

    const seen = new Set();
    const ranked = [];
    searchRoots.forEach((root) => {
      queryDeepAll(
        'button, a, [role="button"], [role="tab"], [aria-expanded="false"], .cursor-hover, .slide-object-button, .slide-object-hotspot',
        root
      ).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (!visible(el) || !looksEnabled(el)) return;
        const score = passScore(el);
        if (score < 40) return;
        if (strictOnly && score < 90) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        const huge = rootRect.width > 0
          && rect.width > rootRect.width * 0.82
          && rect.height > rootRect.height * 0.82;
        if (huge && score < 90) return;
        ranked.push({ el, score });
      });
    });

    const focused = ranked.filter((item) => !ranked.some((other) => (
      other !== item && item.el.contains(other.el) && other.score >= item.score
    )));
    const labeled = focused.filter((item) => item.score >= 90);
    const usable = labeled.length ? labeled : focused;
    if (!usable.length) {
      if (!state._loggedNoPass) {
        state._loggedNoPass = true;
        log('Bu ekranda tıklanacak geçiş alanı yok.');
      }
      return false;
    }

    let pool = usable.filter((item) => !state.passClicked[passTargetKey(item.el)]);
    if (!pool.length) {
      state.passClicked = {};
      state.lastHotspotAt = now;
      return false;
    }
    pool = pool.sort((a, b) => b.score - a.score);
    const bestScore = pool[0].score;
    const same = pool.filter((item) => item.score === bestScore);
    const target = same[0].el;
    state.passClicked[passTargetKey(target)] = true;
    state.lastHotspotAt = now;
    log('Geçiş tıkı:', controlLabel(target).slice(0, 80));
    return softClick(target);
  }

  /**
   * Medya hâlâ oynuyorsa true. İLERİ erken açık olsa bile videoyu izlemeden geçmemek için
   * kullanılır. Döngülü (arka plan) medya sayılmaz; beklemenin üst sınırı vardır.
   */
  function mediaStillPlaying(player, media) {
    if (!media || media.loop) return false;
    const duration = readDuration(player, media);
    if (!duration) return false;
    if (isEnded(player, media) || readTime(player, media) / duration >= CONFIG.endedRatio) return false;
    if (!state.mediaWaitSince) state.mediaWaitSince = Date.now();
    const budget = (duration / currentTargetRate()) * 1000 * 1.5 + CONFIG.mediaWaitExtraMs;
    if (Date.now() - state.mediaWaitSince > budget) {
      if (!state._loggedMediaWaitTimeout) {
        state._loggedMediaWaitTimeout = true;
        warn('Medya beklenen sürede bitmedi — İLERİ bekleme sınırı aşıldı, ilerleniyor.');
      }
      return false;
    }
    return true;
  }

  function resetMediaWait() {
    state.mediaWaitSince = 0;
    state._loggedMediaWait = false;
    state._loggedMediaWaitTimeout = false;
    // Yeni slayt / yeni medya: "Gönder" sayacı da sıfırlanır
    state.gonderCount = 0;
    state._loggedGonderLimit = false;
    state._loggedGonderExam = false;
  }

  function tryAdvanceFromMedia(player, media) {
    if (isSlideLocked()) return;
    const duration = readDuration(player, media);
    const t = readTime(player, media);
    const ended = isEnded(player, media) || (duration > 0 && t / duration >= CONFIG.endedRatio);
    if (!ended) {
      state.mediaEndedArmed = false;
      return;
    }
    // Video.js (CbikoPl) sayfasında Storyline "İLERİ" düğmesi yok; sıradaki ders menüden açılır.
    if (state.mode === 'videojs') {
      advanceVideoJs();
      return;
    }
    const next = findNextControl();
    if (!(next && looksEnabled(next))) {
      if (!state._loggedWaitNext) {
        state._loggedWaitNext = true;
        log('Medya bitti, İLERİ henüz kilitli — açılınca tıklanacak.');
      }
      return;
    }
    if (state.mediaEndedArmed) return;
    state.mediaEndedArmed = true;
    ok('Medya bitti + İLERİ açık — güvenli geçiş...');
    trackTimeout(() => {
      state.mediaEndedArmed = false;
      advanceNext();
    }, CONFIG.postEndedWaitMs);
  }

  function advanceVideoJs() {
    const now = Date.now();
    if (now - state.lastAdvanceAt < CONFIG.nextCooldownMs) return false;
    if (state.nextClicks >= CONFIG.maxNextClicks) return false;
    if (goNextVideoJsMenu()) {
      state.nextClicks += 1;
      noteActivity();
      return true;
    }
    if (!state._loggedVjsEnd) {
      state._loggedVjsEnd = true;
      ok('Video bitti; sıradaki ders bulunamadı — eğitim tamamlanmış olabilir.');
    }
    return false;
  }

  function goNextVideoJsMenu() {
    if (isSlideLocked()) return false;
    const nextRe = /^(sonraki|ileri|sonraki ders|sonraki video|devam|next)$/;
    const softRe = /\bsonraki\b|\bileri\b|next video|next lesson/;
    const textOf = (el) => fold(el.textContent);
    const clickables = Array.from(
      document.querySelectorAll('a, button, [role="button"], .btn, span[onclick], div[onclick]')
    );
    const exact = clickables.find((el) => visible(el) && nextRe.test(textOf(el)));
    const soft = exact || clickables.find((el) => visible(el) && softRe.test(textOf(el)));
    if (soft && looksEnabled(soft) && !isDangerousNav(soft)) {
      state.lastAdvanceAt = Date.now();
      lockSlide(CONFIG.videoJsLockMs);
      log('Video.js sonraki:', (soft.textContent || '').trim().slice(0, 80));
      softClick(soft);
      return true;
    }

    const items = Array.from(
      document.querySelectorAll(
        'a[href*="Video"], a[href*="video"], li a, .list-group-item, [class*="ders"] a, [class*="menu"] a'
      )
    );
    for (const el of items) {
      if (!visible(el)) continue;
      // Gerçek bir adrese gidiyorsa yalnız başka bir UEK oynatıcı adresi olabilir
      // (katalog/ana sayfa/harici bağlantılara tıklama) ve şu anki sayfa olmamalı.
      const href = (el.getAttribute && el.getAttribute('href')) || '';
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
        if (!globalThis.UEKLinks || !UEKLinks.isDirectPlayerUrl(el.href)) continue;
        if (el.href === location.href) continue;
      }
      const cls = String(el.className || '') + ' ' + String(el.parentElement?.className || '');
      const done =
        /completed|tamam|done|success|check/i.test(cls) ||
        el.querySelector('.fa-check, .glyphicon-ok, .text-success, [class*="check"]');
      if (done) continue;
      if (isDangerousNav(el)) continue;
      state.lastAdvanceAt = Date.now();
      lockSlide(CONFIG.videoJsLockMs);
      log('Menüden sonraki ders:', (el.textContent || '').trim().slice(0, 80));
      softClick(el);
      return true;
    }
    return false;
  }

  // --- bind media ---
  // player.on() dinleyicileri stop() ile kaldırılmaz; durdurulmuş betik ilerlemesin.
  function onMediaEnded() {
    if (state.stopped) return;
    ok('Medya "ended" olayı alındı.');
    const { player, media } = resolveBundle();
    tryAdvanceFromMedia(player, media);
  }

  function onMediaPause() {
    if (state.stopped) return;
    const { player, media } = resolveBundle();
    if (!isEnded(player, media) && isPaused(player, media)) {
      log('Duraklatıldı — yeniden başlatılıyor.');
      playSafe(player, media);
      applyPlayback(player, media);
    }
  }

  function bindMedia(player, media) {
    if (media && media !== state.boundMedia) {
      on(media, 'ended', onMediaEnded);
      on(media, 'pause', onMediaPause);
      state.boundMedia = media;
    }
    if (player && player !== state.boundPlayer && typeof player.on === 'function') {
      try {
        player.on('ended', onMediaEnded);
        player.on('pause', onMediaPause);
      } catch (_) { /* ignore */ }
      state.boundPlayer = player;
    }
  }

  function attachPlayer(force) {
    const { player, media } = resolveBundle();
    if (!player && !media) return false;
    if (!force && media && state.boundMedia === media) {
      applyPlayback(player, media);
      return true;
    }
    bindMedia(player, media);
    // Yeni medya: ilerleme/bekleme sayaçlarını sıfırla (eski lastMediaTime yeni medyada
    // "ilerleme yok" sanılmasına yol açıyordu)
    state.lastMediaTime = 0;
    resetMediaWait();
    state._loggedVjsEnd = false;
    applyPlayback(player, media);
    const rate = currentTargetRate();
    const kind = player ? 'Video.js' : media.tagName;
    const dur = readDuration(player, media);
    ok('Oynatıcı bağlandı:', kind, `hız=${rate}x`, 'ses=kapalı', dur ? `süre=${Math.round(dur)}sn` : '');
    return true;
  }

  function lessonRows() {
    return Array.from(document.querySelectorAll(
      'a[href*="Video"], a[href*="video"], li a, .list-group-item, [class*="ders"] a, [class*="menu"] a'
    )).filter((el) => {
      const href = (el.getAttribute && el.getAttribute('href')) || '';
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
        if (!globalThis.UEKLinks || !UEKLinks.isDirectPlayerUrl(el.href)) return false;
      }
      const text = fold(el.innerText || '');
      return text.length > 1 && text.length < 180;
    });
  }

  function lessonMarkedDone(el) {
    const cls = fold(String(el.className || '') + ' ' + String((el.parentElement && el.parentElement.className) || ''));
    if (/tamamland|completed|is-complete/.test(cls)) return true;
    return !!el.querySelector('.fa-check, .glyphicon-ok, .bi-check-circle, .text-success');
  }

  /** Görünür kısa metin: eğitim kabuğu "bitti" diyorsa. Bölüm içi "tebrikler" yetmez. */
  function shellFinished() {
    const nodes = document.querySelectorAll('a, button, input, .btn, span, p, h1, h2, h3, strong, label');
    let again = false;
    let phrase = false;
    let devam = false;
    for (const el of nodes) {
      if (!visible(el)) continue;
      const t = fold(el.innerText || el.value || '');
      if (!t || t.length > 180) continue;
      if (/egitime devam et/.test(t)) devam = true;
      if (/egitime tekrar katil/.test(t)) again = true;
      if (/egitimi basariyla tamamlad|egitim(iniz|i)? tamamlandi|bu egitimi tamamlad/.test(t)) phrase = true;
    }
    if (devam && !again) return false;
    return again || phrase;
  }

  function playbackStillNeeded() {
    const { player, media } = resolveBundle();
    if (!media) return false;
    const t = readTime(player, media);
    const d = readDuration(player, media);
    if (isEnded(player, media)) return false;
    if (d > 0 && t / d >= CONFIG.endedRatio) return false;
    return t > 2 && !isPaused(player, media);
  }

  function finishedReason() {
    if (state.quizPaused) return '';
    // Kabuk "eğitim bitti" diyorsa tekrar oynatma da sekmeyi açık tutmasın.
    if (shellFinished()) return 'tamamlanmis';
    const rows = lessonRows();
    if ((state.mode === 'videojs' || state.mode === 'media') && rows.length >= 2 && rows.every(lessonMarkedDone)) {
      return 'uniteler-bitti';
    }
    if (playbackStillNeeded()) return '';
    if (state.mode === 'videojs' && state._loggedVjsEnd) {
      const { player, media } = resolveBundle();
      const d = readDuration(player, media);
      const ended = isEnded(player, media) || (d > 0 && readTime(player, media) / d >= CONFIG.endedRatio);
      if (ended && !findNextControl()) return 'video-bitti';
    }
    return '';
  }

  function pollFinished() {
    if (state.stopped || state.finishSent) return;
    const now = Date.now();
    if (now - state.finishPollAt < 2000) return;
    state.finishPollAt = now;
    if (now - state.startedAt < 8000) return;
    const reason = finishedReason();
    if (!reason) {
      state.finishReason = '';
      state.finishSince = 0;
      return;
    }
    if (state.finishReason !== reason) {
      state.finishReason = reason;
      state.finishSince = now;
      return;
    }
    if (now - state.finishSince < 4000) return;
    state.finishSent = true;
    ok('Eğitim bitmiş — sekme kapatılıyor.', reason);
    sendToBackground({ type: 'uek-course-finished', reason });
  }

  function isAlreadyPlayerPage() {
    return /\/Egitimler\/(ScormV2|Video)(\/|$)/i.test(location.pathname)
      || !!document.querySelector('#ScoFrame, #CbikoPl, .video-js');
  }

  /**
   * Katalogdan açılan sekme çoğu zaman oynatıcı değil, "Eğitime Başla / Devam Et" kabuğudur.
   * Bu düğme basılmadan video hiç oluşmaz.
   */
  function clickCourseStart() {
    if (window !== window.top || !state.managedTab || state.stopped) return false;
    if (isAlreadyPlayerPage()) return false;
    const now = Date.now();
    if (now - state.lastStartClickAt < 1500) return false;

    const startRe = /egitime basla|egitimi baslat|egitime devam et|egitime katil|izlemeye basla|derse basla|egitime gir/;
    const controls = queryDeepAll('a, button, input[type="button"], input[type="submit"], [role="button"]');
    for (const el of controls) {
      if (!visible(el) || !looksEnabled(el) || isDangerousNav(el)) continue;
      const label = fold(`${controlLabel(el)} ${el.value || ''}`);
      if (!label || label.length > 90 || /tekrar katil/.test(label)) continue;
      if (!startRe.test(label)) continue;
      const href = (el.href || (el.getAttribute && el.getAttribute('href')) || '');
      state.lastStartClickAt = now;
      ok('Eğitim başlatılıyor:', label.slice(0, 80));
      if (href && globalThis.UEKLinks && UEKLinks.isDirectPlayerUrl(href)) {
        location.assign(href);
        return true;
      }
      return softClick(el);
    }

    const links = queryDeepAll('a[href]');
    for (const el of links) {
      const href = el.href || '';
      if (!globalThis.UEKLinks || !UEKLinks.isDirectPlayerUrl(href) || href === location.href) continue;
      if (!visible(el) || isDangerousNav(el)) continue;
      const card = el.closest ? el.closest('li, tr, article, .card, .list-group-item') : null;
      const cardText = fold((card || el).innerText || '');
      if (/tamamland|tekrar katil/.test(cardText) && !/devam et/.test(cardText)) continue;
      if (lessonMarkedDone(el)) continue;
      state.lastStartClickAt = now;
      ok('İlk derse giriliyor.');
      location.assign(href);
      return true;
    }
    return false;
  }

  function tick() {
    muteAll();
    pollFinished();
    if (window === window.top && state.managedTab && !isAlreadyPlayerPage()) {
      clickCourseStart();
    }

    // Parent frame: yalnızca dar kapsamlı "izlemeye devam" modalı
    if (state.mode === 'parent') {
      clickContinueModals();
      return;
    }

    if (Date.now() - state.startedAt > CONFIG.maxRuntimeMs) {
      if (!state.limitLogged) {
        state.limitLogged = true;
        warn('Süre limiti doldu. egitimSavar durdu.');
        stop();
      }
      return;
    }
    if (state.nextClicks >= CONFIG.maxNextClicks) {
      if (!state.limitLogged) {
        state.limitLogged = true;
        warn('İLERİ tıklama limiti doldu. egitimSavar durdu.');
        stop();
      }
      return;
    }

    clickContinueModals();
    updateQuizState();
    releaseAdvanceLockIfSlideChanged();

    if (state.mode === 'scorm' || state.mode === 'media') {
      // Slayt takibi kilit/İLERİ kontrolünden önce: aksi halde hızlı geçişlerde hiç raporlanmıyordu
      const slideKey = String(getSlideIndex() ?? '');
      if (slideKey !== state.activitySlide) {
        if (state.activitySlide && slideKey) {
          ok(`Slayt değişti: ${state.activitySlide} → ${slideKey}`);
        }
        state.activitySlide = slideKey;
        resetMediaWait();
        noteActivity();
      }

      if (isSlideLocked()) return;
      const { player, media } = resolveBundle();
      if (media && media !== state.boundMedia) {
        state.mediaEndedArmed = false;
        state._loggedWaitNext = false;
        state._loggedLocked = false;
        state._siraOptIdx = 0;
        attachPlayer(true);
      }

      // Video içi "Gönder" oynatmayı duraklatır; İLERİ/medya beklemesinden ÖNCE geçilmeli
      if (handleGonder()) {
        noteActivity();
        return;
      }

      const next = findNextControl();
      if (next && looksEnabled(next)) {
        // İLERİ erken açık olabilir; video oynuyorsa bitmesini bekle (videoyu izlemeden geçme)
        if (mediaStillPlaying(player, media)) {
          if (!state._loggedMediaWait) {
            state._loggedMediaWait = true;
            log('İLERİ açık ama medya oynuyor — bitmesi bekleniyor.');
          }
          applyPlayback(player, media);
          if (mediaMoved()) noteActivity();
          return;
        }
        advanceNext();
        return;
      }

      if (mediaMoved()) noteActivity();
      const holdKey = slideKey || 'stuck';
      if (state.heldSlide !== holdKey && Date.now() - state.lastActivityAt > CONFIG.stuckSlideMs) {
        state.heldSlide = holdKey;
        warn('Slayt ilerlemedi. Zorunlu tık durdu; İLERİ açılırsa basılacak.');
      }

      // İLERİ kilitli + Sıra Sizde → seçenek / Kontrol Et. Sekme ve panel önce.
      if (state.heldSlide !== holdKey) {
        if (isSiraSizdeSlide()) {
          if (handleSiraSizde()) noteActivity();
        } else if (clickPassableScreens()) {
          noteActivity();
        }
      }

      if (player || media) {
        applyPlayback(player, media);
        tryAdvanceFromMedia(player, media);
      }
      return;
    }

    if (state.mode === 'videojs') {
      if (isSlideLocked()) return;
      const { player, media } = resolveBundle();
      if (media && media !== state.boundMedia) attachPlayer(true);
      if (handleGonder()) noteActivity();
      if (player || media) {
        if (mediaMoved()) noteActivity();
        applyPlayback(player, media);
        tryAdvanceFromMedia(player, media);
        const big = document.querySelector('.vjs-big-play-button');
        if (big && visible(big) && isPaused(player, media) && !isEnded(player, media)) {
          softClick(big);
        }
      }
      return;
    }
  }

  /** tick içindeki beklenmeyen hata döngüyü ve raporu bozmasın; aynı hata 30 sn'de bir bildirilir. */
  function safeTick() {
    try {
      tick();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const now = Date.now();
      if (msg !== state.lastTickError || now - state.lastTickErrorAt > 30000) {
        state.lastTickError = msg;
        state.lastTickErrorAt = now;
        fail('tick hatası:', msg);
      }
    }
  }

  function startDomWatch() {
    // Storyline animasyonları saniyede yüzlerce class değişimi üretir; ağır işi (muteAll,
    // modal/medya taraması, tick) her mutasyonda değil, en çok 200 ms'de bir yap.
    let queued = false;
    const obs = new MutationObserver(() => {
      if (state.stopped || queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        if (state.stopped) return;
        if (state.mode === 'parent') {
          clickContinueModals();
          return;
        }
        muteAll();
        const { media } = resolveBundle();
        if (media && media !== state.boundMedia) {
          log('DOM değişimi — yeni medya.');
          attachPlayer(true);
        }
        safeTick();
      }, 200);
    });
    const watchRoot = document.documentElement;
    if (!watchRoot) return;
    obs.observe(watchRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-expanded', 'aria-selected', 'hidden'],
    });
    state.observers.push(obs);
  }

  function waitForMedia() {
    let tries = 0;
    const id = trackInterval(() => {
      tries += 1;
      if (attachPlayer(false)) {
        clearInterval(id);
        const i = state.intervals.indexOf(id);
        if (i >= 0) state.intervals.splice(i, 1);
        return;
      }
      if (state.mode === 'scorm' && tries > 5) {
        // medya olmayabilir; hotspot döngüsü yeterli
        clearInterval(id);
        const i = state.intervals.indexOf(id);
        if (i >= 0) state.intervals.splice(i, 1);
        log('SCORM: medya yok veya geç yüklenecek — hotspot/İLERİ döngüsü aktif.');
      }
      if (tries > 50) {
        clearInterval(id);
        const i = state.intervals.indexOf(id);
        if (i >= 0) state.intervals.splice(i, 1);
        if (state.mode !== 'parent') warn('Medya bulunamadı (timeout).');
      }
    }, CONFIG.playerRetryMs);
  }

  /** Rapor sayfasına anlık durum özeti (içerik betiği → arka plan). */
  function sendHeartbeat() {
    if (!shouldReport()) return;
    let data;
    try {
      const { player, media } = resolveBundle();
      data = {
        mode: state.mode,
        url: location.href,
        slide: String(getSlideIndex() ?? ''),
        hasMedia: !!media,
        time: media || player ? readTime(player, media) : 0,
        duration: media || player ? readDuration(player, media) : 0,
        rate: media ? media.playbackRate : 0,
        muted: media ? !!media.muted || media.volume === 0 : null,
        paused: media || player ? isPaused(player, media) : null,
        quiz: state.quizPaused,
        hidden: visibility.hidden,
        pauseBlocked: visibility.pauseBlocked,
        held: !!state.heldSlide,
        idleSec: Math.round((Date.now() - state.lastActivityAt) / 1000),
        nextClicks: state.nextClicks,
        stopped: state.stopped,
      };
    } catch (_) {
      return;
    }
    sendToBackground({ type: 'uek-heartbeat', data });
  }

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    sendHeartbeat();
    if (state.messageListener) {
      try {
        extApi.runtime.onMessage.removeListener(state.messageListener);
      } catch (_) { /* ignore */ }
      state.messageListener = null;
    }
    state.intervals.forEach(clearInterval);
    state.timeouts.forEach(clearTimeout);
    state.observers.forEach((o) => {
      try {
        o.disconnect();
      } catch (_) { /* ignore */ }
    });
    state.listeners.forEach(({ target, type, wrapped, options }) => {
      try {
        target.removeEventListener(type, wrapped, options);
      } catch (_) { /* ignore */ }
    });
    state.intervals = [];
    state.timeouts = [];
    state.observers = [];
    state.listeners = [];
    state.boundMedia = null;
    state.boundPlayer = null;
    log('Durduruldu.', location.href.slice(0, 100));
  }

  // --- boot ---
  state.mode = detectMode();
  let version = '';
  try {
    version = extApi.runtime.getManifest().version;
  } catch (_) { /* ignore */ }
  log('Başlatıldı.', 'v' + version, 'mod=' + state.mode, location.href.slice(0, 120));

  // Eklentiye ait kendi hataları rapora düşsün (sayfa betiklerinin hataları süzülür)
  on(window, 'error', (ev) => {
    const src = String((ev && ev.filename) || '');
    if (!/^(moz|chrome)-extension:/.test(src)) return;
    fail('Betik hatası:', (ev.message || 'bilinmeyen') + ' @' + src.split('/').pop() + ':' + ev.lineno);
  });

  installFocusGuards();
  installMuteHooks();
  muteAll();
  startDomWatch();

  if (state.mode !== 'parent') {
    waitForMedia();
  } else {
    log('Üst frame: modal izleyici aktif; SCORM içeriği iframe content script ile yönetilir.');
  }

  trackInterval(safeTick, CONFIG.pollMs);
  trackInterval(sendHeartbeat, CONFIG.heartbeatMs);
  sendHeartbeat();

  async function detectManagedTab() {
    if (window !== window.top) return;
    for (let i = 0; i < 4; i += 1) {
      if (state.stopped) return;
      try {
        const res = await extApi.runtime.sendMessage({ type: 'uek-am-i-player-window' });
        if (res && res.player) {
          state.managedTab = true;
          clickCourseStart();
          return;
        }
      } catch (_) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // Tüm çerçeveler "durdur" mesajını dinler (konsoldan window.__uekExt.stop() Firefox'ta
  // izole dünya yüzünden sayfa konsolundan çalışmaz; rapor sayfasındaki düğme bunu kullanır).
  state.messageListener = (message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'uek-stop') {
      warn('Kullanıcı isteğiyle durduruldu.');
      stop();
      return undefined;
    }
    if (message.type === 'uek-collect-links' && window === window.top) {
      const links = globalThis.UEKLinks ? UEKLinks.collectFromDocument(document) : [];
      sendResponse({ links });
      return true;
    }
    return undefined;
  };
  extApi.runtime.onMessage.addListener(state.messageListener);

  if (window === window.top) {
    detectManagedTab();
  }

  window.__uekExt = {
    stop,
    getState: () => ({
      mode: state.mode,
      targetRate: currentTargetRate(),
      quizPaused: state.quizPaused,
      hasMedia: !!state.boundMedia,
      nextClicks: state.nextClicks,
      heldSlide: state.heldSlide,
    }),
  };
})();

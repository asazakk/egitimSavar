/**
 * egitimSavar — çekirdek içerik betiği (all_frames)
 * Platformdan bağımsız oynatma, raporlama, odak koruması ve sekme simgesi motoru.
 * Platforma özel davranışlar adapters/uek.js ve adapters/udemy.js üzerinden yüklenir.
 */
(() => {
  'use strict';

  const TAG = '[egitimSavar]';
  const extApi = typeof browser !== 'undefined' ? browser : chrome;
  const adapter = globalThis.EgitimAdapters ? globalThis.EgitimAdapters.resolve(location) : null;
  if (!adapter) return;

  const CONFIG = {
    // Storyline 16x + agresif tık = advanceSlide crash → platform Anasayfa'ya atıyor
    targetRateScorm: 4,
    targetRateVideoJs: 8,
    targetRateUdemy: 4,
    pollMs: 300,
    endedRatio: 0.99,
    nextCooldownMs: 450,
    hotspotCooldownMs: 2500,
    playerRetryMs: 500,
    postAdvanceLockMs: 500,
    // Video.js'te sonraki derse tıklayınca sayfa yenilenir; tekrar tıklamayı önle
    videoJsLockMs: 4000,
    // İLERİ tıklamasından sonra slayt değişmediyse Ctrl+Alt+. için bekleme
    nextKeyDelayMs: 1000,
    // Düğme hiç yoksa kısayoldan önce hotspot denemelerine bırakılan süre
    nextKeyNoButtonMs: 4000,
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
    platform: adapter.id,
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
    playOverlayLogged: false,
    tabIconKey: '',
    iconObserver: null,
    shortcutArmedAt: 0,
    shortcutLoggedAt: 0,
    noNextStamp: '',
    noNextSince: 0,
    messageListener: null,
    intervals: [],
    timeouts: [],
    observers: [],
    listeners: [],
  };

  const fold = (globalThis.EgitimPlatforms && globalThis.EgitimPlatforms.fold) || function fallbackFold(s) {
    return String(s == null ? '' : s)
      .replace(/[İIı]/g, 'i')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  // --- günlük / rapor ---
  function shouldReport() {
    return window === window.top || state.mode !== 'parent';
  }

  function postGuard(kind, extra) {
    try {
      window.postMessage(Object.assign({ __egitimSavar: true, kind }, extra || {}), '*');
    } catch (_) { /* sayfa yok */ }
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
      sendToBackground({ type: 'uek-log', level, text, url: location.href, platform: adapter.id });
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
      document.querySelector('[data-purpose="video-player"] video:not([data-uek-ignore])') ||
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

  /** Açık shadow kökleri dahil. Iframe'ler all_frames ile ayrı dokümanda çalışır. */
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

  function muteAll() {
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
      if (state.mode === 'parent' && adapter.id !== 'uek') return;
      const t = ev.target;
      if (!t || (t.tagName !== 'AUDIO' && t.tagName !== 'VIDEO')) return;
      try {
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
    if (typeof adapter.targetRate === 'function') return adapter.targetRate(state.mode, ctx);
    return CONFIG.targetRateScorm;
  }

  function applyPlayback(player, media) {
    muteAll();
    if (!player && !media) return;
    if (Date.now() < state.slideLockUntil) return;
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

  // --- DOM & kontrol yardımcıları ---
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function looksEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList && (el.classList.contains('disabled') || el.classList.contains('nav-disabled'))) {
      return false;
    }
    const lockHost = el.closest
      ? el.closest('[aria-disabled="true"], .disabled, .nav-disabled, .cs-disabled')
      : null;
    if (lockHost && lockHost !== document.body) return false;
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === 'none') {
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

  function buttonText(el) {
    return fold(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '');
  }

  function isDangerousNav(el) {
    if (!el) return true;
    const label = fold(controlLabel(el));
    const href = (el.getAttribute && (el.getAttribute('href') || '')) || '';
    if (/ana ?sayfa|anasayfa|cikis|cikmak|katalog|home|logout|exit|kapat/.test(label)) return true;
    if (/Anasayfa|AnaSayfa|Giris|Logout|Home/i.test(href)) return true;
    if (typeof adapter.isDangerousNav === 'function' && adapter.isDangerousNav(el, ctx)) return true;
    return false;
  }

  function softClick(el) {
    if (!el || isDangerousNav(el)) return false;
    try {
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function getSlideIndex() {
    return typeof adapter.getSlideIndex === 'function' ? adapter.getSlideIndex(ctx) : null;
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
    state.gonderCount = 0;
    state._loggedGonderLimit = false;
    state._loggedGonderExam = false;
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

  function updateQuizState() {
    const active = typeof adapter.isQuizActive === 'function' ? adapter.isQuizActive(ctx) : false;
    if (active) {
      if (!state.quizLogged) {
        state.quizPaused = true;
        state.quizLogged = true;
        warn(adapter.quizPauseMessage || 'Sınav göründü — cevabı elle verin.');
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
  const visibility = {
    hidden: false,
    guardReady: false,
    pauseBlocked: 0,
    lastPauseLogAt: 0,
    lastGuardTickAt: 0,
    lastBeatAt: 0,
  };

  function resumeAfterVisibility() {
    if (state.mode === 'parent' || state.quizPaused) return;
    const { player, media } = resolveBundle();
    if (!isEnded(player, media)) {
      playSafe(player, media);
      applyPlayback(player, media);
    }
  }

  function onGuardMessage(ev) {
    if (ev.source !== window || !ev.data || ev.data.__egitimSavar !== true) return;
    const d = ev.data;
    if (d.kind === 'ready') {
      visibility.guardReady = true;
    } else if (d.kind === 'tick') {
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
    } else if (d.kind === 'next-key-sent') {
      const now = Date.now();
      if (now - state.shortcutLoggedAt > 15000) {
        state.shortcutLoggedAt = now;
        ok('Ctrl+Alt+. gönderildi — İLERİ kısayolu.');
      }
    } else if (d.kind === 'pause-blocked') {
      visibility.pauseBlocked = d.count;
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
    trackTimeout(() => {
      if (!visibility.guardReady) {
        warn('Sayfa koruması (page-guard) yüklenmedi — arka plan oynatması garanti değil.');
      }
    }, 2500);
  }

  // --- bind media ---
  function onMediaEnded() {
    if (state.stopped || state.mode === 'parent') return;
    ok('Medya "ended" olayı alındı.');
    const { player, media } = resolveBundle();
    if (typeof adapter.onMediaEnded === 'function') {
      adapter.onMediaEnded(ctx, player, media);
    }
  }

  function onMediaPause() {
    if (state.stopped || state.mode === 'parent' || state.quizPaused) return;
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

  function pollFinished() {
    if (state.stopped || state.finishSent) return;
    const now = Date.now();
    if (now - state.finishPollAt < 2000) return;
    state.finishPollAt = now;
    if (now - state.startedAt < 8000) return;
    const reason = typeof adapter.finishedReason === 'function' ? adapter.finishedReason(ctx) : '';
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
    sendToBackground({ type: 'uek-course-finished', reason, platform: adapter.id });
  }

  function refreshMode() {
    const next = adapter.detectMode(ctx);
    if (next === state.mode) return;
    if (next === 'parent' && !adapter.allowParentTransition) return;
    const prev = state.mode;
    state.mode = next;
    if (prev === 'parent' && next !== 'parent') {
      ok('Oynatıcı yüklendi.', `platform=${adapter.id}`, 'mod=' + next);
      waitForMedia();
    } else if (next === 'parent' && prev !== 'parent') {
      state.quizPaused = false;
      state.quizLogged = false;
      state.heldSlide = '';
      state.boundMedia = null;
      state.boundPlayer = null;
      log('Oynatıcıdan çıkıldı.', `platform=${adapter.id}`);
    }
  }

  // Adaptörlere geçilen ortak bağlam
  const ctx = {
    CONFIG,
    state,
    fold,
    visible,
    looksEnabled,
    queryDeep,
    queryDeepAll,
    parentNodeOf,
    controlLabel,
    buttonText,
    isDangerousNav,
    softClick,
    resolveBundle,
    findVideoJsPlayer,
    findHtmlMedia,
    getVideoEl,
    readTime,
    readDuration,
    isPaused,
    isEnded,
    setMuted,
    setRate,
    playSafe,
    muteAll,
    applyPlayback,
    attachPlayer,
    mediaMoved,
    mediaStillPlaying,
    resetMediaWait,
    playbackStillNeeded,
    currentTargetRate,
    isSlideLocked,
    lockSlide,
    noteActivity,
    postGuard,
    trackTimeout,
    log,
    ok,
    warn,
    fail,
  };

  function tick() {
    refreshMode();
    if (state.mode !== 'parent' || adapter.id === 'uek') {
      muteAll();
    }
    pollFinished();
    if (
      window === window.top
      && state.managedTab
      && typeof adapter.isAlreadyPlayerPage === 'function'
      && !adapter.isAlreadyPlayerPage(ctx)
      && typeof adapter.clickCourseStart === 'function'
    ) {
      adapter.clickCourseStart(ctx);
    }

    if (state.mode === 'parent') {
      if (typeof adapter.clickContinueModals === 'function') adapter.clickContinueModals(ctx);
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

    if (typeof adapter.clickContinueModals === 'function') adapter.clickContinueModals(ctx);
    updateQuizState();
    releaseAdvanceLockIfSlideChanged();

    if (typeof adapter.tick === 'function') {
      adapter.tick(ctx);
    }
  }

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
    let queued = false;
    const obs = new MutationObserver(() => {
      if (state.stopped || queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        if (state.stopped) return;
        refreshMode();
        if (state.mode === 'parent') {
          if (typeof adapter.clickContinueModals === 'function') adapter.clickContinueModals(ctx);
          return;
        }
        muteAll();
        const { media } = resolveBundle();
        if (media && media !== state.boundMedia && !state.quizPaused) {
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
      if (state.mode === 'parent' || state.quizPaused) return;
      if (attachPlayer(false)) {
        clearInterval(id);
        const i = state.intervals.indexOf(id);
        if (i >= 0) state.intervals.splice(i, 1);
        return;
      }
      if (state.mode === 'scorm' && tries > 5) {
        clearInterval(id);
        const i = state.intervals.indexOf(id);
        if (i >= 0) state.intervals.splice(i, 1);
        log('SCORM: medya yok veya geç yüklenecek — hotspot/İLERİ döngüsü aktif.');
      }
      if (tries > 50) {
        clearInterval(id);
        const i = state.intervals.indexOf(id);
        if (i >= 0) state.intervals.splice(i, 1);
        if (state.mode !== 'parent' && state.mode !== 'udemy') warn('Medya bulunamadı (timeout).');
      }
    }, CONFIG.playerRetryMs);
  }

  function sendHeartbeat() {
    if (!shouldReport()) return;
    let data;
    try {
      const { player, media } = resolveBundle();
      data = {
        platform: adapter.id,
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

  // Sekme şeridi simgesi. Anahtarlar report-core statusOf ile aynı.
  const TAB_ICON = {
    playing: { bg: '#15803d', glyph: 'play' },
    running: { bg: '#2557d6', glyph: 'dot' },
    paused: { bg: '#d97706', glyph: 'pause' },
    quiz: { bg: '#d97706', glyph: 'quiz' },
    stalled: { bg: '#d93025', glyph: 'bang' },
    nolink: { bg: '#a15c00', glyph: 'off' },
    stopped: { bg: '#4b5563', glyph: 'stop' },
  };
  const tabIconHrefCache = Object.create(null);

  function tabIconHref(key) {
    if (tabIconHrefCache[key]) return tabIconHrefCache[key];
    const spec = TAB_ICON[key];
    if (!spec) return '';
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const g = canvas.getContext('2d');
    if (!g) return '';
    g.fillStyle = spec.bg;
    g.beginPath();
    g.arc(16, 16, 15, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3.2;
    g.lineCap = 'round';
    if (spec.glyph === 'play') {
      g.beginPath();
      g.moveTo(12, 8.5);
      g.lineTo(23.5, 16);
      g.lineTo(12, 23.5);
      g.closePath();
      g.fill();
    } else if (spec.glyph === 'dot') {
      g.beginPath();
      g.arc(16, 16, 5, 0, Math.PI * 2);
      g.fill();
    } else if (spec.glyph === 'pause') {
      g.fillRect(10, 8, 4, 16);
      g.fillRect(18, 8, 4, 16);
    } else if (spec.glyph === 'stop') {
      g.fillRect(10, 10, 12, 12);
    } else if (spec.glyph === 'bang') {
      g.fillRect(14.2, 7, 3.6, 12);
      g.beginPath();
      g.arc(16, 23.2, 2.1, 0, Math.PI * 2);
      g.fill();
    } else if (spec.glyph === 'quiz') {
      g.font = '700 20px Segoe UI, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('?', 16, 17);
    } else if (spec.glyph === 'off') {
      g.beginPath();
      g.moveTo(9.5, 9.5);
      g.lineTo(22.5, 22.5);
      g.moveTo(22.5, 9.5);
      g.lineTo(9.5, 22.5);
      g.stroke();
    }
    tabIconHrefCache[key] = canvas.toDataURL('image/png');
    return tabIconHrefCache[key];
  }

  function iconHrefApplied(head, href) {
    const ours = head.querySelector('link[data-uek-icon]');
    if (!ours || ours.getAttribute('href') !== href) return false;
    const links = head.querySelectorAll('link[rel]');
    for (let i = 0; i < links.length; i += 1) {
      const el = links[i];
      if (el === ours) continue;
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (!/\bicon\b/.test(rel)) continue;
      if (el.getAttribute('href') !== href) return false;
    }
    return true;
  }

  function ensureIconKeeper() {
    if (window !== window.top || state.stopped || state.iconObserver) return;
    const head = document.head;
    if (!head) return;
    state.iconObserver = new MutationObserver(() => {
      if (state.tabIconKey) paintTabIcon(state.tabIconKey);
    });
    state.iconObserver.observe(head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'rel'],
    });
  }

  function releaseIconKeeper() {
    if (!state.iconObserver) return;
    try {
      state.iconObserver.disconnect();
    } catch (_) { /* ignore */ }
    state.iconObserver = null;
  }

  function paintTabIcon(key) {
    if (window !== window.top) return;
    const href = tabIconHref(key);
    if (!href) return;
    state.tabIconKey = key;
    const head = document.head || document.documentElement;
    if (!head) return;
    if (!iconHrefApplied(head, href)) {
      let link = head.querySelector('link[data-uek-icon]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/png';
        link.setAttribute('data-uek-icon', '1');
        head.appendChild(link);
      }
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
      head.querySelectorAll('link[rel]').forEach((el) => {
        if (el === link) return;
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (!/\bicon\b/.test(rel)) return;
        if (el.getAttribute('href') !== href) el.setAttribute('href', href);
      });
    }
    ensureIconKeeper();
  }

  function askTabIcon() {
    if (window !== window.top) return;
    try {
      const p = extApi.runtime.sendMessage({ type: 'uek-tab-icon-query' });
      if (p && typeof p.then === 'function') {
        p.then((res) => {
          if (res && res.key) paintTabIcon(res.key);
        }).catch(() => {});
      }
    } catch (_) { /* eklenti bağlamı yok */ }
  }

  function stop(opts) {
    const keepListener = !!(opts && opts.keepListener);
    postGuard('next-key-cancel');
    if (state.stopped) {
      if (!keepListener && state.messageListener) {
        try {
          extApi.runtime.onMessage.removeListener(state.messageListener);
        } catch (_) { /* ignore */ }
        state.messageListener = null;
      }
      releaseIconKeeper();
      return;
    }
    state.stopped = true;
    if (keepListener && window === window.top) paintTabIcon('stopped');
    sendHeartbeat();
    if (!keepListener && state.messageListener) {
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
    releaseIconKeeper();
    log('Durduruldu.', location.href.slice(0, 100));
  }

  // --- boot ---
  state.mode = adapter.detectMode(ctx);
  let version = '';
  try {
    version = extApi.runtime.getManifest().version;
  } catch (_) { /* ignore */ }
  log('Başlatıldı.', 'v' + version, 'platform=' + adapter.id, 'mod=' + state.mode, location.href.slice(0, 120));

  on(window, 'error', (ev) => {
    const src = String((ev && ev.filename) || '');
    if (!/^(moz|chrome)-extension:/.test(src)) return;
    fail('Betik hatası:', (ev.message || 'bilinmeyen') + ' @' + src.split('/').pop() + ':' + ev.lineno);
  });

  installFocusGuards();
  installMuteHooks();
  if (state.mode !== 'parent' || adapter.id === 'uek') {
    muteAll();
  }
  startDomWatch();

  if (state.mode !== 'parent') {
    waitForMedia();
  } else {
    log('Üst frame: katalog / kabuk izleyici aktif.', `platform=${adapter.id}`);
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
          if (typeof adapter.clickCourseStart === 'function') adapter.clickCourseStart(ctx);
          return;
        }
      } catch (_) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  state.messageListener = (message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'uek-tab-icon' && window === window.top) {
      if (message.key) paintTabIcon(message.key);
      return undefined;
    }
    if (message.type === 'uek-stop') {
      warn('Kullanıcı isteğiyle durduruldu.');
      stop({ keepListener: true });
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
    askTabIcon();
  }

  window.__uekExt = {
    stop,
    getState: () => ({
      platform: adapter.id,
      mode: state.mode,
      targetRate: currentTargetRate(),
      quizPaused: state.quizPaused,
      hasMedia: !!state.boundMedia,
      nextClicks: state.nextClicks,
      heldSlide: state.heldSlide,
    }),
  };
})();

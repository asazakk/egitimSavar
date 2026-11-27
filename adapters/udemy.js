/**
 * egitimSavar — Udemy & Udemy Business (*.udemy.com) adaptörü.
 * React SPA ders oynatıcısı, video hızlandırma/sessiz oynatma, interstitial/sonraki ders geçişi,
 * makale dersleri, değerlendirme penceresi kapatma, sınav/quiz duraklatma ve %100 tamamlama takibi.
 */
(function (root) {
  'use strict';

  const UDEMY_LEARN_RE = /^\/course\/(?!draft(?:\/|$))[^/]+\/learn(\/|$)/i;
  const UDEMY_ITEM_RE = /\/learn\/(lecture|quiz|practice|coding-exercise)\/(\d+)/i;
  const UDEMY_QUIZ_URL_RE = /\/learn\/(quiz|practice|coding-exercise)(\/|$)/i;

  const ARTICLE_WAIT_MS = 5000;
  const ARTICLE_DONE_WAIT_MS = 1500;
  const UNKNOWN_NON_VIDEO_WAIT_MS = 10000;
  const POST_VIDEO_END_WAIT_MS = 1200;
  const PLAY_OVERLAY_COOLDOWN_MS = 1500;
  const ADVANCE_LOCK_MS = 2500;

  function ensureState(ctx) {
    if (!ctx.state.udemy) {
      ctx.state.udemy = {
        articleSince: 0,
        articleScrolled: false,
        videoEndedAt: 0,
        lastPlayOverlayAt: 0,
        noNextLogged: false,
        lastRatingDismissAt: 0,
      };
    }
    return ctx.state.udemy;
  }

  function resetLectureState(ctx) {
    const u = ensureState(ctx);
    u.articleSince = 0;
    u.articleScrolled = false;
    u.videoEndedAt = 0;
    u.noNextLogged = false;
  }

  function detectMode() {
    // Udemy kurs oynatıcısı üst çerçevede (SPA) çalışır; harici iframe'lere dokunma
    if (window !== window.top) return 'parent';
    if (UDEMY_LEARN_RE.test(location.pathname)) return 'udemy';
    return 'parent';
  }

  function targetRate(_mode, ctx) {
    return ctx.CONFIG.targetRateUdemy || 4;
  }

  function isAlreadyPlayerPage() {
    return UDEMY_LEARN_RE.test(location.pathname);
  }

  function getSlideIndex(ctx) {
    const m = location.pathname.match(UDEMY_ITEM_RE);
    if (m) return `${m[1].toLowerCase()}:${m[2]}`;
    const currentTitle = document.querySelector(
      'li[class*="curriculum-item-link--is-current"] [data-purpose="item-title"], [aria-current="true"] [data-purpose="item-title"]'
    );
    if (currentTitle && currentTitle.textContent) {
      return ctx.fold(currentTitle.textContent).slice(0, 60);
    }
    return UDEMY_LEARN_RE.test(location.pathname) ? location.pathname : null;
  }

  function isDangerousNav(el, ctx) {
    if (!el) return true;
    const label = ctx.fold(ctx.controlLabel(el));
    const href = (el.getAttribute && (el.getAttribute('href') || '')) || '';
    if (/unenroll|archive|refund|report|sign ?out|log ?out|leave course|my learning|wishlist|shopping|cart|gift|kursa kaydi sil|arsivle|iade|oturumu kapat|sepet/.test(label)) {
      return true;
    }
    if (/\/logout|\/user\/logout|\/cart|\/home\/my-courses/i.test(href)) return true;
    return false;
  }

  function isQuizActive(ctx) {
    if (ctx.state.mode !== 'udemy') return false;
    if (UDEMY_QUIZ_URL_RE.test(location.pathname)) return true;
    const quizSelectors = [
      '[class*="compact-quiz-container"]',
      '[class*="quiz-view--container"]',
      '[data-purpose="quiz-page"]',
      '[data-purpose="practice-test"]',
      '[data-purpose="coding-exercise"]',
      '#question-prompt',
      'button[data-purpose="next-question-button"]',
      'button[data-purpose="start-quiz-button"]',
    ].join(', ');
    const hit = document.querySelector(quizSelectors);
    return !!(hit && ctx.visible(hit));
  }

  /**
   * Udemy oynatıcısı fare hareketsizken #go-to-next-item ve [data-purpose="go-to-next"]
   * düğmelerini opacity: 0 ile gizler; görünürlük kontrolünde opacity: 0 reddedilmemelidir.
   */
  function isActionableEvenIfFaded(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList && (el.classList.contains('disabled') || el.classList.contains('ud-btn-disabled'))) {
      return false;
    }
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch (_) { /* ignore */ }
    return true;
  }

  function findInterstitialNext(ctx) {
    const selectors = [
      '[data-purpose="video-interstitial-play-button"]',
      '[class*="interstitial"] [data-purpose="go-to-next"]',
      '[class*="interstitial"] button[aria-label*="Play" i]',
      '[class*="interstitial"] button[aria-label*="Next" i]',
      '[class*="interstitial"] button[aria-label*="Continue" i]',
      '[class*="interstitial"] button[aria-label*="Sonraki" i]',
      '[class*="interstitial"] button[aria-label*="Devam" i]',
      '[class*="up-next"] button',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el || !ctx.visible(el) || !ctx.looksEnabled(el)) continue;
      const lbl = ctx.fold(ctx.controlLabel(el));
      if (/cancel|iptal|close|kapat|pause|duraklat|replay|tekrar/.test(lbl)) continue;
      if (ctx.isDangerousNav(el)) continue;
      return el;
    }
    return null;
  }

  function findNextControl(ctx) {
    const interstitial = findInterstitialNext(ctx);
    if (interstitial) return interstitial;

    const directSelectors = [
      '#go-to-next-item',
      '[data-purpose="go-to-next"]',
      'a[data-purpose="go-to-next"].item-link',
      'button[data-purpose="go-to-next"]',
      'button[aria-label*="Next lecture" i]',
      'a[aria-label*="Next lecture" i]',
      'button[aria-label*="Sonraki ders" i]',
      'a[aria-label*="Sonraki ders" i]',
    ];
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (!el || !isActionableEvenIfFaded(el)) continue;
      const lbl = ctx.fold(ctx.controlLabel(el));
      if (/previous|prev|onceki|geri/.test(lbl) && !/next|sonraki|ileri/.test(lbl)) continue;
      if (ctx.isDangerousNav(el)) continue;
      return el;
    }

    // Yedek: yan müfredat listesinde aktif dersten hemen sonraki öğe
    const currentLi = document.querySelector(
      'li[class*="curriculum-item-link--is-current"], li[aria-current="true"]'
    );
    if (currentLi) {
      const items = Array.from(document.querySelectorAll('[data-purpose^="curriculum-item-"]'));
      const curItem = currentLi.querySelector('[data-purpose^="curriculum-item-"]') || currentLi;
      const idx = items.indexOf(curItem);
      if (idx >= 0 && idx + 1 < items.length) {
        const nextItem = items[idx + 1];
        const target = nextItem.querySelector('a, button, [role="button"]') || nextItem;
        if (target && isActionableEvenIfFaded(target) && !ctx.isDangerousNav(target)) {
          return target;
        }
      }
    }
    return null;
  }

  function advanceUdemy(ctx, reason) {
    const { state, CONFIG } = ctx;
    if (ctx.isSlideLocked()) return false;
    const now = Date.now();
    if (now - state.lastAdvanceAt < CONFIG.nextCooldownMs) return false;
    if (state.nextClicks >= CONFIG.maxNextClicks) return false;

    const next = findNextControl(ctx);
    if (!next) return false;

    state.lastAdvanceAt = now;
    state.advanceFromSlide = getSlideIndex(ctx);
    ctx.lockSlide(ADVANCE_LOCK_MS);
    state.mediaEndedArmed = false;
    ctx.ok(
      reason ? `Udemy sonraki ders (${reason}):` : 'Udemy sonraki ders:',
      (next.getAttribute('aria-label') || next.textContent || next.id || 'go-to-next').trim().slice(0, 80)
    );
    const clicked = ctx.softClick(next);
    if (clicked) {
      state.nextClicks += 1;
      ctx.noteActivity();
    }
    return clicked;
  }

  function dismissRatingModal(ctx) {
    const u = ensureState(ctx);
    const now = Date.now();
    if (now - u.lastRatingDismissAt < 2500) return false;

    const dialogs = document.querySelectorAll(
      '[role="dialog"], [class*="modal--dialog"], [data-purpose="rating-modal"]'
    );
    for (const dlg of dialogs) {
      if (!ctx.visible(dlg)) continue;
      const text = ctx.fold(dlg.textContent || '');
      const isRating = /how would you rate|leave a rating|rate this course|bu kursu nasil degerlendir|degerlendirme birak|puan ver/.test(text);
      if (!isRating) continue;

      const buttons = Array.from(dlg.querySelectorAll('button, a, [role="button"]'));
      const later = buttons.find((b) => {
        if (!ctx.visible(b) || b.disabled) return false;
        const lbl = ctx.fold(ctx.buttonText(b));
        return /ask me later|not now|maybe later|skip|daha sonra|simdi degil|atla|kapat|close/.test(lbl);
      });
      const closeBtn = later
        || dlg.querySelector('button[data-purpose="close-popup"], button[aria-label*="Close" i], button[aria-label*="Kapat" i]');
      if (closeBtn && !closeBtn.disabled) {
        u.lastRatingDismissAt = now;
        ctx.ok('Udemy değerlendirme penceresi kapatıldı.');
        ctx.softClick(closeBtn);
        return true;
      }
    }
    return false;
  }

  function clickContinueModals(ctx) {
    if (dismissRatingModal(ctx)) return true;

    const { state, CONFIG } = ctx;
    const now = Date.now();
    if (now - state.lastModalAt < CONFIG.modalClickCooldownMs) return false;
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal--dialog"]');
    for (const dlg of dialogs) {
      if (!ctx.visible(dlg)) continue;
      if (isQuizActive(ctx)) continue;
      const text = ctx.fold(dlg.textContent || '');
      const isContinue = [
        'are you still watching',
        'continue watching',
        'izlemeye devam',
        'hala izliyor',
        'devam etmek istiyor',
      ].some((k) => text.includes(k));
      if (!isContinue) continue;
      if (/log ?out|sign ?out|cikis|oturumu kapat|delete|unenroll/.test(text)) continue;
      const btn = Array.from(dlg.querySelectorAll('button, [role="button"]')).find((b) => (
        ctx.visible(b) && !b.disabled && /\b(continue|resume|yes|ok|devam|tamam|evet)\b/.test(ctx.fold(ctx.buttonText(b)))
      ));
      if (btn) {
        state.lastModalAt = now;
        ctx.ok('Udemy "İzlemeye devam" onayı tıklandı.');
        ctx.softClick(btn);
        return true;
      }
    }
    return false;
  }

  function clickPlayOverlay(ctx) {
    const u = ensureState(ctx);
    const now = Date.now();
    if (now - u.lastPlayOverlayAt < PLAY_OVERLAY_COOLDOWN_MS) return false;
    if (isQuizActive(ctx)) return false;

    const selectors = [
      '[data-purpose="video-play-button-initial"]',
      '.vjs-big-play-button',
      'button[data-purpose="play-button"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el || !ctx.visible(el) || !ctx.looksEnabled(el)) continue;
      u.lastPlayOverlayAt = now;
      if (!ctx.state.playOverlayLogged) {
        ctx.state.playOverlayLogged = true;
        ctx.ok('Udemy oynat düğmesine basıldı.');
      }
      return ctx.softClick(el);
    }
    return false;
  }

  function clickCourseStart(ctx) {
    const { state } = ctx;
    if (window !== window.top || !state.managedTab || state.stopped) return false;
    if (isAlreadyPlayerPage()) return false;
    const now = Date.now();
    if (now - state.lastStartClickAt < 1200) return false;

    // 1) Doğrudan Udemy CTA düğmeleri
    const direct = document.querySelector(
      '[data-purpose="go-to-course-button"], [data-purpose="course-cta"] a[href*="/learn"], a[data-purpose="go-to-course-button"]'
    );
    if (direct && ctx.visible(direct) && ctx.looksEnabled(direct) && !ctx.isDangerousNav(direct)) {
      state.lastStartClickAt = now;
      ctx.ok('Udemy kursuna giriliyor:', ctx.buttonText(direct) || 'go-to-course');
      ctx.softClick(direct);
      return true;
    }

    // 2) Metinle eşleşen kursa giriş düğmesi
    const startRe = /^(go to course|start course|continue to lecture|continue course|resume course|kursa git|kursa basla|egitime basla|egitime devam et|derse devam et)$/;
    const controls = ctx.queryDeepAll('a, button, [role="button"]');
    for (const el of controls) {
      if (!ctx.visible(el) || !ctx.looksEnabled(el) || ctx.isDangerousNav(el)) continue;
      const label = ctx.buttonText(el);
      if (!startRe.test(label)) continue;
      state.lastStartClickAt = now;
      ctx.ok('Udemy kursuna giriliyor:', label);
      ctx.softClick(el);
      return true;
    }

    // 3) Aynı kursun /learn/ bağlantısı tekse doğrudan git
    const slugMatch = location.pathname.match(/^\/course\/([^/]+)\/?$/i);
    if (slugMatch) {
      const slug = slugMatch[1].toLowerCase();
      const learnLinks = Array.from(document.querySelectorAll('a[href*="/learn"]')).filter((a) => {
        try {
          const u = new URL(a.href, location.href);
          return u.pathname.toLowerCase().startsWith(`/course/${slug}/learn`);
        } catch (_) {
          return false;
        }
      });
      if (learnLinks.length >= 1) {
        state.lastStartClickAt = now;
        ctx.ok('Udemy oynatıcı adresine yönlendiriliyor.');
        location.assign(learnLinks[0].href);
        return true;
      }
    }
    return false;
  }

  function parseCourseProgress(ctx) {
    const selectors = [
      '[data-purpose="progress-popover-text"]',
      '[data-purpose="progress-button"]',
      '[data-purpose="course-progress"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = ctx.fold(el.textContent || el.getAttribute('aria-label') || '');
      const ratio = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
      if (ratio) {
        const done = Number(ratio[1]);
        const total = Number(ratio[2]);
        if (total > 0) return { done, total, complete: done >= total };
      }
      if (/\b100%\s*(complete|completed|tamamland)?\b/.test(text)) {
        return { done: 100, total: 100, complete: true };
      }
    }
    return null;
  }

  function hasCompletionBanner(ctx) {
    const nodes = document.querySelectorAll(
      '[role="dialog"], [data-purpose*="congrats"], [class*="congrats"], [class*="course-completion"], h1, h2, h3'
    );
    for (const el of nodes) {
      if (!ctx.visible(el)) continue;
      const text = ctx.fold(el.textContent || '');
      if (!text || text.length > 260) continue;
      if (/you completed this course|course completed|congratulations.*completed|bu kursu tamamladiniz|kursu basariyla tamamladiniz/.test(text)) {
        return true;
      }
    }
    return false;
  }

  function finishedReason(ctx) {
    const { state } = ctx;
    if (state.mode !== 'udemy') return '';
    if (state.quizPaused) return '';

    const progress = parseCourseProgress(ctx);
    if (progress && progress.complete) return 'tamamlanmis';

    if (ctx.playbackStillNeeded()) return '';

    const hasNext = !!findNextControl(ctx);
    if (!hasNext && hasCompletionBanner(ctx)) return 'tamamlanmis';

    const u = ensureState(ctx);
    if (!hasNext && u.videoEndedAt && Date.now() - u.videoEndedAt >= 5000) {
      return 'video-bitti';
    }
    return '';
  }

  function currentLectureMarkedDone() {
    const box = document.querySelector(
      'li[class*="curriculum-item-link--is-current"] input[data-purpose="progress-toggle-button"], li[aria-current="true"] input[data-purpose="progress-toggle-button"]'
    );
    return !!(box && box.checked);
  }

  function hasVideoContainer() {
    return !!document.querySelector('[data-purpose="video-player"], [data-purpose="video-mashup"], .video-js');
  }

  function findArticleContainer() {
    return document.querySelector(
      '[data-purpose="article-asset"], [class*="article-asset--content"], [data-purpose="text-viewer"]'
    );
  }

  function onMediaEnded(ctx, player, media) {
    const { state, CONFIG } = ctx;
    if (state.mode !== 'udemy' || state.quizPaused) return;
    if (ctx.isSlideLocked()) return;
    const u = ensureState(ctx);
    const duration = ctx.readDuration(player, media);
    const t = ctx.readTime(player, media);
    const ended = ctx.isEnded(player, media) || (duration > 0 && t / duration >= CONFIG.endedRatio);
    if (!ended) {
      state.mediaEndedArmed = false;
      u.videoEndedAt = 0;
      return;
    }
    if (!u.videoEndedAt) u.videoEndedAt = Date.now();
    if (state.mediaEndedArmed) return;

    // Interstitial ekranı zaten açıldıysa hemen geç, değilse tamamlama sinyali için kısa bekle
    const delay = findInterstitialNext(ctx) ? 250 : POST_VIDEO_END_WAIT_MS;
    state.mediaEndedArmed = true;
    ctx.ok('Udemy video bitti — sıradaki derse geçiliyor...');
    ctx.trackTimeout(() => {
      state.mediaEndedArmed = false;
      if (state.stopped || state.quizPaused) return;
      if (!advanceUdemy(ctx, 'video-bitti') && !u.noNextLogged) {
        u.noNextLogged = true;
        ctx.ok('Video bitti; sıradaki ders bulunamadı — kurs tamamlanmış olabilir.');
      }
    }, delay);
  }

  function tick(ctx) {
    const { state, CONFIG } = ctx;
    if (state.mode !== 'udemy') return;
    const u = ensureState(ctx);

    // SPA ders değişimi takibi
    const slideKey = String(getSlideIndex(ctx) ?? '');
    if (slideKey !== state.activitySlide) {
      if (state.activitySlide && slideKey) {
        ctx.ok(`Ders değişti: ${state.activitySlide} → ${slideKey}`);
      }
      state.activitySlide = slideKey;
      state.lastMediaTime = 0;
      state.mediaEndedArmed = false;
      state.playOverlayLogged = false;
      ctx.resetMediaWait();
      resetLectureState(ctx);
      ctx.noteActivity();
    }

    // Sınav / quiz / kodlama alıştırması varsa kullanıcıya bırak
    if (state.quizPaused) return;
    if (ctx.isSlideLocked()) return;

    // Video bitip interstitial çıktıysa doğrudan sonraki derse geç
    const interstitial = findInterstitialNext(ctx);
    if (interstitial) {
      advanceUdemy(ctx, 'interstitial');
      return;
    }

    const { player, media } = ctx.resolveBundle();
    if (media) {
      u.articleSince = 0;
      if (media !== state.boundMedia) {
        ctx.attachPlayer(true);
      }
      const duration = ctx.readDuration(player, media);
      const t = ctx.readTime(player, media);
      const ended = ctx.isEnded(player, media) || (duration > 0 && t / duration >= CONFIG.endedRatio);

      if (ended) {
        if (!u.videoEndedAt) u.videoEndedAt = Date.now();
        if (Date.now() - u.videoEndedAt >= POST_VIDEO_END_WAIT_MS) {
          if (!advanceUdemy(ctx, 'video-bitti') && !u.noNextLogged) {
            u.noNextLogged = true;
            ctx.ok('Video bitti; sıradaki ders bulunamadı — kurs tamamlanmış olabilir.');
          }
        }
        return;
      }

      u.videoEndedAt = 0;
      u.noNextLogged = false;
      if (ctx.mediaMoved()) ctx.noteActivity();
      ctx.applyPlayback(player, media);
      if (ctx.isPaused(player, media)) {
        clickPlayOverlay(ctx);
      }
      return;
    }

    // Video henüz yükleniyorsa bekle (video container var ama <video> DOM'a daha girmedi)
    if (hasVideoContainer()) {
      u.articleSince = 0;
      clickPlayOverlay(ctx);
      return;
    }

    // Makale / kaynak dersi (/learn/lecture/ altında video olmadan)
    if (/\/learn\/lecture\//i.test(location.pathname)) {
      const now = Date.now();
      if (!u.articleSince) {
        u.articleSince = now;
        u.articleScrolled = false;
      }
      const articleEl = findArticleContainer();
      const elapsed = now - u.articleSince;
      if (articleEl && !u.articleScrolled && elapsed >= 1500) {
        u.articleScrolled = true;
        try {
          articleEl.scrollTop = articleEl.scrollHeight || 0;
        } catch (_) { /* ignore */ }
      }
      const needed = currentLectureMarkedDone()
        ? ARTICLE_DONE_WAIT_MS
        : (articleEl ? ARTICLE_WAIT_MS : UNKNOWN_NON_VIDEO_WAIT_MS);
      if (elapsed >= needed) {
        if (!advanceUdemy(ctx, articleEl ? 'makale' : 'medyasiz-ders') && !u.noNextLogged) {
          u.noNextLogged = true;
          ctx.ok('Ders tamamlandı; sıradaki ders bulunamadı — kurs tamamlanmış olabilir.');
        }
      }
    }
  }

  if (root.EgitimAdapters) {
    root.EgitimAdapters.register({
      id: 'udemy',
      name: 'Udemy',
      allowParentTransition: true,
      matches(loc) {
        return /(?:^|\.)udemy\.com$/i.test(loc.hostname);
      },
      detectMode,
      targetRate,
      getSlideIndex,
      isDangerousNav,
      isQuizActive,
      quizPauseMessage: 'Udemy sınav/quiz/alıştırma göründü — cevabı elle verin; bitince devam edilecek.',
      isAlreadyPlayerPage,
      clickCourseStart,
      clickContinueModals,
      clickPlayOverlay,
      onMediaEnded,
      tick,
      finishedReason,
    });
  }
})(globalThis);

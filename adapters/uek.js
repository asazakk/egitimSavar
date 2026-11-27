/**
 * egitimSavar — Uzaktan Eğitim Kapısı (UEK / CBİKO) adaptörü.
 * ScormV2 (Articulate Storyline / vod3) + Video.js (CbikoPl) destekler.
 * Mevcut UEK davranışının tamamı birebir korunur.
 */
(function (root) {
  'use strict';

  const GONDER_RE = /^((cevabi|yaniti) )?gonder$|^submit$|^send$/;

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

  function targetRate(mode, ctx) {
    return mode === 'videojs' ? ctx.CONFIG.targetRateVideoJs : ctx.CONFIG.targetRateScorm;
  }

  function getSlideIndex(ctx) {
    try {
      if (typeof GetPlayer === 'function') {
        const player = GetPlayer();
        if (player && typeof player.GetCurrentSlideIndex === 'function') {
          return player.GetCurrentSlideIndex();
        }
      }
    } catch (_) { /* ignore */ }
    const rootEl = ctx.queryDeep('#slide');
    if (rootEl) {
      return rootEl.getAttribute('data-index') || rootEl.getAttribute('data-slide-id') || null;
    }
    return null;
  }

  // --- quiz / modal ---
  function isQuizLike(ctx, rootEl) {
    if (!rootEl) return false;
    if (rootEl.querySelector('input[type="radio"], input[type="checkbox"], textarea, select')) {
      return true;
    }
    const text = ctx.fold(rootEl.textContent || '');
    const hints = ['soru', 'sik', 'sinav', 'cevap', 'sira sizde'];
    return hints.filter((h) => text.includes(h)).length >= 2;
  }

  function pageHasQuiz(ctx) {
    if (ctx.state.mode === 'parent') return false;
    // Sıra Sizde artık otomatik çözülür; burada sadece gerçek sınav formu
    const bodyText = ctx.fold((document.body && document.body.innerText) || '');
    if (/sira sizde/.test(bodyText)) return false;
    if (!/soru ?\d|sinav/.test(bodyText)) return false;
    return !!document.querySelector('input[type="radio"], input[type="checkbox"], textarea');
  }

  function isQuizActive(ctx) {
    return pageHasQuiz(ctx)
      || [...document.querySelectorAll('.swal-modal, .swal2-popup, [role="dialog"]')].some((el) => isQuizLike(ctx, el));
  }

  function isSiraSizdeSlide(ctx) {
    const text = ctx.fold((document.body && document.body.innerText) || '');
    if (/sira sizde/.test(text)) return true;
    return !!ctx.queryDeep(
      '[data-acc-text*="Sıra Sizde" i], [data-acc-text*="Sira Sizde" i], .acc-checkbox'
    );
  }

  function isShownSlideObject(ctx, el) {
    if (!el || !el.classList) return ctx.visible(el);
    if (el.classList.contains('hidden')) return false;
    return el.classList.contains('shown') || ctx.visible(el);
  }

  /** Storyline seçimi çoğu zaman checkbox.checked değil; görsel state ile gelir */
  function countVisualSelections(ctx) {
    return ctx.queryDeepAll(
      '.slide-object.shown[data-acc-text*="coklu_secim_secim"], .slide-object.shown[data-acc-text*="coklu_secim_dogru"], [data-acc-text*="coklu_secim_secim"].shown'
    ).length;
  }

  function findKontrolEt(ctx) {
    const nodes = ctx.queryDeepAll(
      'button.acc-button, .slide-object.shown[data-acc-text], .slide-object.shown, button'
    );
    return nodes.find((el) => {
      const label = ctx.fold(ctx.controlLabel(el));
      const acc = ctx.fold(el.getAttribute('data-acc-text') || '');
      if (!/kontrol ?et/.test(label) && !/kontrol ?et/.test(acc)) return false;
      if (el.classList && el.classList.contains('hidden')) return false;
      if (/pasif/.test(ctx.fold(String(el.className)) + ' ' + acc)) return false;
      return isShownSlideObject(ctx, el) || ctx.visible(el);
    });
  }

  /**
   * Sıra Sizde: seçenek işaretle → Kontrol Et → (gerekirse) Doğru Cevabı Gör
   * İLERİ ancak bundan sonra açılıyor.
   */
  function handleSiraSizde(ctx) {
    const { state, CONFIG } = ctx;
    if (Date.now() < state.slideLockUntil) return false;
    const now = Date.now();
    if (now - state.lastSiraAt < CONFIG.siraSizdeCooldownMs) return false;

    // 1) Doğru Cevabı Gör
    const reveal = Array.from(
      ctx.queryDeepAll('button.acc-button, .slide-object, [data-acc-text], button')
    ).find((el) => (
      /dogru ?cevabi ?gor/.test(ctx.fold(ctx.controlLabel(el))) && isShownSlideObject(ctx, el)
    ));
    if (reveal && !ctx.isDangerousNav(reveal)) {
      state.lastSiraAt = now;
      ctx.log('Sıra Sizde: Doğru Cevabı Gör');
      ctx.softClick(reveal);
      return true;
    }

    const visualSel = countVisualSelections(ctx);
    const boxes = ctx.queryDeepAll('input.acc-checkbox, input[type="checkbox"]');
    const checkedBoxes = boxes.filter((el) => el.checked).length;
    const hasSelection = visualSel > 0 || checkedBoxes > 0;

    // 2) Seçim varsa önce Kontrol Et (checkbox.checked Storyline'da çoğu zaman false kalıyor)
    const kontrol = findKontrolEt(ctx);
    if (hasSelection && kontrol && !ctx.isDangerousNav(kontrol)) {
      state.lastSiraAt = now;
      ctx.log('Sıra Sizde: Kontrol Et (seçim=', visualSel || checkedBoxes, ')');
      ctx.softClick(kontrol);
      const accKontrol = ctx.queryDeepAll('button.acc-button').find((el) => (
        /^kontrol ?et$/.test(ctx.fold(el.textContent))
      ));
      if (accKontrol) ctx.softClick(accKontrol);
      return true;
    }

    // 3) Seçim yoksa seçeneklere tıkla (görsel state group / metin)
    const optionEls = Array.from(
      ctx.queryDeepAll(
        '.slide-object.shown.cursor-hover, .slide-object.shown.slide-object-stategroup, .slide-object.shown[data-acc-text], button.acc-button'
      )
    ).filter((el) => {
      if (ctx.isDangerousNav(el)) return false;
      const label = ctx.controlLabel(el).trim();
      if (!label || label.length < 10) return false;
      if (/kontrol ?et|ileri|geri|next|previous|rectangle|coklu_secim|png|group|casgem|asset|sira ?sizde|tekrar ?dene|dogru ?cevab|image ?\d/.test(ctx.fold(label))) {
        return false;
      }
      return isShownSlideObject(ctx, el);
    });

    // Checkbox'lara da bas (Storyline bazen bunları dinler)
    const unchecked = boxes.filter((el) => !el.checked);
    if (!hasSelection && unchecked.length) {
      state.lastSiraAt = now;
      const box = unchecked[Math.min(state._siraOptIdx || 0, unchecked.length - 1)];
      state._siraOptIdx = (state._siraOptIdx || 0) + 1;
      ctx.log('Sıra Sizde: checkbox tık', box.id || '');
      try {
        box.click();
      } catch (_) {
        ctx.softClick(box);
      }
      return true;
    }

    if (!hasSelection && optionEls.length) {
      state.lastSiraAt = now;
      const idx = (state._siraOptIdx || 0) % optionEls.length;
      state._siraOptIdx = idx + 1;
      ctx.log('Sıra Sizde: seçenek tık', ctx.controlLabel(optionEls[idx]).slice(0, 70));
      ctx.softClick(optionEls[idx]);
      return true;
    }

    if (!hasSelection && optionEls.length === 0) {
      ctx.log('Sıra Sizde: seçenek DOM bulunamadı');
    }
    if (hasSelection && !kontrol) {
      state.lastSiraAt = now;
      ctx.log('Sıra Sizde: Kontrol Et bulunamadı, acc-button aranıyor');
      const accKontrol = ctx.queryDeepAll('button.acc-button').find((el) => (
        /kontrol ?et/.test(ctx.fold(el.textContent))
      ));
      if (accKontrol) {
        ctx.softClick(accKontrol);
        return true;
      }
    }

    return false;
  }

  // --- "Gönder" (video içi soru / anket) ---
  function gonderLabel(ctx, el) {
    const raw = (el.tagName === 'INPUT' ? el.value : '')
      || el.getAttribute('aria-label')
      || el.getAttribute('data-acc-text')
      || el.textContent
      || '';
    return ctx.fold(raw);
  }

  function findGonder(ctx) {
    const nodes = ctx.queryDeepAll(
      'button, a, input[type="submit"], input[type="button"], [role="button"], .acc-button, [data-acc-text]'
    );
    const hits = nodes.filter((el) => {
      const label = gonderLabel(ctx, el);
      if (label.length > 24 || !GONDER_RE.test(label)) return false;
      if (ctx.isDangerousNav(el)) return false;
      return isShownSlideObject(ctx, el);
    });
    const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    return inner[0] || null;
  }

  function isGonderDisabled(ctx, el) {
    if (!ctx.looksEnabled(el)) return true;
    return /pasif|disabled/.test(ctx.fold(`${el.className} ${el.getAttribute('data-acc-text') || ''}`));
  }

  function pickAnyOption(ctx) {
    const { state } = ctx;
    const inputs = ctx.queryDeepAll('input[type="radio"], input[type="checkbox"]')
      .filter((el) => !el.disabled && !el.checked);
    if (inputs.length) {
      const idx = (state._gonderOptIdx || 0) % inputs.length;
      state._gonderOptIdx = idx + 1;
      ctx.log('Gönder pasif — seçenek işaretleniyor (input).');
      try {
        inputs[idx].click();
      } catch (_) {
        ctx.softClick(inputs[idx]);
      }
      return true;
    }
    const options = ctx.queryDeepAll(
      '.slide-object.shown.cursor-hover, .slide-object.shown.slide-object-stategroup, .slide-object.shown[data-acc-text], button.acc-button'
    ).filter((el) => {
      if (ctx.isDangerousNav(el)) return false;
      const label = ctx.controlLabel(el).trim();
      if (!label || label.length < 10) return false;
      if (/kontrol ?et|gonder|submit|ileri|geri|next|previous|rectangle|png|group|casgem|asset|tekrar ?dene|image ?\d/.test(ctx.fold(label))) {
        return false;
      }
      return isShownSlideObject(ctx, el);
    });
    if (options.length) {
      const idx = (state._gonderOptIdx || 0) % options.length;
      state._gonderOptIdx = idx + 1;
      ctx.log('Gönder pasif — seçenek tıklanıyor:', ctx.controlLabel(options[idx]).slice(0, 60));
      return ctx.softClick(options[idx]);
    }
    return false;
  }

  function handleGonder(ctx) {
    const { state, CONFIG } = ctx;
    const now = Date.now();
    if (now < state.slideLockUntil) return false;
    if (now - state.lastGonderAt < CONFIG.gonderCooldownMs) return false;
    const btn = findGonder(ctx);
    if (!btn) return false;

    if (pageHasQuiz(ctx) && /sinav/.test(ctx.fold((document.body && document.body.innerText) || ''))) {
      if (!state._loggedGonderExam) {
        state._loggedGonderExam = true;
        ctx.warn('"Gönder" bir sınav formunda — otomatik gönderilmedi, elle gönderin.');
      }
      return false;
    }
    if (state.gonderCount >= CONFIG.maxGonderPerSlide) {
      if (!state._loggedGonderLimit) {
        state._loggedGonderLimit = true;
        ctx.warn('"Gönder" bu ekranda otomatik geçilemedi — elle tıklamanız gerekebilir.');
      }
      return false;
    }

    if (!isGonderDisabled(ctx, btn)) {
      state.lastGonderAt = now;
      state.gonderCount += 1;
      ctx.ok('"Gönder" tıklandı.');
      return ctx.softClick(btn);
    }
    if (pickAnyOption(ctx)) {
      state.lastGonderAt = now;
      state.gonderCount += 1;
      return true;
    }
    return false;
  }

  function dialogLooksLikeContinue(ctx, rootEl) {
    const text = ctx.fold(rootEl.textContent || '');
    return [
      'izlemeye devam',
      'devam ediyor mus',
      'devam etmek istiyor',
      'hala izliyor',
      'continue watching',
      'are you still watching',
    ].some((k) => text.includes(k));
  }

  function clickContinueModals(ctx) {
    const { state, CONFIG } = ctx;
    const now = Date.now();
    if (now - state.lastModalAt < CONFIG.modalClickCooldownMs) return false;
    const roots = document.querySelectorAll(
      '.swal-modal, .swal2-popup, .sweet-alert, .modal.show, .modal.in, [role="dialog"]'
    );
    for (const rootEl of roots) {
      if (isQuizLike(ctx, rootEl)) continue;
      if (!dialogLooksLikeContinue(ctx, rootEl)) continue;
      if (/cikis|cikmak|ana ?sayfa|oturumu kapat|logout/.test(ctx.fold(rootEl.textContent))) continue;
      const btn =
        rootEl.querySelector('.swal-button--confirm') ||
        rootEl.querySelector('.swal2-confirm') ||
        Array.from(rootEl.querySelectorAll('button, .swal-button, .btn')).find((b) => (
          /\b(devam|tamam|onay|evet|ok)\b/.test(ctx.fold(b.textContent))
        ));
      if (btn && !btn.disabled) {
        state.lastModalAt = now;
        ctx.ok('"İzlemeye devam" onayı tıklandı:', (btn.textContent || '').trim());
        btn.click();
        return true;
      }
    }
    return false;
  }

  // --- SCORM next / hotspots ---
  function resolveClickable(ctx, el) {
    if (!el) return null;
    let cur = el;
    for (let i = 0; i < 8 && cur; i += 1) {
      if (cur.matches && cur.matches('button, a, [role="button"], #next, #btnnext, .cs-button, .nav-button')) {
        return cur;
      }
      const id = (cur.id || '').toLowerCase();
      if (id === 'next' || id === 'btnnext') return cur;
      if (cur.getAttribute && cur.getAttribute('tabindex') != null && ctx.looksEnabled(cur) && ctx.visible(cur)) {
        return cur;
      }
      cur = ctx.parentNodeOf(cur);
    }
    return el.closest ? (el.closest('button, a, [role="button"], #next, .cs-button') || el) : el;
  }

  function findStorylineNextButton(ctx) {
    const byIcon = ctx.queryDeep(
      'svg.cs-icon.next-icon, svg.next-icon, .btn-icon .next-icon, .cs-icon.next-icon'
    );
    if (byIcon) {
      const btn = resolveClickable(ctx, byIcon);
      if (btn && ctx.visible(btn) && !ctx.isDangerousNav(btn)) return btn;
    }

    const labels = ctx.queryDeepAll(
      'span[data-ref="label"], .view-content [data-ref="label"], .text.resizeable-text'
    );
    for (const label of labels) {
      const text = ctx.fold(label.textContent);
      if (text !== 'ileri' && text !== 'next') continue;
      const btn = resolveClickable(ctx, label);
      if (!btn || ctx.isDangerousNav(btn)) continue;
      if (!ctx.visible(btn)) continue;
      return btn;
    }

    const byId = ctx.queryDeep('#next, #btnnext, [id="next"]');
    if (byId && ctx.visible(byId) && !ctx.isDangerousNav(byId)) return byId;
    return null;
  }

  function findNextControl(ctx) {
    const story = findStorylineNextButton(ctx);
    if (story) return story;

    const navPreferred = [
      ctx.queryDeep('#next'),
      ctx.queryDeep('#btnnext'),
      ...ctx.queryDeepAll(
        '#nav button, #nav a, #nav [role="button"], .nav-controls button, .nav-controls a, .cs-button[data-acc-text*="İleri" i], .cs-button[data-acc-text*="LERİ"], .cs-button[data-acc-text*="ileri" i], .cs-button[data-acc-text*="Next" i]'
      ),
    ].filter(Boolean);

    const score = (el) => {
      const id = (el.id || '').toLowerCase();
      const label = ctx.fold(ctx.controlLabel(el));
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
      ...ctx.queryDeepAll(
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

  function advanceNext(ctx) {
    const { state, CONFIG } = ctx;
    if (ctx.isSlideLocked()) return false;
    const now = Date.now();
    if (now - state.lastAdvanceAt < CONFIG.nextCooldownMs) return false;

    const next = findNextControl(ctx);
    if (!next || !ctx.looksEnabled(next) || ctx.isDangerousNav(next)) {
      if (next && !ctx.looksEnabled(next) && !state._loggedLocked) {
        state._loggedLocked = true;
        ctx.log('İLERİ kilitli — Sıra Sizde/medya bekleniyor.');
      }
      return false;
    }

    state.lastAdvanceAt = now;
    state.advanceFromSlide = getSlideIndex(ctx);
    ctx.lockSlide(CONFIG.postAdvanceLockMs);
    state.mediaEndedArmed = false;
    state._loggedLocked = false;
    ctx.log('İLERİ soft click (güvenli):', ctx.controlLabel(next).slice(0, 80));
    const clicked = ctx.softClick(next);
    if (clicked) {
      state.nextClicks += 1;
      ctx.noteActivity();
      ctx.postGuard('next-key-if-stuck', { allowUnknown: false, delay: CONFIG.nextKeyDelayMs });
    }
    return clicked;
  }

  function armNextShortcut(ctx, reason) {
    const { state, CONFIG } = ctx;
    const now = Date.now();
    if (now - state.shortcutArmedAt < CONFIG.nextKeyDelayMs + 400) return false;
    state.shortcutArmedAt = now;
    state.lastAdvanceAt = now;
    ctx.postGuard('next-key-if-stuck', { allowUnknown: true, delay: 300, reason: reason || '' });
    return true;
  }

  function isNavChrome(el) {
    if (!el || !el.closest) return false;
    if (el.closest('#nav, #controls, .controls-container, .nav-controls, #control-bar, .control-bar')) {
      return true;
    }
    const id = (el.id || '').toLowerCase();
    return id === 'next' || id === 'prev' || id === 'previous' || id === 'submit';
  }

  function slideIdentity(rootEl) {
    try {
      if (typeof GetPlayer === 'function') {
        const player = GetPlayer();
        const idx = player && typeof player.GetCurrentSlideIndex === 'function'
          ? player.GetCurrentSlideIndex()
          : null;
        if (idx != null && idx !== '') return 'slide:' + idx;
      }
    } catch (_) { /* Storyline API yoksa metin anahtarı */ }
    const attr = rootEl && (rootEl.getAttribute('data-index') || rootEl.getAttribute('data-slide-id'));
    if (attr) return 'dom:' + attr;
    const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return 'text:' + text;
  }

  function passTargetKey(ctx, el) {
    return el.getAttribute('data-model-id')
      || el.id
      || ctx.controlLabel(el).slice(0, 80);
  }

  function passScore(ctx, el) {
    if (ctx.isDangerousNav(el) || isNavChrome(el)) return -1;
    if (el.closest && el.closest('video, .slide-object-video, .video-container')) return -1;
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) return -1;

    const text = ctx.fold(el.innerText);
    const blob = ctx.fold(text + ' ' + ctx.controlLabel(el));
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

  function clickPassableScreens(ctx) {
    const { state, CONFIG } = ctx;
    if (isSiraSizdeSlide(ctx)) return false;
    if (Date.now() < state.slideLockUntil) return false;
    const now = Date.now();
    if (now - state.lastHotspotAt < CONFIG.hotspotCooldownMs) return false;

    const slide = ctx.queryDeep('#slide');
    const layers = ctx.queryDeepAll('.slide-layer.shown, #lightbox, .lightbox-wrapper');
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
    searchRoots.forEach((rootEl) => {
      ctx.queryDeepAll(
        'button, a, [role="button"], [role="tab"], [aria-expanded="false"], .cursor-hover, .slide-object-button, .slide-object-hotspot',
        rootEl
      ).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (!ctx.visible(el) || !ctx.looksEnabled(el)) return;
        const score = passScore(ctx, el);
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
        ctx.log('Bu ekranda tıklanacak geçiş alanı yok.');
      }
      return false;
    }

    let pool = usable.filter((item) => !state.passClicked[passTargetKey(ctx, item.el)]);
    if (!pool.length) {
      state.passClicked = {};
      state.lastHotspotAt = now;
      return false;
    }
    pool = pool.sort((a, b) => b.score - a.score);
    const bestScore = pool[0].score;
    const same = pool.filter((item) => item.score === bestScore);
    const target = same[0].el;
    state.passClicked[passTargetKey(ctx, target)] = true;
    state.lastHotspotAt = now;
    ctx.log('Geçiş tıkı:', ctx.controlLabel(target).slice(0, 80));
    return ctx.softClick(target);
  }

  function tryAdvanceFromMedia(ctx, player, media) {
    const { state, CONFIG } = ctx;
    if (ctx.isSlideLocked()) return;
    const duration = ctx.readDuration(player, media);
    const t = ctx.readTime(player, media);
    const ended = ctx.isEnded(player, media) || (duration > 0 && t / duration >= CONFIG.endedRatio);
    if (!ended) {
      state.mediaEndedArmed = false;
      return;
    }
    if (state.mode === 'videojs') {
      advanceVideoJs(ctx);
      return;
    }
    const next = findNextControl(ctx);
    if (!(next && ctx.looksEnabled(next))) {
      if (!state._loggedWaitNext) {
        state._loggedWaitNext = true;
        ctx.log('Medya bitti, İLERİ henüz kilitli — açılınca tıklanacak.');
      }
      return;
    }
    if (state.mediaEndedArmed) return;
    state.mediaEndedArmed = true;
    ctx.ok('Medya bitti + İLERİ açık — güvenli geçiş...');
    ctx.trackTimeout(() => {
      state.mediaEndedArmed = false;
      advanceNext(ctx);
    }, CONFIG.postEndedWaitMs);
  }

  function advanceVideoJs(ctx) {
    const { state, CONFIG } = ctx;
    const now = Date.now();
    if (now - state.lastAdvanceAt < CONFIG.nextCooldownMs) return false;
    if (state.nextClicks >= CONFIG.maxNextClicks) return false;
    if (goNextVideoJsMenu(ctx)) {
      state.nextClicks += 1;
      ctx.noteActivity();
      return true;
    }
    if (!state._loggedVjsEnd) {
      state._loggedVjsEnd = true;
      ctx.ok('Video bitti; sıradaki ders bulunamadı — eğitim tamamlanmış olabilir.');
    }
    return false;
  }

  function goNextVideoJsMenu(ctx) {
    const { state, CONFIG } = ctx;
    if (ctx.isSlideLocked()) return false;
    const nextRe = /^(sonraki|ileri|sonraki ders|sonraki video|devam|next)$/;
    const softRe = /\bsonraki\b|\bileri\b|next video|next lesson/;
    const textOf = (el) => ctx.fold(el.textContent);
    const clickables = Array.from(
      document.querySelectorAll('a, button, [role="button"], .btn, span[onclick], div[onclick]')
    );
    const exact = clickables.find((el) => ctx.visible(el) && nextRe.test(textOf(el)));
    const soft = exact || clickables.find((el) => ctx.visible(el) && softRe.test(textOf(el)));
    if (soft && ctx.looksEnabled(soft) && !ctx.isDangerousNav(soft)) {
      state.lastAdvanceAt = Date.now();
      ctx.lockSlide(CONFIG.videoJsLockMs);
      ctx.log('Video.js sonraki:', (soft.textContent || '').trim().slice(0, 80));
      ctx.softClick(soft);
      return true;
    }

    const items = Array.from(
      document.querySelectorAll(
        'a[href*="Video"], a[href*="video"], li a, .list-group-item, [class*="ders"] a, [class*="menu"] a'
      )
    );
    for (const el of items) {
      if (!ctx.visible(el)) continue;
      const href = (el.getAttribute && el.getAttribute('href')) || '';
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
        if (!root.UEKLinks || !root.UEKLinks.isDirectPlayerUrl(el.href)) continue;
        if (el.href === location.href) continue;
      }
      const cls = String(el.className || '') + ' ' + String(el.parentElement?.className || '');
      const done =
        /completed|tamam|done|success|check/i.test(cls) ||
        el.querySelector('.fa-check, .glyphicon-ok, .text-success, [class*="check"]');
      if (done) continue;
      if (ctx.isDangerousNav(el)) continue;
      state.lastAdvanceAt = Date.now();
      ctx.lockSlide(CONFIG.videoJsLockMs);
      ctx.log('Menüden sonraki ders:', (el.textContent || '').trim().slice(0, 80));
      ctx.softClick(el);
      return true;
    }
    return false;
  }

  function lessonRows(ctx) {
    return Array.from(document.querySelectorAll(
      'a[href*="Video"], a[href*="video"], li a, .list-group-item, [class*="ders"] a, [class*="menu"] a'
    )).filter((el) => {
      const href = (el.getAttribute && el.getAttribute('href')) || '';
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
        if (!root.UEKLinks || !root.UEKLinks.isDirectPlayerUrl(el.href)) return false;
      }
      const text = ctx.fold(el.innerText || '');
      return text.length > 1 && text.length < 180;
    });
  }

  function lessonMarkedDone(ctx, el) {
    const cls = ctx.fold(String(el.className || '') + ' ' + String((el.parentElement && el.parentElement.className) || ''));
    if (/tamamland|completed|is-complete/.test(cls)) return true;
    return !!el.querySelector('.fa-check, .glyphicon-ok, .bi-check-circle, .text-success');
  }

  function shellFinished(ctx) {
    const nodes = document.querySelectorAll('a, button, input, .btn, span, p, h1, h2, h3, strong, label');
    let again = false;
    let phrase = false;
    let devam = false;
    for (const el of nodes) {
      if (!ctx.visible(el)) continue;
      const t = ctx.fold(el.innerText || el.value || '');
      if (!t || t.length > 180) continue;
      if (/egitime devam et/.test(t)) devam = true;
      if (/egitime tekrar katil/.test(t)) again = true;
      if (/egitimi basariyla tamamlad|egitim(iniz|i)? tamamlandi|bu egitimi tamamlad/.test(t)) phrase = true;
    }
    if (devam && !again) return false;
    return again || phrase;
  }

  function finishedReason(ctx) {
    const { state, CONFIG } = ctx;
    if (state.quizPaused) return '';
    if (shellFinished(ctx)) return 'tamamlanmis';
    const rows = lessonRows(ctx);
    if ((state.mode === 'videojs' || state.mode === 'media') && rows.length >= 2 && rows.every((r) => lessonMarkedDone(ctx, r))) {
      return 'uniteler-bitti';
    }
    if (ctx.playbackStillNeeded()) return '';
    if (state.mode === 'videojs' && state._loggedVjsEnd) {
      const { player, media } = ctx.resolveBundle();
      const d = ctx.readDuration(player, media);
      const ended = ctx.isEnded(player, media) || (d > 0 && ctx.readTime(player, media) / d >= CONFIG.endedRatio);
      if (ended && !findNextControl(ctx)) return 'video-bitti';
    }
    return '';
  }

  function isAlreadyPlayerPage() {
    return /\/Egitimler\/(ScormV2|Video)(\/|$)/i.test(location.pathname)
      || !!document.querySelector('#ScoFrame, #CbikoPl');
  }

  function clickCourseStart(ctx) {
    const { state } = ctx;
    if (window !== window.top || !state.managedTab || state.stopped) return false;
    if (isAlreadyPlayerPage()) return false;
    const now = Date.now();
    if (now - state.lastStartClickAt < 1200) return false;

    const startRe = /^(devam et|basla|oynat|egitime basla|egitimi baslat|egitime devam et|egitime katil|izlemeye basla|derse basla|egitime gir)$/;
    const controls = ctx.queryDeepAll('a, button, input[type="button"], input[type="submit"], [role="button"]');
    for (const el of controls) {
      if (!ctx.visible(el) || !ctx.looksEnabled(el) || ctx.isDangerousNav(el)) continue;
      const label = ctx.buttonText(el);
      if (!startRe.test(label) || /tekrar katil/.test(label)) continue;
      state.lastStartClickAt = now;
      ctx.ok('Eğitime giriliyor:', label);
      ctx.softClick(el);
      return true;
    }

    if (!root.UEKLinks) return false;
    const players = root.UEKLinks.collectFromDocument(document)
      .filter((item) => root.UEKLinks.isDirectPlayerUrl(item.url) && item.url !== location.href.split('#')[0]);
    if (players.length !== 1) return false;
    state.lastStartClickAt = now;
    ctx.ok('Oynatıcıya giriliyor.');
    location.assign(players[0].url);
    return true;
  }

  function clickPlayOverlay(ctx) {
    const { state } = ctx;
    const el = ctx.queryDeep(
      '[data-dv_ref="playIcon"], svg.play-icon, .play-icon, .vjs-big-play-button, .vjs-play-control.vjs-paused, .play-button'
    );
    if (!el || !ctx.visible(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 36 || rect.height < 36) return false;
    const host = (el.closest && el.closest('button, a, [role="button"], [onclick]')) || el.parentElement || el;
    if (!state.playOverlayLogged) {
      state.playOverlayLogged = true;
      ctx.ok('Oynat düğmesine basıldı.');
    }
    const clickedEl = ctx.softClick(el);
    const clickedHost = host !== el ? ctx.softClick(host) : false;
    return clickedEl || clickedHost;
  }

  function tick(ctx) {
    const { state, CONFIG } = ctx;
    if (state.mode === 'scorm' || state.mode === 'media') {
      const slideKey = String(getSlideIndex(ctx) ?? '');
      if (slideKey !== state.activitySlide) {
        if (state.activitySlide && slideKey) {
          ctx.ok(`Slayt değişti: ${state.activitySlide} → ${slideKey}`);
        }
        state.activitySlide = slideKey;
        ctx.resetMediaWait();
        ctx.noteActivity();
      }

      if (ctx.isSlideLocked()) return;
      const { player, media } = ctx.resolveBundle();
      if (media && media !== state.boundMedia) {
        state.mediaEndedArmed = false;
        state._loggedWaitNext = false;
        state._loggedLocked = false;
        state._siraOptIdx = 0;
        ctx.attachPlayer(true);
      }

      if (handleGonder(ctx)) {
        ctx.noteActivity();
        return;
      }

      const next = findNextControl(ctx);
      if (next && ctx.looksEnabled(next)) {
        if (ctx.mediaStillPlaying(player, media)) {
          if (!state._loggedMediaWait) {
            state._loggedMediaWait = true;
            ctx.log('İLERİ açık ama medya oynuyor — bitmesi bekleniyor.');
          }
          ctx.applyPlayback(player, media);
          if (ctx.mediaMoved()) ctx.noteActivity();
          return;
        }
        advanceNext(ctx);
        return;
      }

      if (ctx.mediaMoved()) ctx.noteActivity();
      const holdKey = slideKey || 'stuck';
      if (state.heldSlide !== holdKey && Date.now() - state.lastActivityAt > CONFIG.stuckSlideMs) {
        state.heldSlide = holdKey;
        ctx.warn('Slayt ilerlemedi. Zorunlu tık durdu; İLERİ açılırsa basılacak.');
      }

      if (state.heldSlide !== holdKey) {
        if (isSiraSizdeSlide(ctx)) {
          if (handleSiraSizde(ctx)) ctx.noteActivity();
        } else if (clickPassableScreens(ctx)) {
          ctx.noteActivity();
        }
      }

      if (player || media) {
        ctx.applyPlayback(player, media);
        tryAdvanceFromMedia(ctx, player, media);
      }
      if (!next && !ctx.mediaStillPlaying(player, media)) {
        const stamp = String(getSlideIndex(ctx) ?? '');
        if (state.noNextStamp !== stamp || !state.noNextSince) {
          state.noNextStamp = stamp;
          state.noNextSince = Date.now();
        } else if (Date.now() - state.noNextSince >= CONFIG.nextKeyNoButtonMs) {
          armNextShortcut(ctx, 'İLERİ düğmesi yok');
        }
      } else if (next) {
        state.noNextStamp = '';
        state.noNextSince = 0;
      }
      if ((!media && !player) || (ctx.isPaused(player, media) && !ctx.isEnded(player, media))) {
        clickPlayOverlay(ctx);
      }
      return;
    }

    if (state.mode === 'videojs') {
      if (ctx.isSlideLocked()) return;
      const { player, media } = ctx.resolveBundle();
      if (media && media !== state.boundMedia) ctx.attachPlayer(true);
      if (handleGonder(ctx)) ctx.noteActivity();
      if (player || media) {
        if (ctx.mediaMoved()) ctx.noteActivity();
        ctx.applyPlayback(player, media);
        tryAdvanceFromMedia(ctx, player, media);
      }
      if ((!media && !player) || (ctx.isPaused(player, media) && !ctx.isEnded(player, media))) {
        clickPlayOverlay(ctx);
      }
    }
  }

  if (root.EgitimAdapters) {
    root.EgitimAdapters.register({
      id: 'uek',
      name: 'Uzaktan Eğitim Kapısı',
      allowParentTransition: false,
      matches(loc) {
        return /(?:^|\.)uzaktanegitimkapisi\.gov\.tr$/i.test(loc.hostname)
          || /(?:^|\.)cbiko\.gov\.tr$/i.test(loc.hostname);
      },
      detectMode,
      targetRate,
      getSlideIndex,
      isQuizActive,
      quizPauseMessage: 'Sınav/Sıra Sizde göründü — cevabı elle verin; İLERİ yine denenecek.',
      isAlreadyPlayerPage,
      clickCourseStart,
      clickContinueModals,
      clickPlayOverlay,
      onMediaEnded: tryAdvanceFromMedia,
      tick,
      finishedReason,
    });
  }
})(globalThis);

/**
 * egitimSavar — sayfa dünyası koruması (world: MAIN, document_start).
 *
 * Eğitim sayfasının kendi betikleri sekme arka plana geçince videoyu duraklatabiliyor ya da
 * zamanlayıcıları yavaşlıyor. İzole içerik betiği bu sayfa nesnelerine erişemez; koruma burada,
 * sayfanın kendi dünyasında yapılır:
 *   1) document.hidden / visibilityState / hasFocus() sayfaya her zaman "görünür, odakta" döner.
 *   2) visibilitychange ve pencere blur/focusout olayları sayfa dinleyicilerine ulaşmadan kesilir.
 *   3) Sekme GERÇEKTEN arka plandayken gelen pause() çağrıları yok sayılır.
 *      Sessiz video arka planda tarayıcı tarafından durdurulur; gizliyken ses kısık ama
 *      kapalı olmayan (muted=false, volume>0) tutulur ki oynatma askıya alınmasın.
 *   4) Arka planda tarayıcı requestAnimationFrame'i tamamen durdurur (Storyline zaman çizelgesi
 *      buna bağlı). Sekme gizliyken bekleyen kareler bir zamanlayıcıyla çalıştırılır.
 *   5) Chrome'un yoğun zamanlayıcı kısıtlamasına (5 dk sonra dakikada 1) karşı bir Web Lock tutulur.
 *
 * Gerçek görünürlük durumu içerik betiğine window.postMessage ile iletilir (raporlama için).
 */
(() => {
  'use strict';

  const MARK = '__egitimSavar';
  if (window[MARK]) return;
  window[MARK] = true;

  const docProto = Document.prototype;
  const realHiddenGet = Object.getOwnPropertyDescriptor(docProto, 'hidden').get;

  function realHidden() {
    try {
      return !!realHiddenGet.call(document);
    } catch (_) {
      return false;
    }
  }

  function notify(payload) {
    try {
      window.postMessage(Object.assign({ [MARK]: true }, payload), '*');
    } catch (_) { /* ignore */ }
  }

  // 1) sayfaya sahte "görünür, odakta" durum (önekli eski adlar dahil)
  function define(proto, name, getter) {
    try {
      if (name in proto) Object.defineProperty(proto, name, { configurable: true, get: getter });
    } catch (_) { /* ignore */ }
  }
  define(docProto, 'hidden', () => false);
  define(docProto, 'visibilityState', () => 'visible');
  define(docProto, 'webkitHidden', () => false);
  define(docProto, 'webkitVisibilityState', () => 'visible');
  define(docProto, 'mozHidden', () => false);
  try {
    // Sayfa "odak yoksa duraklat" yoklaması yapıyorsa hep odakta görünsün
    docProto.hasFocus = function hasFocus() { return true; };
  } catch (_) { /* ignore */ }

  // 2) olayları sayfaya ulaşmadan kes; gerçek durumu önce oku ve içerik betiğine bildir
  let lastReported = null;
  function report(hidden) {
    if (hidden === lastReported) return;
    lastReported = hidden;
    notify({ kind: 'visibility', hidden });
    if (hidden) keepBackgroundMedia();
  }
  window.addEventListener('visibilitychange', () => {
    report(realHidden());
  }, true);
  // Bu dinleyici sayfanınkilerden önce kaydedildiği için (document_start) önce çalışır;
  // aşağıdaki kesme, sayfanın document/window dinleyicilerine olayı ulaştırmaz.
  window.addEventListener('visibilitychange', (ev) => {
    ev.stopImmediatePropagation();
  }, true);
  // Yalnız pencerenin/belgenin kendi blur'ü kesilir. Input/elemanların blur'ü (form doğrulama) korunur.
  window.addEventListener('blur', (ev) => {
    if (ev.target === window || ev.target === document) ev.stopImmediatePropagation();
  }, true);
  ['focusout', 'freeze', 'webkitvisibilitychange'].forEach((type) => {
    window.addEventListener(type, (ev) => {
      if (ev.target === window || ev.target === document) ev.stopImmediatePropagation();
    }, true);
  });

  // 3) arka plandayken sayfanın duraklatmasını yok say.
  //    Chrome/Firefox sessiz (muted veya volume 0) videoyu gizli sekmede kendisi durdurur;
  //    JS pause() override'ı bunu tek başına engellemez. Gizliyken medya duyulur ama kısık kalır.
  const KEEPALIVE_VOLUME = 0.02;
  let blockedCount = 0;
  const origPause = HTMLMediaElement.prototype.pause;
  const origPlay = HTMLMediaElement.prototype.play;

  function forceAudible(el) {
    if (!el || el.ended) return;
    try {
      if (el.muted) el.muted = false;
      if ((el.volume || 0) < KEEPALIVE_VOLUME) el.volume = KEEPALIVE_VOLUME;
    } catch (_) { /* ignore */ }
  }

  function holdPlaying(el) {
    forceAudible(el);
    if (!el || el.ended || !el.paused) return;
    try {
      const p = origPlay.call(el);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* ignore */ }
  }

  function keepBackgroundMedia() {
    if (!realHidden()) return;
    try {
      document.querySelectorAll('video, audio').forEach(holdPlaying);
    } catch (_) { /* ignore */ }
  }

  try {
    const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    const volumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    if (mutedDesc && mutedDesc.set && mutedDesc.get) {
      Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
        configurable: true,
        enumerable: mutedDesc.enumerable,
        get() { return mutedDesc.get.call(this); },
        set(v) {
          if (realHidden() && !this.ended && v) return;
          mutedDesc.set.call(this, v);
        },
      });
    }
    if (volumeDesc && volumeDesc.set && volumeDesc.get) {
      Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
        configurable: true,
        enumerable: volumeDesc.enumerable,
        get() { return volumeDesc.get.call(this); },
        set(v) {
          const next = realHidden() && !this.ended && Number(v) < KEEPALIVE_VOLUME ? KEEPALIVE_VOLUME : v;
          volumeDesc.set.call(this, next);
        },
      });
    }
  } catch (_) { /* ignore */ }

  HTMLMediaElement.prototype.pause = function egitimSavarPause(...args) {
    if (realHidden() && !this.ended) {
      blockedCount += 1;
      notify({ kind: 'pause-blocked', count: blockedCount });
      holdPlaying(this);
      return undefined;
    }
    return origPause.apply(this, args);
  };

  document.addEventListener('pause', (ev) => {
    const el = ev.target;
    if (!realHidden() || !el || el.ended) return;
    if (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') return;
    holdPlaying(el);
  }, true);

  // 4) requestAnimationFrame arka planda çalışmaz; gizliyken bekleyen kareleri worker saati yürütür
  let flushHiddenRaf = () => {};
  try {
    const origRaf = window.requestAnimationFrame.bind(window);
    const origCaf = window.cancelAnimationFrame.bind(window);
    const pending = new Map();
    let seq = 0;

    flushHiddenRaf = () => {
      if (!pending.size || !realHidden()) return;
      const batch = Array.from(pending.entries());
      const ts = performance.now();
      batch.forEach(([id, entry]) => {
        if (!pending.delete(id)) return;
        origCaf(entry.raf);
        try {
          entry.callback(ts);
        } catch (e) {
          setTimeout(() => { throw e; }, 0);
        }
      });
    };

    window.requestAnimationFrame = function egitimSavarRaf(callback) {
      if (typeof callback !== 'function') return origRaf(callback);
      seq += 1;
      const id = seq;
      const entry = { callback, raf: 0 };
      entry.raf = origRaf((ts) => {
        if (!pending.delete(id)) return;
        callback(ts);
      });
      pending.set(id, entry);
      return id;
    };
    window.cancelAnimationFrame = function egitimSavarCaf(id) {
      const entry = pending.get(id);
      if (!entry) return origCaf(id);
      pending.delete(id);
      origCaf(entry.raf);
      return undefined;
    };

  } catch (_) { /* ignore */ }

  // 5) Chrome yoğun zamanlayıcı kısıtlaması: Web Lock tutan sayfa muaf
  try {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      navigator.locks.request('egitimSavar-keepalive-' + Math.random().toString(36).slice(2),
        () => new Promise(() => {})).catch(() => {});
    }
  } catch (_) { /* ignore */ }

  // 6) Zamanlayıcı kısıtlaması: gizli sekmede setTimeout/setInterval en az 1 sn'ye (Firefox'ta
  //    bütçe aşılınca çok daha uzuna, Chrome'da 5 dk sonra dakikada 1'e) çekilir. Worker
  //    zamanlayıcıları kısılmaz; sekme gizliyken sayfanın zamanlayıcıları worker saatine verilir.
  //    Görünürken yerel zamanlayıcılar aynen kullanılır. Worker kurulamazsa (CSP vb.) hiçbir
  //    şey değiştirilmez.
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);

  let clockWorker = null;
  let clockBroken = false;
  try {
    const src = 'const t=new Map();'
      + 'onmessage=(e)=>{const d=e.data;'
      + 'if(d.op==="set"){t.set(d.id,setTimeout(()=>{t.delete(d.id);postMessage(d.id);},d.delay));}'
      + 'else if(d.op==="clear"){clearTimeout(t.get(d.id));t.delete(d.id);}};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    clockWorker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch (_) {
    clockWorker = null;
  }

  if (clockWorker) {
    const timers = new Map(); // id -> { cb, args, delay, repeat, due, native, viaWorker }
    let nextId = 1 << 30;

    const workerUsable = () => !clockBroken && realHidden();

    function schedule(id, entry, delay) {
      entry.due = Date.now() + delay;
      if (workerUsable()) {
        entry.viaWorker = true;
        entry.native = 0;
        clockWorker.postMessage({ op: 'set', id, delay });
      } else {
        entry.viaWorker = false;
        entry.native = nativeSetTimeout(() => fire(id), delay);
      }
    }

    function fire(id) {
      const entry = timers.get(id);
      if (!entry) return;
      if (entry.repeat) schedule(id, entry, entry.delay);
      else timers.delete(id);
      try {
        entry.cb.apply(window, entry.args);
      } catch (e) {
        // sayfanın kendi hatası; zamanlayıcı döngüsünü bozmasın
        nativeSetTimeout(() => { throw e; }, 0);
      }
    }

    function add(cb, delay, args, repeat) {
      const id = ++nextId;
      const entry = { cb, args, delay: Math.max(0, Number(delay) || 0), repeat, due: 0, native: 0, viaWorker: false };
      timers.set(id, entry);
      schedule(id, entry, entry.delay);
      return id;
    }

    function remove(id) {
      const entry = timers.get(id);
      if (!entry) return false;
      timers.delete(id);
      if (entry.viaWorker) clockWorker.postMessage({ op: 'clear', id });
      else nativeClearTimeout(entry.native);
      return true;
    }

    clockWorker.onmessage = (ev) => fire(ev.data);
    clockWorker.onerror = () => {
      // worker çalışmıyor (CSP vb.): bekleyenleri yerel zamanlayıcıya geri ver
      clockBroken = true;
      timers.forEach((entry, id) => {
        if (!entry.viaWorker) return;
        entry.viaWorker = false;
        entry.native = nativeSetTimeout(() => fire(id), Math.max(0, entry.due - Date.now()));
      });
    };

    window.setTimeout = function egitimSavarSetTimeout(cb, delay, ...args) {
      if (typeof cb !== 'function') return nativeSetTimeout(cb, delay, ...args);
      return add(cb, delay, args, false);
    };
    window.setInterval = function egitimSavarSetInterval(cb, delay, ...args) {
      if (typeof cb !== 'function') return nativeSetInterval(cb, delay, ...args);
      return add(cb, delay, args, true);
    };
    window.clearTimeout = function egitimSavarClearTimeout(id) {
      if (!remove(id)) nativeClearTimeout(id);
    };
    window.clearInterval = function egitimSavarClearInterval(id) {
      if (!remove(id)) nativeClearInterval(id);
    };

    // Sekme gizlenince yerel (kısılacak) bekleyenleri worker saatine taşı
    window.addEventListener('visibilitychange', () => {
      if (!workerUsable()) return;
      timers.forEach((entry, id) => {
        if (entry.viaWorker) return;
        nativeClearTimeout(entry.native);
        schedule(id, entry, Math.max(0, entry.due - Date.now()));
      });
    }, true);

    // Gizliyken kısılmayan saat: medya ve kare pompası ~100 ms, içerik betiğine tick ~500 ms
    let pumps = 0;
    const driver = () => {
      if (realHidden()) {
        flushHiddenRaf();
        keepBackgroundMedia();
        pumps += 1;
        if (pumps % 5 === 0) notify({ kind: 'tick' });
      }
      add(driver, 100, [], false);
    };
    add(driver, 100, [], false);
  } else {
    nativeSetInterval(() => {
      if (!realHidden()) return;
      flushHiddenRaf();
      keepBackgroundMedia();
    }, 250);
  }

  // 7) Sessiz bir AudioContext: Firefox/Chrome çalışan ses bağlamı olan sayfayı kısmaya daha
  //    isteksiz. Kullanıcı etkileşimi olmadan "suspended" kalır; zararsızdır.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      const wake = () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      };
      ['pointerdown', 'keydown', 'click'].forEach((type) => window.addEventListener(type, wake, true));
      wake();
    }
  } catch (_) { /* ignore */ }

  // İlk durumu bildir (sayfa arka planda açılmış olabilir) ve hazır olduğunu söyle
  notify({ kind: 'ready' });
  report(realHidden());
})();

/**
 * egitimSavar — sayfa dünyası koruması (world: MAIN, document_start).
 *
 * Eğitim sayfasının kendi betikleri sekme arka plana geçince videoyu duraklatabiliyor ya da
 * zamanlayıcıları yavaşlıyor. İzole içerik betiği bu sayfa nesnelerine erişemez; koruma burada,
 * sayfanın kendi dünyasında yapılır:
 *   1) document.hidden / visibilityState / hasFocus() sayfaya her zaman "görünür, odakta" döner.
 *   2) visibilitychange ve pencere blur/focusout olayları sayfa dinleyicilerine ulaşmadan kesilir.
 *   3) Sekme GERÇEKTEN arka plandayken gelen pause() çağrıları yok sayılır.
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

  // 3) arka plandayken sayfanın duraklatmasını yok say
  let blockedCount = 0;
  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function egitimSavarPause(...args) {
    if (realHidden() && !this.ended) {
      blockedCount += 1;
      notify({ kind: 'pause-blocked', count: blockedCount });
      return undefined;
    }
    return origPause.apply(this, args);
  };

  // 4) requestAnimationFrame arka planda çalışmaz; gizliyken bekleyen kareleri zamanlayıcıyla yürüt
  try {
    const origRaf = window.requestAnimationFrame.bind(window);
    const origCaf = window.cancelAnimationFrame.bind(window);
    const pending = new Map();
    let seq = 0;

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

    setInterval(() => {
      if (!pending.size || !realHidden()) return;
      const batch = Array.from(pending.entries());
      const ts = performance.now();
      batch.forEach(([id, entry]) => {
        if (!pending.delete(id)) return;
        origCaf(entry.raf);
        try {
          entry.callback(ts);
        } catch (e) {
          // sayfanın kendi hatası; döngüyü bozmasın ama sayfa konsoluna düşsün
          setTimeout(() => { throw e; }, 0);
        }
      });
    }, 250);
  } catch (_) { /* ignore */ }

  // 5) Chrome yoğun zamanlayıcı kısıtlaması: Web Lock tutan sayfa muaf
  try {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      navigator.locks.request('egitimSavar-keepalive-' + Math.random().toString(36).slice(2),
        () => new Promise(() => {})).catch(() => {});
    }
  } catch (_) { /* ignore */ }

  // İlk durumu bildir (sayfa arka planda açılmış olabilir) ve hazır olduğunu söyle
  notify({ kind: 'ready' });
  report(realHidden());
})();

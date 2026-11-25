/**
 * egitimSavar — sayfa dünyası koruması (world: MAIN, document_start).
 *
 * Eğitim sayfasının kendi betikleri sekme arka plana geçince (Page Visibility / blur) videoyu
 * duraklatabiliyor. İzole içerik betiği bu sayfa nesnelerine erişemez, bu yüzden koruma burada
 * sayfanın kendi dünyasında yapılır:
 *   1) document.hidden / visibilityState sayfaya her zaman "görünür" döner.
 *   2) visibilitychange ve blur olayları sayfa dinleyicilerine ulaşmadan kesilir.
 *   3) Sekme GERÇEKTEN arka plandayken gelen pause() çağrıları yok sayılır. Kullanıcı arka
 *      plandayken pencereyle etkileşemeyeceği için bu çağrılar sayfanın kendi duraklatmasıdır.
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
  const realStateGet = Object.getOwnPropertyDescriptor(docProto, 'visibilityState').get;

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

  // 1) sayfaya sahte "görünür" durum
  try {
    Object.defineProperty(docProto, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(docProto, 'visibilityState', { configurable: true, get: () => 'visible' });
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
  // Yalnız pencerenin kendi blur'ü kesilir. Input/elemanların blur'ü (form doğrulama) korunur.
  window.addEventListener('blur', (ev) => {
    if (ev.target === window) ev.stopImmediatePropagation();
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

  // İlk durumu bildir (sayfa arka planda açılmış olabilir) ve hazır olduğunu söyle
  notify({ kind: 'ready' });
  report(realHidden());
})();

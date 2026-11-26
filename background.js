/**
 * egitimSavar — arka plan betiği (Firefox: background.scripts, Chrome: service_worker)
 * İçerik betiği logları + eğitimleri ayrı sekmelere / pencerelere dağıtma + rapor deposu.
 */
const api = typeof browser !== 'undefined' ? browser : chrome;

// Chrome: arka plan bir service worker; ortak dosya importScripts ile yüklenir.
// Firefox: manifest'teki background.scripts listesi report-core.js'i zaten yükler.
if (typeof importScripts === 'function') {
  try {
    importScripts('report-core.js');
  } catch (e) {
    console.warn('[egitimSavar-BG] report-core.js yüklenemedi', e && e.message);
  }
}

const MAX_UNSLOTTED = 3;

// --- rapor deposu ---
const REPORT_KEY = 'uekReport';
const MAX_EVENTS_PER_SESSION = 300;
const MAX_SESSIONS = 40;
const FRAME_TTL_MS = 5 * 60 * 1000;
const FLUSH_MS = 1000;

let tail = Promise.resolve();
function serialized(task) {
  const run = tail.then(task, task);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

// Rapor yazımları pencere/kuyruk işlemlerinden bağımsız, kendi sırasında çalışır
let reportTail = Promise.resolve();
let reportBuffer = [];
let flushTimer = null;

function reportEnqueue(item) {
  item.ts = item.ts || Date.now();
  reportBuffer.push(item);
  if (!flushTimer) flushTimer = setTimeout(reportFlush, FLUSH_MS);
}

function reportFlush() {
  flushTimer = null;
  const items = reportBuffer;
  reportBuffer = [];
  if (!items.length) return reportTail;
  reportTail = reportTail
    .then(() => applyReportItems(items))
    .catch((e) => console.warn('[egitimSavar-BG] Rapor yazılamadı', e && e.message));
  return reportTail;
}

function reportMutate(fn) {
  reportTail = reportTail
    .then(async () => {
      const data = await api.storage.local.get(REPORT_KEY);
      const rep = data[REPORT_KEY] || { sessions: {} };
      if (!rep.sessions) rep.sessions = {};
      fn(rep);
      rep.updatedAt = Date.now();
      await api.storage.local.set({ [REPORT_KEY]: rep });
    })
    .catch((e) => console.warn('[egitimSavar-BG] Rapor güncellenemedi', e && e.message));
  return reportTail;
}

function newSession(key, item, map, tabMap) {
  const mapped = (item.tabId != null && tabMap && tabMap[String(item.tabId)])
    || (item.windowId != null ? map[String(item.windowId)] : null);
  return {
    id: key,
    windowId: item.windowId,
    tabId: item.tabId,
    title: (mapped && mapped.title) || item.title || item.tabTitle || 'Eğitim',
    url: item.url || (mapped && mapped.url) || '',
    managed: !!mapped,
    startedAt: item.ts,
    lastSeen: item.ts,
    closedAt: 0,
    closeReason: '',
    counts: { info: 0, ok: 0, warn: 0, error: 0 },
    frames: {},
    events: [],
  };
}

function pushEvent(session, ts, level, text, frame) {
  const lvl = ['info', 'ok', 'warn', 'error'].includes(level) ? level : 'info';
  session.counts[lvl] = (session.counts[lvl] || 0) + 1;
  session.events.push({ ts, lvl, frame: frame || '', text: String(text || '').slice(0, 300) });
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
  }
}

function sessionKeyFor(item, tabMap) {
  if (item.sessionKey) return item.sessionKey;
  if (item.tabId != null && tabMap && tabMap[String(item.tabId)]) return `t${item.tabId}`;
  if (item.windowId == null) return null;
  return `w${item.windowId}`;
}

async function applyReportItems(items) {
  const data = await api.storage.local.get([REPORT_KEY, 'uekPlayerWindows']);
  const rep = data[REPORT_KEY] || { sessions: {} };
  if (!rep.sessions) rep.sessions = {};
  const map = data.uekPlayerWindows || {};
  const tabMap = await loadPlayerTabs();

  items.forEach((item) => {
    const key = sessionKeyFor(item, tabMap);
    if (!key) return;
    let s = rep.sessions[key];
    // Hiç raporlanmamış (UEK dışı) pencerenin kapanması rapora oturum açmasın
    if (!s && item.kind === 'close') return;
    if (!s) {
      s = newSession(key, item, map, tabMap);
      rep.sessions[key] = s;
    }
    s.lastSeen = Math.max(s.lastSeen, item.ts);
    if (item.tabTitle && s.title === 'Eğitim') s.title = item.tabTitle;
    if (item.url && item.frameId === 0) s.url = item.url;
    const frame = item.frameId === 0 ? 'top' : `f${item.frameId}`;

    if (item.kind === 'event') {
      pushEvent(s, item.ts, item.level, item.text, frame);
    } else if (item.kind === 'heartbeat') {
      s.frames[String(item.frameId)] = Object.assign({}, item.data, { seen: item.ts });
    } else if (item.kind === 'open') {
      s.title = item.title || s.title;
      s.url = item.url || s.url;
      s.managed = true;
      pushEvent(s, item.ts, 'info', item.text, 'bg');
    } else if (item.kind === 'close') {
      s.closedAt = item.ts;
      s.closeReason = item.text || 'Pencere kapandı';
      pushEvent(s, item.ts, 'info', s.closeReason, 'bg');
    }
  });

  pruneReport(rep);
  rep.updatedAt = Date.now();
  await api.storage.local.set({ [REPORT_KEY]: rep });
}

function pruneReport(rep) {
  const now = Date.now();
  Object.values(rep.sessions).forEach((s) => {
    Object.keys(s.frames || {}).forEach((fid) => {
      if (now - (s.frames[fid].seen || 0) > FRAME_TTL_MS) delete s.frames[fid];
    });
  });
  const keys = Object.keys(rep.sessions);
  if (keys.length > MAX_SESSIONS) {
    keys
      .sort((a, b) => {
        const sa = rep.sessions[a];
        const sb = rep.sessions[b];
        // önce kapanmışlar, sonra en eski
        if (!!sa.closedAt !== !!sb.closedAt) return sa.closedAt ? -1 : 1;
        return sa.lastSeen - sb.lastSeen;
      })
      .slice(0, keys.length - MAX_SESSIONS)
      .forEach((k) => delete rep.sessions[k]);
  }
}

/** Tarayıcı yeniden başlayınca pencere kimlikleri tekrar kullanılabilir: eski oturumları arşivle. */
function archiveSessionsAfterRestart() {
  return reportMutate((rep) => {
    const now = Date.now();
    Object.keys(rep.sessions).forEach((key) => {
      const s = rep.sessions[key];
      if (!s.closedAt) {
        s.closedAt = now;
        s.closeReason = 'Tarayıcı yeniden başladı';
      }
      if (!key.startsWith('old-')) {
        rep.sessions[`old-${now}-${key}`] = s;
        delete rep.sessions[key];
      }
    });
  });
}

// --- araç çubuğu simgesi: üzerine gelince özet (tooltip) + rozet ---
const actionApi = api.action || api.browserAction;
const REFRESH_ALARM = 'uek-refresh-action';
let actionTimer = null;

async function refreshAction() {
  const Core = globalThis.UEKReportCore;
  if (!actionApi || !Core) return;
  try {
    const data = await api.storage.local.get([REPORT_KEY, 'uekQueue']);
    const sum = Core.summarize(data[REPORT_KEY], data.uekQueue || [], Date.now());
    const badge = Core.badgeFor(sum);
    await actionApi.setTitle({ title: Core.tooltipText(sum) });
    await actionApi.setBadgeText({ text: badge.text });
    await actionApi.setBadgeBackgroundColor({ color: badge.color });
    // Rozet yazısı her temada okunsun (Chrome 110+/Firefox; yoksa sessizce atla)
    if (typeof actionApi.setBadgeTextColor === 'function') {
      await actionApi.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch (e) {
    console.warn('[egitimSavar-BG] Simge güncellenemedi', e && e.message);
  }
}

function scheduleActionRefresh() {
  if (actionTimer) return;
  actionTimer = setTimeout(() => {
    actionTimer = null;
    refreshAction();
  }, 400);
}

// Rapor veya kuyruk değişince; heartbeat gelmeyen (takılan/kapanan) durumlar için alarmla da
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[REPORT_KEY] || changes.uekQueue)) scheduleActionRefresh();
});

function ensureRefreshAlarm() {
  if (!api.alarms) return;
  Promise.resolve(api.alarms.get(REFRESH_ALARM))
    .then((alarm) => {
      if (!alarm) api.alarms.create(REFRESH_ALARM, { periodInMinutes: 0.5 });
    })
    .catch(() => {});
}

if (api.alarms) {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REFRESH_ALARM) refreshAction();
  });
}
ensureRefreshAlarm();
refreshAction();

api.runtime.onInstalled.addListener((details) => {
  console.log('[egitimSavar-BG] Yüklendi:', details.reason);
  serialized(() => prunePlayerTabs()).catch(() => {});
  ensureRefreshAlarm();
  refreshAction();
});

api.runtime.onStartup.addListener(() => {
  serialized(() => Promise.all([prunePlayerWindows(), prunePlayerTabs()])).catch(() => {});
  archiveSessionsAfterRestart().then(refreshAction);
  ensureRefreshAlarm();
});

function slotBounds(slot, index, cascade) {
  const nudge = cascade ? (index % MAX_UNSLOTTED) * 48 : 0;
  const left = Math.round(Number(slot && slot.left) || 0) + nudge;
  const top = Math.round(Number(slot && slot.top) || 0) + nudge;
  const width = Math.max(480, Math.round(Number(slot && slot.width) || 1100));
  const height = Math.max(400, Math.round(Number(slot && slot.height) || 760));
  return { left, top, width, height };
}

async function readMap() {
  const data = await api.storage.local.get(['uekPlayerWindows', 'uekQueue']);
  return {
    map: data.uekPlayerWindows || {},
    queue: data.uekQueue || [],
  };
}

async function writeMap(map, queue) {
  await api.storage.local.set({
    uekPlayerWindows: map,
    uekQueue: queue,
  });
}

async function prunePlayerWindows() {
  const { map, queue } = await readMap();
  const wins = await api.windows.getAll();
  const live = new Set(wins.map((w) => String(w.id)));
  let changed = false;
  Object.keys(map).forEach((id) => {
    if (!live.has(id)) {
      delete map[id];
      changed = true;
    }
  });
  if (changed) await writeMap(map, queue);
}

let playerTabsMem = null;

async function loadPlayerTabs() {
  if (playerTabsMem) return playerTabsMem;
  const data = await api.storage.local.get('uekPlayerTabs');
  playerTabsMem = data.uekPlayerTabs || {};
  return playerTabsMem;
}

async function savePlayerTabs(tabs) {
  playerTabsMem = tabs;
  await api.storage.local.set({ uekPlayerTabs: tabs });
}

async function prunePlayerTabs() {
  const tabs = await loadPlayerTabs();
  let live = [];
  try {
    live = await api.tabs.query({});
  } catch (_) {
    return;
  }
  const ids = new Set(live.map((tab) => String(tab.id)));
  let changed = false;
  Object.keys(tabs).forEach((id) => {
    if (!ids.has(id)) {
      delete tabs[id];
      changed = true;
    }
  });
  if (changed) await savePlayerTabs(tabs);
}

async function openInTabs(message) {
  const items = Array.isArray(message.items) ? message.items.filter((item) => item && item.url) : [];
  if (!items.length) return { opened: 0, skipped: 0, failed: 0 };

  await prunePlayerTabs();
  await prunePlayerWindows();
  const { map, queue } = await readMap();
  const tabMap = await loadPlayerTabs();
  const known = new Set([
    ...Object.values(map).map((entry) => entry.url),
    ...Object.values(tabMap).map((entry) => entry.url),
  ]);
  const fresh = items.filter((item) => !known.has(item.url));
  const skipped = items.length - fresh.length;
  if (!fresh.length) return { opened: 0, skipped, failed: 0 };

  let opened = 0;
  let failed = 0;
  const openedUrls = new Set();
  const openedTabIds = [];
  let returnTo = null;
  try {
    const [current] = await api.tabs.query({ active: true, currentWindow: true });
    if (current && current.id != null) returnTo = current.id;
  } catch (_) { /* ignore */ }
  for (const item of fresh) {
    try {
      const tab = await api.tabs.create({ url: item.url, active: false });
      if (!tab || tab.id == null) {
        failed += 1;
        continue;
      }
      tabMap[String(tab.id)] = {
        url: item.url,
        title: item.title || 'Eğitim',
        windowId: tab.windowId,
      };
      await savePlayerTabs(tabMap);
      try {
        await api.tabs.update(tab.id, { autoDiscardable: false });
      } catch (_) { /* Firefox bu alanı desteklemez */ }
      reportEnqueue({
        kind: 'open',
        windowId: tab.windowId,
        tabId: tab.id,
        title: item.title || 'Eğitim',
        url: item.url,
        text: 'Sekme açıldı',
      });
      openedUrls.add(item.url);
      openedTabIds.push(tab.id);
      opened += 1;
    } catch (e) {
      failed += 1;
      console.warn('[egitimSavar-BG] Sekme açılamadı', item.url, e && e.message);
    }
  }
  if (openedUrls.size) {
    await writeMap(map, queue.filter((entry) => !openedUrls.has(entry.url)));
  }
  if (openedTabIds.length) warmUpTabs(openedTabIds, returnTo).catch(() => {});
  return { opened, skipped, failed };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sekme açılır açılmaz 1 sn görünüp kapanırsa sayfa daha "Başla" düğmesini çizmeden
 * arka plana düşer ve tarayıcı oynatmayı başlatmaz. Yükleme bitene ve adres oturana
 * kadar sekme önde kalır; kabuk sayfasında başlatma tıklaması da bu sırada yapılır.
 */
async function waitUntilCourseReady(tabId) {
  const deadline = Date.now() + 28000;
  let lastUrl = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch (_) {
      return;
    }
    const url = tab.url || '';
    const complete = tab.status === 'complete' && url && !/^about:/i.test(url);
    if (complete && url === lastUrl) {
      if (!stableSince) stableSince = Date.now();
      const onPlayer = /\/Egitimler\/(ScormV2|Video)(\/|$)/i.test(url)
        || /story\.html/i.test(url);
      const holdMs = onPlayer ? 2200 : 4000;
      if (Date.now() - stableSince >= holdMs) return;
    } else {
      lastUrl = url;
      stableSince = 0;
    }
    await sleep(250);
  }
}

async function warmUpTabs(tabIds, returnTo) {
  for (const id of tabIds) {
    try {
      await api.tabs.update(id, { active: true });
      await waitUntilCourseReady(id);
    } catch (_) { /* sekme kapanmış olabilir */ }
  }
  if (returnTo != null) {
    try {
      await api.tabs.update(returnTo, { active: true });
    } catch (_) { /* ignore */ }
  }
}

async function createPlayerWindow(item, bounds) {
  const win = await api.windows.create({
    url: item.url,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    type: 'normal',
    state: 'normal',
    focused: false,
  });
  if (win && win.id != null) {
    try {
      await api.windows.update(win.id, {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        state: 'normal',
      });
    } catch (_) { /* konum reddedilirse pencere yine açılır */ }
    reportEnqueue({
      kind: 'open',
      windowId: win.id,
      title: item.title || 'Eğitim',
      url: item.url,
      text: `Pencere açıldı (${bounds.left}, ${bounds.top} — ${bounds.width}×${bounds.height})`,
    });
  }
  return win;
}

async function openTrainings(message) {
  const items = Array.isArray(message.items) ? message.items.filter((item) => item && item.url) : [];
  const slots = Array.isArray(message.slots) ? message.slots : [];
  if (!items.length) return { opened: 0, queued: 0 };

  await prunePlayerWindows();
  await prunePlayerTabs();
  const { map, queue } = await readMap();
  const tabMap = await loadPlayerTabs();
  const known = new Set([
    ...Object.values(map).map((entry) => entry.url),
    ...queue.map((entry) => entry.url),
    ...Object.values(tabMap).map((entry) => entry.url),
  ]);
  const fresh = items.filter((item) => !known.has(item.url));
  const skipped = items.length - fresh.length;
  if (!fresh.length) return { opened: 0, queued: queue.length, skipped };

  // Sıra korunur: önce zaten bekleyenler, sonra yeni gelenler
  // (eski sürüm yeni gelenleri eskilerin önüne koyuyordu).
  const candidates = queue.concat(fresh);
  const jobs = [];
  let pending = [];

  if (slots.length) {
    const occupied = new Set(Object.values(map).map((entry) => {
      const bounds = entry.bounds || {};
      return `${bounds.left},${bounds.top}`;
    }));
    const free = slots
      .map((slot) => slotBounds(slot, 0, false))
      .filter((bounds) => !occupied.has(`${bounds.left},${bounds.top}`));
    candidates.forEach((item, index) => {
      if (index < free.length) jobs.push({ item, bounds: free[index] });
      else pending.push(item);
    });
  } else {
    // Kayıtlı ekran yok: toplam açık pencere sayısı MAX_UNSLOTTED'ı aşmasın
    // (eski sürüm her dağıtımda 3 pencere daha açıyordu).
    const used = Object.keys(map).length;
    const room = Math.max(0, MAX_UNSLOTTED - used);
    const current = await api.windows.getLastFocused({ windowTypes: ['normal'] });
    candidates.forEach((item, index) => {
      if (index < room) {
        jobs.push({
          item,
          bounds: slotBounds({
            left: current.left,
            top: current.top,
            width: current.width,
            height: current.height,
          }, used + index, true),
        });
      } else {
        pending.push(item);
      }
    });
  }

  let opened = 0;
  const failed = [];
  for (const job of jobs) {
    try {
      const win = await createPlayerWindow(job.item, job.bounds);
      if (win && win.id != null) {
        map[String(win.id)] = {
          url: job.item.url,
          title: job.item.title || 'Eğitim',
          bounds: job.bounds,
        };
        opened += 1;
      } else {
        failed.push(job.item);
      }
    } catch (e) {
      console.warn('[egitimSavar-BG] Pencere açılamadı', job.item.url, e && e.message);
      failed.push(job.item);
    }
  }

  const nextQueue = failed.concat(pending);
  await writeMap(map, nextQueue);
  return { opened, queued: nextQueue.length, skipped };
}

async function handleRemoved(windowId) {
  const { map, queue } = await readMap();
  const info = map[String(windowId)];
  reportEnqueue({ kind: 'close', windowId, text: 'Pencere kapandı' });
  if (!info) return;
  delete map[String(windowId)];
  if (!info.bounds || !queue.length) {
    await writeMap(map, queue);
    return;
  }
  const next = queue.shift();
  try {
    const win = await createPlayerWindow(next, info.bounds);
    if (win && win.id != null) {
      map[String(win.id)] = {
        url: next.url,
        title: next.title || 'Eğitim',
        bounds: info.bounds,
      };
    } else {
      queue.unshift(next);
    }
  } catch (e) {
    queue.unshift(next);
    console.warn('[egitimSavar-BG] Sıradaki açılamadı', e && e.message);
  }
  await writeMap(map, queue);
}

api.windows.onRemoved.addListener((windowId) => {
  serialized(() => handleRemoved(windowId)).catch(() => {});
});

api.tabs.onRemoved.addListener((tabId) => {
  serialized(async () => {
    const tabs = await loadPlayerTabs();
    const info = tabs[String(tabId)];
    if (!info) return;
    delete tabs[String(tabId)];
    await savePlayerTabs(tabs);
    reportEnqueue({
      kind: 'close',
      sessionKey: `t${tabId}`,
      windowId: info.windowId,
      tabId,
      text: 'Sekme kapandı',
    });
  }).catch(() => {});
});

function isPlayerUrl(url) {
  return /\/Egitimler\/(ScormV2|Video)(\/|$)/i.test(url || '')
    || /story\.html/i.test(url || '')
    || /vod\d*\.uzaktanegitimkapisi/i.test(url || '');
}

/**
 * Bitmiş eğitimin sekmesini kapatır. Yalnız eklentinin açtığı oynatıcı sekmesi/penceresi.
 * Devam eden eğitimlere dokunulmaz.
 */
async function closeFinishedCourse(sender, reason) {
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return { closed: false };
  const tabs = await loadPlayerTabs();
  const { map } = await readMap();
  const managed = !!(tabs[String(tab.id)] || (tab.windowId != null && map[String(tab.windowId)]));
  if (!managed) return { closed: false };
  if (!isPlayerUrl(tab.url) && !isPlayerUrl(sender.url)) return { closed: false };
  reportEnqueue({
    kind: 'event',
    level: 'ok',
    windowId: tab.windowId,
    tabId: tab.id,
    frameId: sender.frameId || 0,
    tabTitle: tab.title,
    url: tab.url,
    text: `Eğitim bitmiş, sekme kapatıldı (${reason || 'bitti'}).`,
  });
  try {
    await api.tabs.remove(tab.id);
  } catch (_) {
    return { closed: false };
  }
  return { closed: true };
}

/** Açık UEK sekmelerindeki tüm çerçevelerde izleyiciyi durdurur. */
async function stopAll() {
  const manifest = api.runtime.getManifest();
  const patterns = manifest.host_permissions || [];
  let tabs = [];
  try {
    tabs = await api.tabs.query({ url: patterns });
  } catch (_) {
    tabs = [];
  }
  let stopped = 0;
  for (const tab of tabs) {
    try {
      await api.tabs.sendMessage(tab.id, { type: 'uek-stop' });
      stopped += 1;
      reportEnqueue({
        kind: 'event',
        level: 'warn',
        windowId: tab.windowId,
        frameId: 0,
        tabTitle: tab.title,
        url: tab.url,
        text: 'Kullanıcı "Tümünü durdur" düğmesine bastı.',
      });
    } catch (_) { /* içerik betiği yok */ }
  }
  return { stopped };
}

function uniqKey(url) {
  try {
    const u = new URL(url);
    return (u.searchParams.get('Uniq') || u.searchParams.get('uniq') || u.origin + u.pathname).toLowerCase();
  } catch (_) {
    return String(url || '').toLowerCase();
  }
}

async function focusTab(tab) {
  await api.tabs.update(tab.id, { active: true });
  try {
    await api.windows.update(tab.windowId, { focused: true });
  } catch (_) { /* ignore */ }
}

/**
 * Bir eğitim oturumunun sekmesine/penceresine geç. Sıra: sekme kimliği → penceredeki UEK sekmesi
 * → adresi (Uniq) eşleşen herhangi bir sekme → yoksa adresi yeni sekmede aç.
 */
async function focusSession(message) {
  const { tabId, windowId, url } = message;

  if (tabId != null) {
    try {
      const tab = await api.tabs.get(tabId);
      if (tab) {
        await focusTab(tab);
        return { ok: true, how: 'tab' };
      }
    } catch (_) { /* sekme kapanmış */ }
  }

  let all = [];
  try {
    all = await api.tabs.query({});
  } catch (_) {
    all = [];
  }

  if (url) {
    const key = uniqKey(url);
    const match = all.find((tab) => tab.url && uniqKey(tab.url) === key);
    if (match) {
      await focusTab(match);
      return { ok: true, how: 'url' };
    }
  }

  if (windowId != null) {
    const inWindow = all.filter((tab) => tab.windowId === windowId);
    const pick = inWindow.find((tab) => tab.active) || inWindow[0];
    if (pick) {
      await focusTab(pick);
      return { ok: true, how: 'window' };
    }
  }

  if (url) {
    await api.tabs.create({ url, active: true });
    return { ok: true, how: 'opened' };
  }
  return { ok: false };
}

/**
 * Chrome, dinleyiciden dönen Promise'i yanıt olarak kabul etmez; sendResponse + `return true`
 * kullanılmalı. Firefox her iki yolu da destekler, bu yüzden tek yöntem kullanılır.
 */
function respondAsync(sendResponse, task) {
  Promise.resolve()
    .then(task)
    .then((result) => sendResponse(result))
    .catch((e) => sendResponse({ error: (e && e.message) || String(e) }));
  return true;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return undefined;

  if (message.type === 'uek-log') {
    const frameId = sender.frameId || 0;
    const frame = frameId === 0 ? 'top' : `frame:${frameId}`;
    const url = (sender.tab && sender.tab.url) || '';
    console.log(`[egitimSavar-BG][${frame}]`, message.text, url.slice(0, 80));
    if (sender.tab && sender.tab.windowId != null) {
      reportEnqueue({
        kind: 'event',
        level: message.level,
        text: message.text,
        windowId: sender.tab.windowId,
        tabId: sender.tab.id,
        frameId,
        tabTitle: sender.tab.title,
        url: message.url || url,
      });
    }
    return undefined;
  }

  if (message.type === 'uek-heartbeat') {
    if (sender.tab && sender.tab.windowId != null && message.data) {
      reportEnqueue({
        kind: 'heartbeat',
        data: message.data,
        windowId: sender.tab.windowId,
        tabId: sender.tab.id,
        frameId: sender.frameId || 0,
        tabTitle: sender.tab.title,
        url: message.data.url || sender.tab.url,
      });
    }
    return undefined;
  }

  if (message.type === 'uek-am-i-player-window') {
    const windowId = sender && sender.tab && sender.tab.windowId;
    const tabId = sender && sender.tab && sender.tab.id;
    if (windowId == null && tabId == null) {
      sendResponse({ player: false });
      return undefined;
    }
    return respondAsync(sendResponse, async () => {
      const { map } = await readMap();
      const tabs = await loadPlayerTabs();
      const player = !!(map[String(windowId)] || (tabId != null && tabs[String(tabId)]));
      return { player };
    });
  }

  if (message.type === 'uek-focus-session') {
    return respondAsync(sendResponse, () => focusSession(message));
  }

  if (message.type === 'uek-open-tabs') {
    return respondAsync(sendResponse, () => serialized(() => openInTabs(message)));
  }

  if (message.type === 'uek-open-trainings') {
    return respondAsync(sendResponse, () => serialized(() => openTrainings(message)));
  }

  if (message.type === 'uek-clear-queue') {
    return respondAsync(sendResponse, () => serialized(async () => {
      const { map } = await readMap();
      await writeMap(map, []);
      return { ok: true };
    }));
  }

  if (message.type === 'uek-course-finished') {
    return respondAsync(sendResponse, () => serialized(() => closeFinishedCourse(sender, message.reason)));
  }

  if (message.type === 'uek-stop-all') {
    return respondAsync(sendResponse, () => stopAll());
  }

  if (message.type === 'uek-report-clear') {
    reportBuffer = [];
    return respondAsync(sendResponse, () => reportMutate((rep) => {
      rep.sessions = {};
    }).then(() => ({ ok: true })));
  }

  return undefined;
});

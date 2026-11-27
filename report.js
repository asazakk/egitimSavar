(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const MAX_EVENT_ROWS = 400;

  const LEVELS = {
    error: { label: 'Hata', cls: 'b-bad' },
    warn: { label: 'Uyarı', cls: 'b-warn' },
    ok: { label: 'Adım', cls: 'b-good' },
    info: { label: 'Bilgi', cls: 'b-off' },
  };
  const SEVERITY = {
    high: { label: 'Yüksek', cls: 'b-bad' },
    medium: { label: 'Orta', cls: 'b-warn' },
    low: { label: 'Düşük', cls: 'b-off' },
  };

  let report = { sessions: {} };
  let queue = [];
  let checked = {};
  let selectedId = '';

  const $ = (id) => document.getElementById(id);

  /** XSS'e kapalı küçük DOM yardımcısı: yalnızca textContent kullanır. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => {
      if (c == null || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  function badge(text, cls) {
    return h('span', { class: `badge ${cls}`, text });
  }

  function statusMark(status) {
    const mark = globalThis.UEKReportCore && UEKReportCore.SYMBOL[status.key];
    return mark ? `${mark} ${status.label}` : status.label;
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  function fmtClock(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('tr-TR');
  }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('tr-TR');
  }

  function fmtAgo(ts, now) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return `${s} sn önce`;
    if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
    return `${Math.floor(s / 3600)} sa ${Math.floor((s % 3600) / 60)} dk önce`;
  }

  function fmtSpan(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return hh ? `${hh}sa ${mm}dk` : `${mm}dk ${String(ss).padStart(2, '0')}sn`;
  }

  function fmtMedia(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Durum çıkarımı ve sayaçlar report-core.js'te (arka plan tooltip'i ve popup ile ortak)
  const Core = globalThis.UEKReportCore;
  const { statusOf, framesOf, mainFrame } = Core;

  function sessionList() {
    return Core.sortedSessions(report);
  }

  // --- render: özet kartlar ---
  function renderCards(now) {
    const sum = Core.summarize(report, queue, now);
    const cards = [
      ['Açık pencere', sum.open, ''],
      ['Çalışan', sum.running, 'good'],
      ['Dikkat gerektiren', sum.attention, sum.attention ? 'bad' : ''],
      ['Kapanan', sum.closed, ''],
      ['Sırada bekleyen', sum.queued, sum.queued ? 'warn' : ''],
      ['İLERİ tıklaması', sum.nextClicks, ''],
      ['Uyarı', sum.warns, sum.warns ? 'warn' : ''],
      ['Hata', sum.errors, sum.errors ? 'bad' : ''],
    ];
    $('cards').replaceChildren(
      ...cards.map(([label, n, cls]) =>
        h('div', { class: `card ${cls}` }, h('div', { class: 'n', text: String(n) }), h('div', { class: 'l', text: label })))
    );
  }

  // --- render: canlı takip ---
  function renderSessions(now) {
    const list = sessionList();
    const box = $('sessions');
    if (!list.length) {
      box.replaceChildren(h('div', { class: 'empty', text: 'Henüz kayıt yok. Eklenti eğitim sayfalarında çalışmaya başlayınca burada görünür.' }));
      return;
    }
    const thead = h('thead', null, h('tr', null,
      ['Eğitim / pencere', 'Durum', 'Slayt', 'Medya ilerlemesi', 'Hız / ses', 'İLERİ', 'Süre', 'Son sinyal']
        .map((t) => h('th', { text: t }))));
    const rows = list.map((s) => {
      const status = statusOf(s, now);
      const frames = framesOf(s, now);
      const main = mainFrame(frames);
      const pct = main && main.duration > 0 ? Math.min(100, Math.round((main.time / main.duration) * 100)) : null;
      const clicks = frames.reduce((n, f) => n + (f.nextClicks || 0), 0);
      const end = s.closedAt || now;
      const tr = h('tr', {
        class: `row${s.id === selectedId ? ' sel' : ''}`,
        onclick: () => {
          selectedId = s.id === selectedId ? '' : s.id;
          renderAll();
        },
      },
      h('td', null,
        h('div', { class: 'title', text: s.title || 'Eğitim' }),
        h('div', {
          class: 'meta',
          text: [
            globalThis.EgitimPlatforms ? EgitimPlatforms.platformLabel(s.platform || s.url) : '',
            s.tabId != null && s.id.startsWith('t') ? `Sekme #${s.tabId}` : `Pencere #${s.windowId}`,
            s.managed ? 'eklenti açtı' : '',
          ].filter(Boolean).join(' · '),
        }),
        s.closedAt ? null : h('button', {
          type: 'button',
          class: 'goto',
          text: 'Sekmeye git',
          onclick: (ev) => {
            ev.stopPropagation();
            api.runtime.sendMessage({
              type: 'uek-focus-session', tabId: s.tabId, windowId: s.windowId, url: s.url,
            }).then((res) => {
              if (!res || !res.ok) toast('Eğitimin sekmesi bulunamadı; kapanmış olabilir.');
            }).catch(() => toast('Sekmeye geçilemedi.'));
          },
        })),
      h('td', null, badge(statusMark(status), status.cls), status.hint ? h('div', { class: 'meta', text: status.hint }) : null),
      h('td', { text: main && main.slide ? main.slide : '—' }),
      h('td', null,
        pct == null
          ? '—'
          : [h('div', { class: 'bar', title: `%${pct}` }, h('i', { style: `width:${pct}%` })),
            h('div', { class: 'meta', text: `${fmtMedia(main.time)} / ${fmtMedia(main.duration)} (%${pct})` })]),
      h('td', { text: main && main.hasMedia ? `${main.rate}x · ${main.muted ? 'sessiz' : 'SES AÇIK'}` : '—' }),
      h('td', { text: String(clicks) }),
      h('td', { text: fmtSpan(end - s.startedAt) }),
      h('td', { text: s.closedAt ? `Kapandı ${fmtClock(s.closedAt)}` : fmtAgo(s.lastSeen, now) }));
      return tr;
    });
    box.replaceChildren(h('table', null, thead, h('tbody', null, rows)));
  }

  function renderDetail(now) {
    const s = report.sessions[selectedId];
    const title = $('detail-title');
    const box = $('detail');
    if (!s) {
      title.hidden = true;
      box.replaceChildren();
      renderDetail.sig = '';
      return;
    }
    // Zaman çizelgesi yalnız rapor değişince yeniden çizilir (kaydırma konumu korunsun)
    const sig = `${s.id}|${report.updatedAt}`;
    if (renderDetail.sig === sig) return;
    renderDetail.sig = sig;
    title.hidden = false;
    title.textContent = `Zaman çizelgesi — ${s.title || 'Eğitim'} (pencere #${s.windowId})`;
    const info = h('p', { class: 'meta', text: `Başladı: ${fmtDateTime(s.startedAt)} · Adres: ${s.url || '—'}` });
    box.replaceChildren(info, eventList(s.events.map((e) => Object.assign({ session: s }, e)), false));
  }

  function eventList(events, showSession) {
    const sorted = events.slice().sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENT_ROWS);
    if (!sorted.length) return h('div', { class: 'empty', text: 'Olay yok.' });
    return h('ul', { class: 'events' }, sorted.map((e) => {
      const lvl = LEVELS[e.lvl] || LEVELS.info;
      const src = [showSession && e.session ? `#${e.session.windowId}` : '', e.frame].filter(Boolean).join(' · ');
      return h('li', null,
        h('span', { class: 't', text: fmtClock(e.ts) }),
        badge(lvl.label, lvl.cls),
        h('span', null, e.text, src ? h('span', { class: 'src', text: `  [${src}]` }) : null));
    }));
  }

  function renderQueue() {
    const box = $('queue');
    if (!queue.length) {
      box.replaceChildren(h('div', { class: 'empty', text: 'Kuyruk boş.' }));
      return;
    }
    box.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['#', 'Eğitim', 'Adres'].map((t) => h('th', { text: t })))),
      h('tbody', null, queue.map((q, i) => h('tr', null,
        h('td', { text: String(i + 1) }),
        h('td', { text: q.title || 'Eğitim' }),
        h('td', null, h('span', { class: 'meta', text: q.url })))))));
  }

  // --- render: olay günlüğü ---
  function renderEvents() {
    const sessions = sessionList();
    const sel = $('f-session');
    const prev = sel.value;
    const optionKey = sessions.map((s) => `${s.id}:${s.title}`).join('|');
    if (sel.dataset.key !== optionKey) {
      // Seçenekleri yalnız değişince yeniden kur (açık açılır liste kapanmasın)
      sel.dataset.key = optionKey;
      sel.replaceChildren(
        h('option', { value: '', text: 'Tümü' }),
        ...sessions.map((s) => h('option', { value: s.id, text: `#${s.windowId} ${s.title || 'Eğitim'}`.slice(0, 60) }))
      );
      sel.value = sessions.some((s) => s.id === prev) ? prev : '';
    }

    const level = $('f-level').value;
    const text = $('f-text').value.trim().toLowerCase();
    const sid = sel.value;
    const sig = `${level}|${text}|${sid}|${report.updatedAt}`;
    if (renderEvents.sig === sig) return;
    renderEvents.sig = sig;
    const all = [];
    sessions.forEach((s) => {
      if (sid && s.id !== sid) return;
      s.events.forEach((e) => {
        if (level && e.lvl !== level) return;
        if (text && !String(e.text).toLowerCase().includes(text)) return;
        all.push(Object.assign({ session: s }, e));
      });
    });
    $('events').replaceChildren(eventList(all, true));
  }

  // --- render: kod inceleme ---
  function renderFindings() {
    const all = globalThis.UEK_FINDINGS || [];
    const fStatus = $('r-status').value;
    const fSev = $('r-sev').value;
    const done = all.filter((f) => checked[f.id]).length;
    $('review-progress').textContent =
      `${all.filter((f) => f.status === 'fixed').length} düzeltme · ${all.filter((f) => f.status === 'note').length} not · ` +
      `${done}/${all.length} madde doğrulandı olarak işaretlendi`;

    const list = all.filter((f) => {
      if (fSev && f.severity !== fSev) return false;
      if (fStatus === 'open') return !checked[f.id];
      if (fStatus) return f.status === fStatus;
      return true;
    });
    if (!list.length) {
      $('findings').replaceChildren(h('div', { class: 'empty', text: 'Bu filtreyle madde yok.' }));
      return;
    }
    $('findings').replaceChildren(...list.map((f) => {
      const sev = SEVERITY[f.severity] || SEVERITY.low;
      const box = h('input', { type: 'checkbox' });
      box.checked = !!checked[f.id];
      box.addEventListener('change', () => {
        checked[f.id] = box.checked;
        if (!box.checked) delete checked[f.id];
        api.storage.local.set({ uekFindingsChecked: checked });
        renderFindings();
      });
      return h('div', { class: `finding${checked[f.id] ? ' done' : ''}` },
        h('div', { class: 'head' },
          badge(f.id, 'b-off'),
          badge(sev.label, sev.cls),
          badge(f.status === 'fixed' ? 'Düzeltildi' : 'Bilgi', f.status === 'fixed' ? 'b-good' : 'b-info'),
          h('span', { class: 't', text: f.title }),
          h('span', { class: 'meta', text: f.file }),
          h('label', null, box, ' Doğruladım')),
        h('p', null, h('span', { class: 'lbl', text: 'Sorun: ' }), f.problem),
        h('p', null, h('span', { class: 'lbl', text: f.status === 'fixed' ? 'Çözüm: ' : 'Not: ' }), f.fix));
    }));
  }

  function renderAll() {
    const now = Date.now();
    let version = '';
    try { version = api.runtime.getManifest().version; } catch (_) { /* ignore */ }
    $('meta').textContent =
      `Sürüm ${version} · Son güncelleme: ${report.updatedAt ? fmtClock(report.updatedAt) : 'henüz yok'} · Otomatik yenilenir`;
    renderCards(now);
    renderSessions(now);
    renderDetail(now);
    renderQueue();
    renderEvents();
  }

  async function load() {
    const data = await api.storage.local.get(['uekReport', 'uekQueue', 'uekFindingsChecked']);
    report = data.uekReport || { sessions: {} };
    if (!report.sessions) report.sessions = {};
    queue = data.uekQueue || [];
    checked = data.uekFindingsChecked || {};
  }

  async function refresh() {
    await load();
    renderAll();
    renderFindings();
  }

  // --- olaylar ---
  document.querySelectorAll('nav.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('section.panel').forEach((p) => {
        p.classList.toggle('active', p.id === `panel-${btn.dataset.tab}`);
      });
    });
  });
  ['f-level', 'f-session'].forEach((id) => $(id).addEventListener('change', renderEvents));
  $('f-text').addEventListener('input', renderEvents);
  ['r-status', 'r-sev'].forEach((id) => $(id).addEventListener('change', renderFindings));

  $('stop-all').addEventListener('click', async () => {
    if (!confirm('Açık tüm eğitim sekmelerinde otomatik ilerleme durdurulsun mu? (Sayfa yenilenince yeniden başlar.)')) return;
    try {
      const res = await api.runtime.sendMessage({ type: 'uek-stop-all' });
      toast(`${(res && res.stopped) || 0} sekmede durduruldu.`);
    } catch (_) {
      toast('Durdurma isteği gönderilemedi.');
    }
  });

  $('clear').addEventListener('click', async () => {
    if (!confirm('Tüm rapor kayıtları silinsin mi? (Kod inceleme işaretleri korunur.)')) return;
    try {
      await api.runtime.sendMessage({ type: 'uek-report-clear' });
      toast('Rapor temizlendi.');
    } catch (_) {
      toast('Rapor temizlenemedi.');
    }
    refresh();
  });

  $('export').addEventListener('click', () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: (() => { try { return api.runtime.getManifest().version; } catch (_) { return ''; } })(),
      queue,
      report,
      findings: (globalThis.UEK_FINDINGS || []).map((f) => Object.assign({ verified: !!checked[f.id] }, f)),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `uek-rapor-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.uekReport || changes.uekQueue) refresh();
  });
  // Göreli süreler ("5 sn önce") ve durum eşikleri zamanla değişir
  setInterval(() => renderAll(), 3000);

  refresh().catch(() => toast('Rapor okunamadı.'));
})();

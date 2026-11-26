(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const slotsEl = document.getElementById('slots');
  const linksEl = document.getElementById('links');
  const statusEl = document.getElementById('status');
  const manualEl = document.getElementById('manual');
  const listHead = document.getElementById('list-head');
  const selectAll = document.getElementById('select-all');
  const selectLabel = document.getElementById('select-label');
  const startBtn = document.getElementById('start-tabs');

  let found = [];

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function renderSlots(slots) {
    slotsEl.textContent = '';
    if (!slots.length) {
      slotsEl.innerHTML = '<li class="empty">Kayıtlı ekran yok. Pencereyi monitöre taşıyıp kaydedin.</li>';
      return;
    }
    slots.forEach((slot) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = slot.label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Sil';
      btn.addEventListener('click', () => removeSlot(slot.id));
      li.append(span, btn);
      slotsEl.append(li);
    });
  }

  function renderLinks(items) {
    found = items;
    linksEl.textContent = '';
    if (!items.length) {
      linksEl.innerHTML = '<li class="empty">Bu sayfada eğitim bağlantısı yok. “Gelişmiş” bölümünden bağlantı yapıştırabilirsiniz.</li>';
      updateSelection();
      return;
    }
    items.forEach((item, index) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !item.done;
      box.dataset.index = String(index);
      const wrap = document.createElement('span');
      wrap.className = 'grow';
      const title = document.createElement('div');
      title.className = 't';
      title.textContent = item.title;
      title.title = item.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = item.done ? `Bitmiş · ${shortUrl(item.url)}` : shortUrl(item.url);
      wrap.append(title, meta);
      label.append(box, wrap);
      li.append(label);
      linksEl.append(li);
    });
    updateSelection();
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') + u.pathname;
    } catch (_) {
      return url;
    }
  }

  function updateSelection() {
    const boxes = [...linksEl.querySelectorAll('input[type="checkbox"]')];
    const checked = boxes.filter((box) => box.checked).length;
    const pasted = UEKLinks.parseText(manualEl.value).length;
    const total = checked + pasted;
    listHead.hidden = !boxes.length;
    selectAll.checked = boxes.length > 0 && checked === boxes.length;
    selectAll.indeterminate = checked > 0 && checked < boxes.length;
    selectLabel.textContent = boxes.length ? `Tümünü seç · ${checked}/${boxes.length}` : 'Tümünü seç';
    startBtn.disabled = total === 0;
    startBtn.textContent = total ? `Eş zamanlı başlat (${total})` : 'Eş zamanlı başlat';
  }

  async function loadState() {
    const data = await api.storage.local.get(['uekScreenSlots', 'uekQueue']);
    const slots = data.uekScreenSlots || [];
    const queue = data.uekQueue || [];
    renderSlots(slots);
    setStatus(queue.length ? `Sırada ${queue.length} eğitim var.` : '');
    return { slots, queue };
  }

  async function saveScreen() {
    const win = await api.windows.getCurrent();
    const slot = {
      id: String(Date.now()),
      left: Math.round(win.left || 0),
      top: Math.round(win.top || 0),
      width: Math.round(win.width || 1280),
      height: Math.round(win.height || 800),
      label: `Ekran (${Math.round(win.left || 0)}, ${Math.round(win.top || 0)}) ${Math.round(win.width || 0)}×${Math.round(win.height || 0)}`,
    };
    const data = await api.storage.local.get('uekScreenSlots');
    const slots = data.uekScreenSlots || [];
    const dup = slots.some((s) => Math.abs(s.left - slot.left) < 50 && Math.abs(s.top - slot.top) < 50);
    if (dup) {
      setStatus('Bu monitör konumu zaten kayıtlı.');
      return;
    }
    slots.push(slot);
    await api.storage.local.set({ uekScreenSlots: slots });
    renderSlots(slots);
    setStatus('Ekran kaydedildi. Diğer monitör için pencereyi taşıyıp tekrar kaydedin.');
  }

  async function removeSlot(id) {
    const data = await api.storage.local.get('uekScreenSlots');
    const slots = (data.uekScreenSlots || []).filter((s) => s.id !== id);
    await api.storage.local.set({ uekScreenSlots: slots });
    renderSlots(slots);
  }

  async function scan() {
    setStatus('Sayfa taranıyor…');
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      setStatus('Aktif sekme bulunamadı.');
      return;
    }
    try {
      const res = await api.tabs.sendMessage(tab.id, { type: 'uek-collect-links' }, { frameId: 0 });
      const items = (res && res.links) || [];
      renderLinks(items);
      const done = items.filter((item) => item.done).length;
      setStatus(items.length
        ? (done
          ? `${items.length} eğitim bulundu. ${done} bitmiş olan işaretsiz; açık sekmeye düşerse kapanır.`
          : `${items.length} eğitim bulundu.`)
        : 'Bağlantı bulunamadı. Adresleri alta yapıştırın.');
    } catch (e) {
      renderLinks([]);
      setStatus('Bu sayfadan liste alınamadı. Eğitim adreslerini alta yapıştırın.');
    }
  }

  function selectedItems() {
    const checked = [...linksEl.querySelectorAll('input[type="checkbox"]:checked')]
      .map((box) => found[Number(box.dataset.index)])
      .filter(Boolean);
    return UEKLinks.mergeItems(checked.concat(UEKLinks.parseText(manualEl.value)));
  }

  async function openSelected() {
    const items = selectedItems();
    if (!items.length) {
      setStatus('Açılacak eğitim seçilmedi.');
      return;
    }
    const data = await api.storage.local.get('uekScreenSlots');
    const slots = data.uekScreenSlots || [];
    setStatus('Pencereler açılıyor…');
    try {
      const res = await api.runtime.sendMessage({
        type: 'uek-open-trainings',
        items,
        slots,
      });
      if (res && res.error) throw new Error(res.error);
      const opened = (res && res.opened) || 0;
      const queued = (res && res.queued) || 0;
      const skipped = (res && res.skipped) || 0;
      const skipNote = skipped ? `\n${skipped} eğitim zaten açık veya sırada, atlandı.` : '';
      const waitNote = opened === 0 && queued > 0
        ? '\nKayıtlı ekranlar dolu. Bitince pencereyi kapatın; sıradaki aynı yerde açılır.'
        : '';
      setStatus(`${opened} pencere açıldı. Sırada ${queued} eğitim var.${skipNote}${waitNote}\nHer pencerede otomatik ilerleme kendi içeriğinde çalışır.`);
    } catch (e) {
      setStatus('Pencereler açılamadı. Eklentiyi about:debugging üzerinden yeniden yükleyin.');
    }
  }

  async function startInTabs() {
    const items = selectedItems();
    if (!items.length) {
      setStatus('Başlatılacak eğitim seçilmedi.');
      return;
    }
    setStatus(`${items.length} eğitim ayrı sekmelerde açılıyor…`);
    try {
      const res = await api.runtime.sendMessage({ type: 'uek-open-tabs', items });
      if (res && res.error) throw new Error(res.error);
      const opened = (res && res.opened) || 0;
      const skipped = (res && res.skipped) || 0;
      const failed = (res && res.failed) || 0;
      const skipNote = skipped ? `\n${skipped} eğitim zaten açık, atlandı.` : '';
      const failNote = failed ? `\n${failed} sekme açılamadı.` : '';
      setStatus(`${opened} sekme açıldı. Her eğitim kendi sekmesinde ayrı ilerliyor.${skipNote}${failNote}`);
    } catch (e) {
      setStatus('Sekmeler açılamadı. Eklentiyi about:debugging üzerinden yeniden yükleyin.');
    }
  }

  async function focusSession(session) {
    const res = await api.runtime.sendMessage({
      type: 'uek-focus-session',
      tabId: session.tabId,
      windowId: session.windowId,
      url: session.url,
    });
    if (res && res.ok) {
      window.close();
      return;
    }
    setStatus('Eğitimin sekmesi bulunamadı; kapanmış olabilir.');
  }

  async function clearQueue() {
    await api.runtime.sendMessage({ type: 'uek-clear-queue' });
    setStatus('Sıra temizlendi. Açık pencereler kapanınca yeni eğitim açılmaz.');
  }

  // --- canlı durum kartı (simge tooltip'iyle aynı çekirdek: report-core.js) ---
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function stat(value, label, cls) {
    const node = el('div', `stat ${cls || ''}`.trim());
    node.append(el('b', '', String(value)), el('span', '', label));
    return node;
  }

  async function renderLive() {
    const Core = globalThis.UEKReportCore;
    const data = await api.storage.local.get(['uekReport', 'uekQueue']);
    const sum = Core.summarize(data.uekReport, data.uekQueue || [], Date.now());

    const dot = document.getElementById('live-dot');
    dot.className = `dot ${sum.stalled || sum.nolink || sum.openErrors ? 'bad' : sum.quiz ? 'warn' : sum.running ? 'on' : ''}`.trim();
    document.getElementById('live-updated').textContent =
      `Güncelleme ${new Date().toLocaleTimeString('tr-TR')}`;

    const chips = document.getElementById('live-chips');
    chips.replaceChildren(
      stat(sum.open, 'Açık'),
      stat(sum.running, 'Çalışıyor', sum.running ? 'good' : ''),
      stat(sum.attention, 'Dikkat', sum.attention ? 'bad' : ''),
      stat(sum.queued, 'Sırada', sum.queued ? 'warn' : '')
    );

    const list = document.getElementById('live-list');
    const open = sum.items.filter((i) => !i.closed);
    if (!open.length) {
      list.replaceChildren(el('li', 'empty', sum.items.length
        ? 'Açık eğitim yok.'
        : 'Henüz kayıt yok. Eğitim açılınca burada görünür.'));
      return;
    }
    list.replaceChildren(...open.map((i) => {
      const li = el('li', 'goto');
      const sess = i.session || {};
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.title = 'Bu eğitimin sekmesine git';
      const go = () => focusSession(sess).catch(() => setStatus('Sekmeye geçilemedi.'));
      li.addEventListener('click', go);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          go();
        }
      });
      li.append(el('div', 'row-title', i.title), el('span', `badge ${i.status.cls}`, i.status.label));
      if (i.pct != null) {
        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = `${i.pct}%`;
        bar.append(fill);
        li.append(bar);
      }
      const bits = [];
      if (i.pct != null) bits.push(`%${i.pct}`);
      if (i.slide) bits.push(`slayt ${i.slide}`);
      if (i.main && i.main.hasMedia) bits.push(`${i.main.rate}x${i.main.muted ? '' : ' · SES AÇIK'}`);
      bits.push(`${i.clicks} İLERİ`);
      if (i.status.hint && ['stalled', 'quiz', 'nolink'].includes(i.status.key)) bits.push(i.status.hint);
      li.append(el('div', 'row-meta', bits.join(' · ')));
      return li;
    }));
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.uekReport || changes.uekQueue)) renderLive().catch(() => {});
  });
  // Durum eşikleri (örn. "bağlantı yok") zamanla değişir; heartbeat gelmese de yenile
  setInterval(() => renderLive().catch(() => {}), 3000);

  async function openReport() {
    await api.tabs.create({ url: api.runtime.getURL('report.html') });
    window.close();
  }

  document.getElementById('open-report').addEventListener('click', () => {
    openReport().catch(() => setStatus('Rapor sayfası açılamadı.'));
  });
  document.getElementById('save-screen').addEventListener('click', () => {
    saveScreen().catch(() => setStatus('Ekran kaydedilemedi.'));
  });
  document.getElementById('scan').addEventListener('click', () => {
    scan().catch(() => setStatus('Tarama başarısız.'));
  });
  document.getElementById('open').addEventListener('click', () => {
    openSelected().catch(() => setStatus('Dağıtım başarısız.'));
  });
  startBtn.addEventListener('click', () => {
    startInTabs().catch(() => setStatus('Sekmeler açılamadı.'));
  });
  selectAll.addEventListener('change', () => {
    linksEl.querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = selectAll.checked; });
    updateSelection();
  });
  linksEl.addEventListener('change', updateSelection);
  manualEl.addEventListener('input', updateSelection);
  updateSelection();
  document.getElementById('clear-queue').addEventListener('click', () => {
    clearQueue().catch(() => setStatus('Sıra temizlenemedi.'));
  });

  loadState().catch(() => setStatus('Kayıtlar okunamadı.'));
  renderLive().catch(() => {});
})();

(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const slotsEl = document.getElementById('slots');
  const linksEl = document.getElementById('links');
  const statusEl = document.getElementById('status');
  const manualEl = document.getElementById('manual');

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
      linksEl.innerHTML = '<li class="empty">Bu sayfada eğitim bağlantısı yok. Alta yapıştırabilirsiniz.</li>';
      return;
    }
    items.forEach((item, index) => {
      const li = document.createElement('li');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.index = String(index);
      const wrap = document.createElement('span');
      const title = document.createElement('div');
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = item.url;
      wrap.append(title, meta);
      li.append(box, wrap);
      linksEl.append(li);
    });
  }

  async function loadState() {
    const data = await api.storage.local.get(['uekScreenSlots', 'uekQueue']);
    const slots = data.uekScreenSlots || [];
    const queue = data.uekQueue || [];
    renderSlots(slots);
    const q = queue.length ? `Sırada ${queue.length} eğitim var.` : 'Sıra boş.';
    setStatus(q);
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
      setStatus(items.length ? `${items.length} eğitim bulundu.` : 'Bağlantı bulunamadı. Adresleri alta yapıştırın.');
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

  function chip(text, cls) {
    return el('span', `chip ${cls || ''}`.trim(), text);
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
      chip(`${sum.open} açık`),
      chip(`${sum.running} çalışıyor`, sum.running ? 'good' : ''),
      chip(`${sum.attention} dikkat`, sum.attention ? 'bad' : ''),
      chip(`${sum.queued} sırada`, sum.queued ? 'warn' : ''),
      chip(`${sum.closed} kapandı`)
    );

    const list = document.getElementById('live-list');
    const open = sum.items.filter((i) => !i.closed);
    if (!open.length) {
      list.replaceChildren(el('li', 'empty', sum.items.length
        ? 'Açık eğitim penceresi yok.'
        : 'Henüz kayıt yok. Eğitim sayfası açılınca burada görünür.'));
      return;
    }
    list.replaceChildren(...open.map((i) => {
      const li = el('li');
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
  document.getElementById('start-tabs').addEventListener('click', () => {
    startInTabs().catch(() => setStatus('Sekmeler açılamadı.'));
  });
  document.getElementById('clear-queue').addEventListener('click', () => {
    clearQueue().catch(() => setStatus('Sıra temizlenemedi.'));
  });

  loadState().catch(() => setStatus('Kayıtlar okunamadı.'));
  renderLive().catch(() => {});
})();

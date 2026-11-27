/**
 * Rapor çekirdeği — arka plan (tooltip/rozet), popup ve rapor sayfası paylaşır.
 * Durum çıkarımı tek yerde olsun ki üç ekran aynı sonucu göstersin.
 */
(function (root) {
  'use strict';

  // Heartbeat 4 sn'de bir gelir; arka planda kısılan sayfalar için payı geniş tut
  const FRESH_MS = 45000;
  // İçerik betiğiyle aynı eşik (CONFIG.stuckSlideMs = 3 dk)
  const STALL_SEC = 180;
  const RECENT_ERROR_MS = 5 * 60 * 1000;

  function framesOf(session, now) {
    return Object.entries(session.frames || {})
      .map(([id, f]) => Object.assign({ id }, f))
      .filter((f) => f.stopped || now - (f.seen || 0) <= FRESH_MS);
  }

  /** Oynatıcı çerçevesi: medyası olan > herhangi bir oynatıcı > herhangi bir çerçeve */
  function mainFrame(frames) {
    const players = frames.filter((f) => f.mode !== 'parent');
    return players.find((f) => f.hasMedia) || players[0] || frames[0] || null;
  }

  function statusOf(session, now) {
    if (session.closedAt) {
      return { key: 'closed', label: 'Kapandı', cls: 'b-off', hint: session.closeReason || '' };
    }
    const frames = framesOf(session, now);
    if (!frames.length) {
      return {
        key: 'nolink',
        label: 'Bağlantı yok',
        cls: 'b-warn',
        hint: 'Sayfa yükleniyor olabilir ya da içerik betiği çalışmıyor (site izni?).',
      };
    }
    if (frames.every((f) => f.stopped)) {
      return { key: 'stopped', label: 'Durduruldu', cls: 'b-off', hint: 'Süre/tıklama limiti ya da kullanıcı durdurdu.' };
    }
    if (frames.some((f) => f.quiz && !f.stopped)) {
      return { key: 'quiz', label: 'Sınav bekliyor', cls: 'b-warn', hint: 'Cevabı elle verin.' };
    }
    const main = mainFrame(frames);
    if (main && !main.stopped && (main.held || main.idleSec > STALL_SEC)) {
      return { key: 'stalled', label: 'Takıldı', cls: 'b-bad', hint: `${main.idleSec} sn'dir ilerleme yok.` };
    }
    if (main && main.hasMedia && main.paused === true) {
      return { key: 'paused', label: 'Duraklatıldı', cls: 'b-warn', hint: 'Video durmuş; oynatma yeniden denenecek.' };
    }
    if (main && main.paused === false) {
      return {
        key: 'playing',
        label: 'Oynatılıyor',
        cls: 'b-good',
        hint: main.hidden ? 'Sekme arka planda; oynatma korunuyor.' : '',
      };
    }
    return { key: 'running', label: 'Çalışıyor', cls: 'b-info', hint: 'Geçiş / bekleme.' };
  }

  function sortedSessions(report) {
    return Object.values((report && report.sessions) || {}).sort((a, b) => {
      if (!!a.closedAt !== !!b.closedAt) return a.closedAt ? 1 : -1;
      return b.lastSeen - a.lastSeen;
    });
  }

  /** Tüm sayaçları ve oturum satırlarını tek seferde hesaplar. */
  function summarize(report, queue, now) {
    const sessions = sortedSessions(report);
    const items = sessions.map((s) => {
      const status = statusOf(s, now);
      const frames = framesOf(s, now);
      const main = mainFrame(frames);
      const pct = main && main.duration > 0
        ? Math.min(100, Math.round((main.time / main.duration) * 100))
        : null;
      const platform = (s.platform || (main && main.platform) || '');
      const platformLabel = root.EgitimPlatforms
        ? root.EgitimPlatforms.platformLabel(platform || s.url)
        : (platform ? platform.toUpperCase() : '');
      return {
        session: s,
        id: s.id,
        platform,
        platformLabel,
        title: s.title || 'Eğitim',
        windowId: s.windowId,
        status,
        main,
        pct,
        slide: main && main.slide ? main.slide : '',
        clicks: frames.reduce((n, f) => n + (f.nextClicks || 0), 0),
        closed: !!s.closedAt,
      };
    });
    const count = (...keys) => items.filter((i) => keys.includes(i.status.key)).length;
    const sum = {
      items,
      open: items.filter((i) => !i.closed).length,
      running: count('playing', 'running'),
      attention: count('stalled', 'quiz', 'nolink'),
      stalled: count('stalled'),
      nolink: count('nolink'),
      quiz: count('quiz'),
      paused: count('paused'),
      stopped: count('stopped'),
      closed: count('closed'),
      queued: (queue || []).length,
      nextClicks: items.reduce((n, i) => n + i.clicks, 0),
      warns: 0,
      errors: 0,
      openErrors: 0,
    };
    sessions.forEach((s) => {
      sum.warns += (s.counts && s.counts.warn) || 0;
      sum.errors += (s.counts && s.counts.error) || 0;
      // Rozet yalnız açık pencerelerdeki SON 5 dakikanın hatalarına tepki versin
      if (!s.closedAt) {
        sum.openErrors += (s.events || []).filter((e) => e.lvl === 'error' && now - e.ts < RECENT_ERROR_MS).length;
      }
    });
    return sum;
  }

  const SYMBOL = {
    playing: '▶',
    running: '●',
    paused: '⏸',
    quiz: '?',
    stalled: '⚠',
    nolink: '×',
    stopped: '■',
    closed: '✓',
  };

  function clip(text, n) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  /** Araç çubuğu simgesinin üzerine gelince görünen çok satırlı özet. */
  function tooltipText(sum) {
    const lines = ['egitimSavar'];
    const openItems = sum.items.filter((i) => !i.closed);
    if (!openItems.length && !sum.queued) {
      lines.push('Şu an takip edilen eğitim yok.');
      if (sum.closed) lines.push(`✓ ${sum.closed} eğitim penceresi kapandı`);
      return lines.join('\n');
    }
    const parts = [];
    if (sum.running) parts.push(`${sum.running} çalışıyor`);
    if (sum.attention) parts.push(`${sum.attention} dikkat gerektiriyor`);
    if (sum.stopped) parts.push(`${sum.stopped} durdu`);
    if (sum.queued) parts.push(`${sum.queued} sırada`);
    if (sum.closed) parts.push(`${sum.closed} kapandı`);
    if (parts.length) lines.push(parts.join(' · '));
    if (sum.errors || sum.warns) lines.push(`${sum.errors} hata · ${sum.warns} uyarı`);
    if (openItems.length) lines.push('');
    openItems.slice(0, 6).forEach((i) => {
      const pct = i.pct != null ? ` %${i.pct}` : '';
      const slide = i.slide ? ` · slayt ${i.slide}` : '';
      lines.push(`${SYMBOL[i.status.key] || '●'} ${clip(i.title, 34)} — ${i.status.label}${pct}${slide}`);
    });
    if (openItems.length > 6) lines.push(`+${openItems.length - 6} pencere daha`);
    lines.push('', 'Ayrıntı için tıklayın.');
    return lines.join('\n');
  }

  /** Simge rozeti: sayı + duruma göre renk. */
  function badgeFor(sum) {
    if (!sum.open) {
      return { text: sum.queued ? String(sum.queued) : '', color: '#6b7280' };
    }
    if (sum.stalled || sum.nolink || sum.openErrors) return { text: '!', color: '#d93025' };
    if (sum.quiz) return { text: '?', color: '#f29900' };
    return { text: String(sum.open), color: '#1a7f37' };
  }

  root.UEKReportCore = {
    FRESH_MS,
    STALL_SEC,
    framesOf,
    mainFrame,
    statusOf,
    sortedSessions,
    summarize,
    SYMBOL,
    tooltipText,
    badgeFor,
  };
})(globalThis);

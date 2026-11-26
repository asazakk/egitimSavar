/**
 * Kod inceleme bulguları (v1.4.4 → v1.5.0). Rapor sayfasındaki "Kod inceleme" sekmesi bunu gösterir.
 * status: 'fixed' (düzeltildi) | 'note' (bilgi / bilinen sınırlama)
 * severity: 'high' | 'medium' | 'low'
 */
globalThis.UEK_FINDINGS = [
  {
    id: 'F01',
    severity: 'high',
    status: 'fixed',
    file: 'content.js',
    title: 'ScormV2 üst sayfası "scorm" moduna düşüyordu',
    problem:
      'detectMode() önce URL\'de "SCORM" geçip geçmediğine bakıyordu. ScormV2 üst sayfasının adresi bunu içerdiği için üst çerçeve (içinde #ScoFrame iframe\'i olan sayfa) "scorm" modunda çalışıyor, sayfa chrome\'unda medya ve "geçiş tıkı" arıyordu; "parent" modu hiç devreye girmiyordu.',
    fix: '#ScoFrame varlığı artık URL kontrolünden önce bakılıyor; böyle sayfalar "parent" modunda yalnızca "izlemeye devam" onayını izler.',
  },
  {
    id: 'F02',
    severity: 'high',
    status: 'fixed',
    file: 'content.js',
    title: 'Türkçe harflerde metin eşleştirme çalışmıyordu (İLERİ, ÇIKIŞ)',
    problem:
      'JavaScript\'te /ileri/i "İLERİ" ile, "ÇIKIŞ".toLowerCase() ise "çıkış" ile eşleşmez. Bu yüzden İLERİ etiketi bulunamayabiliyor, "Çıkış" gibi tehlikeli düğmeleri engelleyen kontrol büyük harfli etiketlerde işlemiyor, sınav/Sıra Sizde tespiti büyük harfli metinlerde kaçıyordu.',
    fix: 'fold() yardımcı fonksiyonu eklendi (İ/I/ı → i, küçük harf, aksan sil). Tüm metin eşleştirmeleri (İLERİ, Kontrol Et, Doğru Cevabı Gör, çıkış engeli, modal, sınav, geçiş alanları) bu normalize metin üzerinden yapılıyor.',
  },
  {
    id: 'F03',
    severity: 'high',
    status: 'fixed',
    file: 'content.js',
    title: '"İzlemeye devam" onayı her SweetAlert onayını tıklıyordu',
    problem:
      'clickContinueModals() koşulu "devam metni VEYA .swal-button--confirm var" idi. İkinci kısım yüzünden çıkış / ana sayfa onayı dahil her SweetAlert diyaloğunun "Evet" düğmesi tıklanabiliyordu. Ayrıca [class*="swal"] seçicisi aynı diyaloğu overlay + modal olarak iki kez işliyordu.',
    fix: 'Yalnızca "izlemeye devam / hâlâ izliyor musunuz" türü diyaloglar onaylanıyor; çıkış/ana sayfa/oturum kapatma metni geçen diyaloglar atlanıyor; tıklamalar arasında bekleme süresi var.',
  },
  {
    id: 'F04',
    severity: 'high',
    status: 'fixed',
    file: 'content.js',
    title: 'Video.js eğitimlerinde sıradaki derse hiç geçilmiyordu',
    problem:
      'goNextVideoJsMenu() yazılmıştı ama hiçbir yerden çağrılmıyordu. Video bitince Video.js sayfasında Storyline İLERİ düğmesi aranıyor, bulunamıyor ve "İLERİ henüz kilitli" yazıp sonsuza dek bekleniyordu.',
    fix: 'Video bitince advanceVideoJs() çağrılıyor. Tıklama sonrası sayfa yenilenirken tekrar tıklamayı önlemek için 4 sn kilit, İLERİ sayacı ve "sıradaki ders yok → tamamlanmış olabilir" raporu eklendi. Menü bağlantıları yalnızca başka bir UEK oynatıcı adresiyse tıklanıyor (katalog/ana sayfa/harici link tıklanmaz).',
  },
  {
    id: 'F05',
    severity: 'medium',
    status: 'fixed',
    file: 'content.js',
    title: 'İLERİ açık olunca video bitmeden geçiliyordu',
    problem:
      'tick() İLERİ düğmesi açık görünür görünmez tıklıyordu. İLERİ\'si baştan açık olan slaytlarda video izlenmeden geçilir, eğitim ilerlemesi sayılmayabilirdi.',
    fix: 'Medya oynuyorsa (döngülü arka plan sesi hariç) bitene kadar bekleniyor. Takılma olmasın diye bekleme süresi, video süresi/hız × 1,5 + 20 sn ile sınırlı; aşılırsa uyarı verip ilerliyor.',
  },
  {
    id: 'F06',
    severity: 'medium',
    status: 'fixed',
    file: 'content.js',
    title: 'Sekme görünürlük geçersiz kılma Firefox\'ta etkisizdi',
    problem:
      'document.hidden / visibilityState içerik betiğinin izole dünyasında tanımlanıyordu; sayfanın kendi betikleri bundan etkilenmiyordu. Ama log "uygulandı" diyordu. Pencere örtülünce Firefox oynatmayı durdurabilirdi.',
    fix: 'document.wrappedJSObject + exportFunction ile sayfa nesnesi değiştiriliyor, sonuç doğrulanıp raporlanıyor. visibilitychange olayı window capture aşamasında kesiliyor.',
  },
  {
    id: 'F07',
    severity: 'medium',
    status: 'fixed',
    file: 'content.js',
    title: 'Durdurulan betik olay dinleyicileriyle ilerlemeyi sürdürebiliyordu',
    problem:
      'player.on("ended") ile bağlanan dinleyiciler stop() ile kaldırılmıyordu; durdurulmuş betik video bitince yine İLERİ tıklayabilirdi.',
    fix: 'onMediaEnded / onMediaPause durdurulmuşsa çıkıyor.',
  },
  {
    id: 'F08',
    severity: 'medium',
    status: 'fixed',
    file: 'content.js',
    title: 'Yeni medyada ilerleme sayacı sıfırlanmıyordu',
    problem:
      'lastMediaTime yeni video bağlanınca sıfırlanmıyordu. Önceki videonun süresi yeni videodan büyükse ilerleme "yok" sanılıp 3 dk sonra "slayt takıldı" kararı verilebiliyordu.',
    fix: 'Yeni medya bağlanınca lastMediaTime ve bekleme sayaçları sıfırlanıyor. Video.js modunda da ilerleme izleniyor.',
  },
  {
    id: 'F09',
    severity: 'medium',
    status: 'fixed',
    file: 'content.js',
    title: 'MutationObserver her değişimde ağır tarama yapıyordu',
    problem:
      'Storyline animasyonları çok sayıda class değişimi üretir. Her mutasyonda muteAll(), medya çözümleme ve modal taraması çalışıyor, CPU\'yu gereksiz yoruyordu.',
    fix: 'Tüm ağır işler en çok 200 ms\'de bir çalışacak şekilde tek zamanlayıcıya alındı.',
  },
  {
    id: 'F10',
    severity: 'medium',
    status: 'fixed',
    file: 'background.js',
    title: 'Dağıtımda sıra ters dönüyor, kayıtsız ekranda pencere sayısı sınırsızdı',
    problem:
      'openTrainings() yeni eğitimleri bekleyen kuyruğun önüne koyuyordu (sıra bozuluyor, eskiler aç kalıyordu). Kayıtlı ekran yokken her dağıtımda 3 pencere daha açılıyordu. Boşalan yer varken bekleyenler yeni dağıtım yapılana kadar açılmıyordu.',
    fix: 'Sıra korunuyor (bekleyenler önce). Kayıtsız modda toplam açık pencere 3 ile sınırlı. Boşalan ekranlara bekleyenler dağıtımda doldurulur. Başarısız açılışlar kuyruğun başına döner.',
  },
  {
    id: 'F11',
    severity: 'low',
    status: 'fixed',
    file: 'content.js',
    title: 'sendMessage hataları yakalanmıyordu',
    problem:
      'runtime.sendMessage bir Promise döndürür; try/catch bunun reddini yakalamaz. Arka plan uyurken/eklenti yenilenirken konsola "Unhandled promise rejection" düşüyordu.',
    fix: 'Tüm gönderimler .catch ile sarıldı.',
  },
  {
    id: 'F12',
    severity: 'low',
    status: 'fixed',
    file: 'content.js',
    title: 'tick() içindeki hata kaynağı görünmüyordu',
    problem: 'Beklenmeyen bir istisna konsola düşüyor, rapor/kullanıcı hiçbir şey görmüyordu.',
    fix: 'safeTick() hatayı yakalar, aynı hatayı 30 sn\'de bir "error" olarak rapora yazar. Eklentinin kendi betik hataları da rapora düşer.',
  },
  {
    id: 'F13',
    severity: 'low',
    status: 'fixed',
    file: 'content.js',
    title: 'Ölü yapılandırma ve sürüm uyuşmazlığı',
    problem:
      'seekNearEndVideoJs, enableScormHotspots, maxHotspotsPerTick hiçbir yerde kullanılmıyordu. Başlangıç logundaki sürüm sabit "v1.4.4" idi.',
    fix: 'Kullanılmayan ayarlar silindi; sürüm manifest\'ten okunuyor.',
  },
  {
    id: 'F14',
    severity: 'low',
    status: 'fixed',
    file: 'README.md / content.js',
    title: 'Konsoldan durdurma Firefox\'ta çalışmıyordu',
    problem:
      'README "window.__uekExt.stop()" öneriyordu; Firefox\'ta sayfa konsolu içerik betiğinin izole dünyasını göremez.',
    fix: 'Rapor sayfasına "Tümünü durdur" düğmesi eklendi (tüm çerçevelere uek-stop mesajı gider).',
  },
  {
    id: 'F15',
    severity: 'high',
    status: 'fixed',
    file: 'content.js',
    title: 'Video içi "Gönder" ekranı eğitimi duraklatıyordu',
    problem:
      'Videonun ortasında çıkan soru/anket "Gönder"e basılana kadar oynatmayı durdurur. Eklenti bu düğmeyi tanımıyordu; oynatma her seferinde yeniden başlatılsa da ekran kapanmadığı için eğitim ilerlemiyordu (İLERİ açık görünüyorsa video bitmeden bekleme döngüsüne de giriyordu).',
    fix: 'handleGonder() eklendi: Gönder/Submit düğmesi bulunup tıklanıyor; pasifse önce sırayla bir seçenek işaretleniyor. İLERİ ve medya beklemesinden önce çalışır. Ekran başına 12 deneme sınırı var; aşılırsa rapora uyarı düşer. İçinde "sınav" geçen gerçek sınav formlarında otomatik gönderilmez.',
  },
  {
    id: 'F16',
    severity: 'high',
    status: 'fixed',
    file: 'page-guard.js / content.js',
    title: 'Başka sekmeye geçince eğitim duruyordu',
    problem:
      'Sekme arka plana alınınca sayfanın kendi betikleri videoyu duraklatıyordu. Önceki düzeltme (document.hidden değerini izole dünyada wrappedJSObject ile değiştirmek) sayfanın pause() çağrılarını ve window blur olaylarını yakalamıyordu.',
    fix: 'Yeni page-guard.js sayfa dünyasında (world: MAIN, document_start) çalışır: document.hidden ve visibilityState sayfaya "görünür" döner; visibilitychange ve pencere blur olayları sayfaya ulaşmadan kesilir; sekme GERÇEKTEN arka plandayken gelen pause() çağrıları yok sayılır (kullanıcı arka plandayken etkileşemeyeceği için bunlar sayfanın kendi duraklatmasıdır). Gerçek görünürlük durumu içerik betiğine iletilir; raporda "Sekme arka planda; oynatma korunuyor" görünür ve kaç duraklatma engellendiği kalp atışında yazılır. Form alanlarının blur olayları korunur.',
  },
  {
    id: 'F17',
    severity: 'high',
    status: 'fixed',
    file: 'page-guard.js',
    title: 'Sekme değişince eğitim hâlâ duruyordu (F16 eksik kaldı)',
    problem:
      'F16 yalnız document.hidden, visibilitychange, blur ve pause() yollarını kapatıyordu. Sayfa "document.hasFocus()" yokluyorsa duraklatabiliyordu. Ayrıca tarayıcı arka planda requestAnimationFrame\'i durdurur; Storyline zaman çizelgesi buna bağlı olduğundan slayt, video çalışsa bile ilerlemiyordu. Chrome ayrıca 5 dk sonra arka plan zamanlayıcılarını dakikada 1\'e düşürür.',
    fix: 'hasFocus() her zaman true döner; webkit/moz önekli görünürlük alanları da sahtelenir; document blur\'ü de kesilir. Sekme gizliyken bekleyen requestAnimationFrame geri çağrıları 250 ms\'lik bir zamanlayıcıyla yürütülür. Chrome\'un yoğun kısıtlamasından kaçınmak için sayfa bir Web Lock tutar.',
  },
  {
    id: 'F18',
    severity: 'high',
    status: 'fixed',
    file: 'page-guard.js / content.js / background.js',
    title: 'Sekme değişince sessiz video duruyordu; bitmiş eğitim sekmesi açık kalıyordu',
    problem:
      'F17 zamanlayıcıyı ve requestAnimationFrame\'i ayakta tutuyordu ama Chrome ve Firefox sessiz (muted) videoyu gizli sekmede medya motorunda durduruyor. pause() yok saymak bunu engellemiyor. Ayrıca eş zamanlı açılan eğitimlerin bir kısmı zaten bitmiş oluyor ve sekmesi açık kalıyordu.',
    fix: 'Sekme gizliyken video susturulmuyor; ses kısık (0.02) bırakılıyor, tarayıcının kendi pause\'u hemen play() ile geri alınıyor. Kare pompası kısılan setInterval yerine worker saatinde. Bitmiş eğitim (kabukta "tekrar katıl" / tamamlandı yazısı, tüm üniteler işaretli ya da video bitip sıradaki ders yok) birkaç saniye doğrulanınca eklentinin açtığı sekme kapanıyor. Katalog taramasında bitmiş görünenler işaretsiz gelir.',
  },
  {
    id: 'N01',
    severity: 'low',
    status: 'note',
    file: 'content.js',
    title: 'videojs / GetPlayer sayfa global\'larına erişilemez (bilinen sınırlama)',
    problem:
      'İçerik betiği izole dünyada çalıştığı için videojs ve GetPlayer() çağrıları her zaman "tanımsız" çıkar. Kod şu an DOM yedeğine (video/audio elemanı, #slide öznitelikleri) düşüyor ve işlevi bundan etkilenmiyor.',
    fix: 'Davranış korundu. Gerekirse ileride Firefox 128+ için content_scripts "world: MAIN" kullanılabilir.',
  },
  {
    id: 'N02',
    severity: 'medium',
    status: 'note',
    file: 'manifest.json',
    title: 'Firefox MV3\'te site izni elle verilmesi gerekebilir',
    problem:
      'Firefox 127 öncesinde MV3 eklentilerinin host_permissions izinleri kurulumda otomatik verilmez. İçerik betiği hiç çalışmıyorsa rapor sayfasında "bağlantı yok" görünür.',
    fix: 'about:addons → eklenti → İzinler sekmesinden site erişimini açın.',
  },
  {
    id: 'N03',
    severity: 'low',
    status: 'note',
    file: 'content.js',
    title: '"Sıra Sizde" sorularını otomatik cevaplıyor',
    problem:
      'handleSiraSizde() seçenek işaretler, Kontrol Et ve Doğru Cevabı Gör düğmelerine basar. Bu bilinçli bir özellik olarak bırakıldı; platformun kullanım koşullarına uygunluk kullanıcının sorumluluğundadır.',
    fix: 'Davranış değiştirilmedi. Gerçek sınav formu algılanırsa durum "Sınav bekliyor" olarak raporlanır.',
  },
];

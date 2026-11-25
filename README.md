# egitimSavar

<img src="icons/icon-128.png" alt="egitimSavar" width="64" align="right">

Uzaktan Eğitim Kapısı eğitimlerini otomatik izler (Firefox + Chrome): ScormV2 (cross-origin Storyline) ve Video.js sayfalarında videoyu hızlandırır, sesi kapatır, İLERİ ile sıradakine geçer, "izlemeye devam" onayını verir, video içi **Gönder** ekranlarını geçer. Gerçek sınavda durur. Simge üzerinde ve rapor sayfasında canlı takip sunar.

Aynı klasör Chrome'da da çalışır (aşağıdaki "Chrome" bölümüne bakın).

## Kurulum (geçici / geliştirme)

1. Firefox’ta `about:debugging#/runtime/this-firefox` açın
2. **Geçici Eklenti Yükle…** → bu klasördeki `manifest.json` dosyasını seçin
3. `about:addons` → eklenti → **İzinler**: site erişimi kapalıysa açın (Firefox MV3'te site izinleri otomatik verilmeyebilir)
4. Eğitim sekmesini yenileyin. Konsola betik yapıştırmayın; eklenti Storyline çerçevesinde kendiliğinden başlar.
5. Eklenti simgesi → **Raporu aç**: pencere durumunu görün (aşağıya bakın)

> Geçici eklenti Firefox kapanınca kalkar; her oturumda yeniden yüklemeniz gerekir.

## Chrome (geliştirici modu)

1. Chrome'da `chrome://extensions` sayfasını açın.
2. Sağ üstte **Geliştirici modu**nu açın.
3. **Paketlenmemiş öğe yükle** → bu klasörü seçin (`manifest.json` kökte olmalı).
4. Eklenti kartında site erişimini "Belirli sitelerde" ya da "Tüm sitelerde" olarak bırakın.
5. Eğitim sekmesini yenileyin. Rapor için eklenti simgesi → **Raporu aç**.

Chrome'da görünürlük geçersiz kılma (sekme arka plana geçse de oynatmanın sürmesi) uygulanmaz; bu yalnız Firefox'a özgüdür. Pencereler ayrı olduğu sürece oynatma normal çalışır.

## Kalıcı yükleme (isteğe bağlı)

1. Paketi üretin: `npx web-ext build --source-dir .` → `web-ext-artifacts/` içinde `.zip` çıkar. Bu dosyanın adını `.xpi` yapın.
2. `about:addons` → dişli simgesi → **Dosyadan eklenti yükle…** → `.xpi` dosyasını seçin.
   - Klasörü, `manifest.json` dosyasını ya da içinde üst klasör bulunan bir zip'i seçerseniz Firefox "bozuk" uyarısı verir. Paket kökünde `manifest.json` olmalıdır.
   - Firefox sürümünüz imzasız eklentiyi reddederse "doğrulanamadı" uyarısı çıkar. Bu durumda AMO'da imzalatın ya da Firefox Developer / ESR'de `xpinstall.signatures.required` ayarını kapatın (yalnızca bilinçli kullanım).
3. Günlük kullanım için `about:debugging` ile geçici yükleme daha pratiktir (yukarıdaki kurulum).

## Kullanım

- Sekmeyi açık tutun
- Durdurmak: rapor sayfasında **Tümünü durdur** (Firefox'ta `window.__uekExt.stop()` sayfa konsolundan çalışmaz)
- Sınav çıktığında elle cevap verin

## v1.6.1 — arka plan oynatması

- **Sekme değişince durma düzeltildi:** Eğitim sayfası başka sekmeye geçildiğinde kendi kendini duraklatıyordu. Yeni `page-guard.js` sayfa dünyasında çalışıyor: sayfaya "görünür" durumu bildiriyor, görünürlük ve pencere blur olaylarını kesiyor ve sekme gerçekten arka plandayken gelen duraklatmaları yok sayıyor. Ayrıntı: rapor → **Kod inceleme** → F16.
- Rapor, arka plan geçişlerini ve engellenen duraklatma sayısını gösterir.
- **Firefox 128 veya üzeri gerekir** (`world: MAIN` içerik betikleri bu sürümden itibaren destekleniyor).

## v1.6.0 — egitimSavar

- Proje adı **egitimSavar** oldu (eklenti adı, simge, popup, rapor, konsol etiketi `[egitimSavar]`). Yeni simge: `icons/` (kaynak: `icon.svg`).
- **Video içi "Gönder":** videonun ortasında çıkıp oynatmayı duraklatan soru/anket ekranındaki **Gönder** düğmesi otomatik tıklanır. Düğme pasifse (seçim yapılmadan açılmıyorsa) önce sırayla bir seçenek işaretlenir. Ekran başına en çok 12 deneme yapılır; aşılırsa rapora "elle tıklayın" uyarısı düşer. İçinde "sınav" geçen gerçek sınav formlarında otomatik gönderilmez.
- Eklenti kimliği `egitimsavar@local` oldu; Firefox bunu yeni bir eklenti sayar. Eski "UEK Otomatik İzleyici"yi kaldırın.
- İç anahtarlar (`storage` anahtarları `uek*`, mesaj türleri `uek-*`, `window.__uekExt`) kayıtlı ekranlar kaybolmasın diye aynı bırakıldı.

## Simge üzerinde canlı özet (v1.5.1)

- **Simgenin üzerine gelince:** çok satırlı özet görünür (kaç pencere çalışıyor / dikkat gerektiriyor / sırada / kapandı, her pencerenin durumu, medya yüzdesi, slayt). Tarayıcılar fare üzerine gelince yalnız düz metin tooltip'e izin verir; zengin panel için simgeye tıklayın.
- **Rozet:** yeşil sayı = çalışan pencere sayısı, kırmızı `!` = takılan / bağlantısı kesilen / son 5 dakikada hata veren pencere var, turuncu `?` = sınav elle cevap bekliyor, gri sayı = yalnız sırada bekleyen var.
- **Simgeye tıklayınca:** popup'ın üstünde canlı durum kartı (çipler, pencere başına durum ve ilerleme çubuğu). Kendiliğinden yenilenir.
- Tooltip ve rozet, `alarms` izniyle 30 sn'de bir yenilenir; böylece heartbeat kesilen pencereler de görünür.

## Rapor sayfası (v1.5.0)

Araç çubuğu simgesi → **Ayrıntılı raporu aç** (`report.html`). Kendiliğinden yenilenir.

- **Canlı takip:** her eğitim penceresi için durum (Oynatılıyor / Çalışıyor / Sınav bekliyor / Takıldı / Bağlantı yok / Durduruldu / Kapandı), slayt, medya ilerlemesi, hız, ses durumu, İLERİ sayısı, süre ve son sinyal. Satıra tıklayınca o pencerenin zaman çizelgesi açılır. Sırada bekleyen eğitimler altta listelenir.
- **Olay günlüğü:** tüm pencerelerin olayları; seviye, pencere ve metne göre süzülür.
- **Kod inceleme:** v1.4.4 incelemesinde bulunan hatalar, çözümleri ve bilinen sınırlamalar. Her madde "Doğruladım" diye işaretlenebilir (işaretler kalıcıdır).
- **JSON dışa aktar / Raporu temizle / Tümünü durdur** düğmeleri.

Rapor verisi `storage.local` içinde tutulur (en çok 40 pencere, pencere başına son 300 olay).

## Birden fazla ekran (v1.4.0)

Araç çubuğundaki eklenti simgesi:

1. Firefox penceresini bir monitöre taşıyın → **Bu ekranı kaydet**. Diğer monitörler için tekrarlayın.
2. Katalog sekmesinde **Bu sayfadaki eğitimleri bul** (veya adresleri yapıştırın).
3. **Seçilenleri ekranlara dağıt.** Her kayıtlı ekranda bir pencere açılır; fazlası sıraya girer.
4. Eğitim bitince o pencereyi kapatın. Sıradaki, aynı ekran konumunda açılır.

Kayıtlı ekran yoksa en fazla 3 pencere bu monitörde açılır. Ayrı penceredeki sekme arka plan sekmesi sayılmaz; otomatik ilerleme her pencerede ayrı çalışır.

## Chrome’dan farklar

| | Chrome | Firefox |
|--|--|--|
| Background | `service_worker` (ve `scripts`, Firefox yok sayar) | `background.scripts` (`service_worker` yok sayılır) |
| Kimlik | yok | `browser_specific_settings.gecko.id` |
| Yükleme | `chrome://extensions` paketlenmemiş öğe | `about:debugging` geçici eklenti |

## v1.5.0

Kod incelemesi + rapor sayfası. Öne çıkan düzeltmeler: Türkçe harf (İLERİ/ÇIKIŞ) eşleştirme hatası, ScormV2 üst sayfasının yanlış modda çalışması, her SweetAlert onayının tıklanması, Video.js'te sıradaki derse geçilmemesi, videoyu izlemeden İLERİ'ye basılması, dağıtım sırasının bozulması. Ayrıntı: rapor sayfası → **Kod inceleme**.

## v1.4.4

Yükleyip eğitim sekmesini yenilemek yeter. İLERİ yalnız açıkken basılır. Kilitliyken sekme, açılır panel ve “tıklayın / devam” alanları tıklanır. Sıra Sizde: seçenek → Kontrol Et → Doğru Cevabı Gör. Aynı slaytta 3 dakika ilerleme yoksa zorunlu tık durur. Durdurmak: `window.__uekExt.stop()`

## v1.3.1 (Sıra Sizde)

İLERİ, Sıra Sizde’de seçenek işaretlenmeden açılmıyor. Eklenti:

1. `acc-checkbox` / seçenekleri işaretler  
2. **Kontrol Et** tıklar  
3. Gerekirse **Doğru Cevabı Gör**  
4. İLERİ açılınca soft click

## v1.3.0 (SCORM Anasayfa düşmesi)

- SCORM hızı 4x, rastgele hotspot kapalı
- İLERİ yalnız açıkken soft click
- Ana Sayfa / çıkış tıklama engeli


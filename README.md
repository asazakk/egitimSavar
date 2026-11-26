<p align="center">
  <img src="icons/icon-128.png" alt="egitimSavar" width="128">
</p>

<h1 align="center">egitimSavar</h1>

<p align="center">
  Uzaktan Eğitim Kapısı videolarını senin yerine izler.<br>
  <b>Firefox 128+</b> · <b>Chrome 111+</b>
</p>

---

## Ne yapar

- Videoyu hızlandırır, sesi kapatır, **İLERİ**'ye basar
- Video içi **Gönder** ve “izlemeye devam” ekranlarını geçer
- Sekme arkadayken de oynatmaya devam eder
- Gerçek sınavda durur; cevap sende
- Birden fazla monitöre eğitim dağıtır
- Canlı durumu simgede ve raporda gösterir

## Kurulum

### Firefox

Geçici yükleme; Firefox kapanınca silinir.

1. Adres çubuğuna `about:debugging#/runtime/this-firefox` yaz
2. **Geçici Eklenti Yükle…** → bu klasördeki `manifest.json`
3. `about:addons` → egitimSavar → **İzinler** → site erişimini aç
4. Eğitim sekmesini yenile

### Chrome

Kalıcıdır.

1. Adres çubuğuna `chrome://extensions` yaz
2. **Geliştirici modu**nu aç → **Paketlenmemiş öğe yükle** → bu klasör
3. Eğitim sekmesini yenile

> Eski **UEK Otomatik İzleyici** yüklüyse kaldır.

## Kullanım

Eğitim sekmesini aç, bırak. Simgeye tıklayınca canlı durum görünür.

| Simge | Anlam |
|---|---|
| Yeşil sayı | Çalışan pencere |
| Turuncu `?` | Sınav, cevap bekliyor |
| Kırmızı `!` | Takıldı ya da hata |
| Gri sayı | Sırada bekleyen |

**Durdurmak için:** simge → **Ayrıntılı raporu aç** → **Tümünü durdur**.

## Birden fazla ekran

1. Pencereyi bir monitöre taşı → **Bu ekranı kaydet** (her monitör için tekrarla)
2. Katalogda **Bu sayfadaki eğitimleri bul**
3. **Seçilenleri ekranlara dağıt**

Eğitim bitince pencereyi kapat; sıradaki aynı ekranda açılır. Kayıtlı ekran yoksa en fazla 3 pencere açılır.

## Rapor

Canlı takip, olay günlüğü ve kod inceleme notları. **JSON dışa aktar**, **Raporu temizle**, **Tümünü durdur** düğmeleri var. Son 40 pencere ve pencere başına son 300 olay saklanır.

## Kalıcı Firefox paketi

```
npx web-ext build --source-dir .
```

`web-ext-artifacts/` içindeki `.zip` dosyasını `.xpi` yap → `about:addons` → dişli → **Dosyadan eklenti yükle…**. İmzasız paket reddedilirse AMO'da imzalat.

## Sürüm notları

<details>
<summary><b>1.7.6</b> · kapaktaki oynat düğmesi</summary>

- Açılıştaki beyaz daire Video.js değil; `svg.play-icon` (`data-dv_ref="playIcon"`). Bu ikona ve üzerindeki düğmeye basılıyor, video sessiz başlıyor
- `clickPlayOverlay` artık hem ikonun hem de üst düğmenin tıklama sonucunu birlikte değerlendiriyor (yalnız host sonucunu döndürmüyor); ikon ile host aynı öğeyse ikinci kez tıklanmıyor
- `page-guard.js` içindeki `press()`, `getBoundingClientRect()` başarısız olursa (0,0) koordinatlı sahte fare/işaretçi olayları yollamak yerine yalnızca `el.click()` çağırıyor

</details>

<details>
<summary><b>1.7.2</b> · açılan videolar tam sesle çalmıyor</summary>

- Yeni açılan video varsayılan sesle (1) başlıyor ve sayfa sesi tekrar yükseltiyordu. Artık sayfa dünyasında ses zorlanır: öndeki sekmede 0, arkadaki sekmede en fazla 0.02
- Storyline `SetVolume` ve Video.js aynı politikayla kısılır
- Video eklendiğinde (MutationObserver, `play` olayı, 400 ms tarama) politika hemen uygulanır

</details>

<details>
<summary><b>1.7.1</b> · bitmiş eğitimin sekmesi kapanır</summary>

- Eğitim bitince (kabukta “tekrar katıl” ya da tamamlandı yazısı, tüm üniteler işaretli ya da video bitip sıradaki ders yok) birkaç saniye doğrulanır ve eklentinin açtığı sekme kapanır. Devam eden eğitimlere dokunulmaz
- Gizli sekmede sessiz video durmasın diye ses kısık (0.02) tutulur; tarayıcının `pause()` çağrısı hemen geri alınır. Kare pompası worker saatinde çalışır
- Katalog taramasında bitmiş görünen eğitimler işaretsiz gelir; açık sekmeye düşerlerse kapanır

</details>

<details>
<summary><b>1.7.0</b> · oturum ve sekme yönetimi</summary>

- Rapor ekranına **Sekmeye git** düğmesi eklendi. Sekme kimliği, pencere veya adres (`Uniq`) ile bulunur; sekme yoksa adresi yeni sekmede açılır
- Yeni açılan sekmeler kısa süre öne alınır (tarayıcı medyayı engellemesin diye), ardından kullanıcının sekmesine dönülür
- Gizli sekmede zamanlayıcılar kısıtlanmaz; `page-guard` zamanlayıcıları worker saatine taşır, ses bağlamı sessiz tutulur
- Popup’ta eğitim seçimi ve bağlantı işaretleme iyileştirildi

</details>

<details>
<summary><b>1.6.3</b> · sekmede eş zamanlı başlatma</summary>

- Popup’a **Eş zamanlı başlat** eklendi: işaretli her eğitim ayrı sekmede açılır ve diğerlerinden bağımsız ilerler
- Eklentinin açtığı sekmeler takip edilir; sekme kapanınca rapora yansır
- Zaten açık olan eğitimler tekrar açılmaz

</details>

<details>
<summary><b>1.6.2</b> · arka plan oynatma, yeni simge</summary>

- Sekme değişince eğitimin durması giderildi: `hasFocus()` yoklaması, arka planda duran `requestAnimationFrame` ve Chrome'un zamanlayıcı kısıtlaması ele alındı
- Yeni simge

</details>

<details>
<summary><b>1.6.1</b> · arka planda oynatma</summary>

`page-guard.js` sayfaya “görünür” der, blur olaylarını keser, arkadayken gelen duraklatmaları yok sayar.

</details>

<details>
<summary><b>1.6.0</b> · egitimSavar</summary>

Yeni ad ve arayüz. Video ortasındaki **Gönder** otomatik geçilir. Kimlik `egitimsavar@local`; eski eklentiyi kaldır.

</details>

<details>
<summary><b>1.5 ve öncesi</b></summary>

Canlı rapor ve rozet, Türkçe İLERİ/ÇIKIŞ eşleşmesi, ScormV2 modu, Sıra Sizde çözümü, ana sayfa/çıkış koruması.

</details>

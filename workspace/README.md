# big-workspace — C Call Depth örnek/test projesi

DO-178C tarzı statik stack analizi denemek için örnek bir C workspace'i.
24 derleme birimi, ~603 fonksiyon, modüller arası çağrılar, bir
fonksiyon-işaretçisi tablosuyla sürülen ISR dağıtıcısı (`dispatch_isr`) ve
derin çağrı zincirleri içerir.

## İçerik

- `app/`, `modules/mod00..mod19/`, `drivers/`, `common/`, `deep/` — C kaynak/başlık
- `fpkinds/` — **farklı function-pointer tipleri** (array tablosu, struct üyesi,
  parametre callback, global pointer, dönen pointer) + hazır `fp-overrides.json`.
  Daraltma/ekleme/koşullu bağlamayı test etmek için. Bkz. `fpkinds/README.md`.
- `deepchain/` — **150 seviyelik düz çağrı zinciri** (`deepchain_root` → 150 kademe).
  Derin call-hierarchy desteğini (per-root depth, path enumerasyonu, graph hop,
  raporda "Max depth") test etmek için.
- `recur/` — **50 özyinelemeli (recursive) fonksiyon**: 21 doğrudan kendine
  çağıran, 20 karşılıklı (A↔B, 10 çift), ~9 üçlü döngü (X→Y→Z→X). Recursion
  tespitini ve özyineleme bölümünü test etmek için. Kök: `recur_root`.
- `manyfp/` — **50 bağlanmamış function-pointer dağıtıcısı** (`many_fp_00..49`),
  her biri override edilmemiş tek bir dolaylı çağrı yapar. "Unbound fp" listesini
  ve tahmini (over-approx) peak'i test etmek için. Kök: `manyfp_root`.
- `peakverify/` — **elle hesaplanabilir peak senaryoları**: düz zincir
  (`pv_lin0..5`), dallanma (`pv_branch` → ağır dalı seçer), elmas (`pv_top` →
  paylaşılan `pv_bottom`). Frame'ler büyük sabit diziler olduğundan
  `gcc -fstack-usage` kesin değer verir; peak doğrulama testi bunları kontrol eder.
- `gen_examples.py` — recur/manyfp/peakverify dosyalarını üreten betik (deterministik).
- `longcycle/` — **tek bir 100-hop özyineleme döngüsü** (`lc_00 → lc_01 → … →
  lc_99 → lc_00`). Yan panelin en-kısa-döngü (BFS) yedeğinin, DFS derinlik
  sınırından çok daha uzun bir gerçek döngüde de tam yolu bulduğunu doğrulamak
  ve grafiğin geri-kenar yönlendirmesini test etmek için. Kök: `longcycle_root`.
- `fpadvanced/` — **zorlu function-pointer template senaryoları**: 3 seviye
  parametre callback (`adv_lvl3_top→mid→bottom→cb()`), çoklu fp parametresi
  (`adv_apply2/3`), struct field ataması (`s.on_event = fn`), array-of-struct fp
  alanı, ve callback forward eden wrapper. fp-overrides şablon önericisinin
  çok-seviyeli ve struct-field çıkarımını test etmek için.
- `fpstruct/` — **runtime struct-field fp atama senaryoları**: koşullu atama
  (`if … d.handler = A; else d.handler = C`), global struct'a bir fonksiyonda
  atama + başka fonksiyonda çağrı, struct-pointer parametresi üzerinden atama
  (config fonksiyonu), ve yeniden atama. Önerici, aynı fonksiyondaki atamalarda
  **kesin**, fonksiyonlar arası (global/pointer) durumlarda **güvenli
  over-approximation** verir (gerçek hedefleri asla kaçırmaz).
- `build/` — GCC'nin ürettiği `.su` (stack-usage) dosyaları
- `compile_commands.json` — derleme veritabanı
- `.vscode/settings.json` — extension ayarları
- `.clangd` — clangd için (opsiyonel; extension clangd değil libclang kullanır)
- `Makefile` — `.su` ve `compile_commands.json`'ı yeniden üretmek için

## Kullanım

1. Bu klasörü VS Code'da aç (`File > Open Folder`).
2. C Call Depth extension'ını kur (`c-call-depth-*.vsix`).
3. Windows'ta libclang.dll'i ayrıca edinip ayarla:
   ```jsonc
   "cCallDepth.libclangPath": "C:\\tools\\libclang"   // DLL'in olduğu klasör
   ```
   (Linux/macOS'ta `pip install libclang` yeterli.)
4. Bir `.c` dosyası aç — satır içi stack/derinlik süslemelerini gör. Yan panel
   ve "Open Call Graph" / "Export Report" komutlarını dene.

Beklenen sonuç: ~603 fonksiyon, `app_main` peak = 4800 bayt,
`dispatch_isr` peak = 1344 bayt (8 fp callee'li).

## İLK KURULUM (önemli)

`compile_commands.json` içindeki `directory` alanı bir **placeholder**
(`REPLACE_WITH_ABSOLUTE_WORKSPACE_PATH`) olarak gelir, çünkü mutlak yol senin
makinende nerede açtığına bağlıdır. Workspace'i açtıktan sonra **bir kez**
derleme veritabanını kendi yoluna göre üret:

```sh
cd <bu-klasör>
make compile_commands.json      # directory'yi gerçek mutlak yolunla doldurur
```

İstersen `.su` dosyalarını da yeniden üretebilirsin (zip'te hazır geliyorlar):

```sh
make                            # her .c'yi -fstack-usage ile derler, build/*.su üretir
```

(GCC gerekir. Windows'ta MinGW/MSYS2 veya WSL kullanabilirsin; ya da
`compile_commands.json`'ı kendi build sisteminden `bear -- make` gibi bir
araçla üretebilirsin.)

## Ayarlar (.vscode/settings.json)

```jsonc
{
  "cCallDepth.suDirectory": "build",
  "cCallDepth.rootPatterns": ["**/public/**", "**/app/**", "**/deep/**"],
  "cCallDepth.fpOverridesPath": "",      // istersen fp-overrides.json yolu
  "cCallDepth.displayMode": "decoration",
  "cCallDepth.pathsMaxDepth": 40
}
```

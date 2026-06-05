# fpkinds — function-pointer bağlama örnekleri

`fpkinds/src/fpkinds.c`, libclang'ın farklı şekillerde gördüğü **beş ayrı
function-pointer çağrı tipini** içerir. Her biri, `fp-overrides.json` ile
daraltma / ekleme / koşullu bağlamayı denemek için tasarlandı. `fpkinds/fp-overrides.json`
hazır örnekleri içerir.

| Tip | Fonksiyon | libclang'ın otomatik tespiti | Önerilen override |
|-----|-----------|------------------------------|-------------------|
| **Array tablosu** `vt[i](x)` | `fp_array_dispatch` | 3 handler (tablo init'ten) — over-approx | **daralt** tek hedefe |
| **Struct üyesi** `ops.run(x)` | `fp_struct_dispatch` | 2 handler (struct init'ten) | daralt / doğrula |
| **Parametre callback** `cb(x)` | `fp_param_apply` | (bulamaz) | **ekle** (elle hedef ver) |
| **Global pointer** `g(x)` | `fp_global_dispatch` | son atanan handler | **koşullu** (yola göre) |
| **Dönen pointer** `pick()(x)` | `fp_returned_dispatch` | `pick` (ara fonksiyon) | gerçek hedeflere **bağla** |

## Nasıl denenir

1. `.vscode/settings.json`'da:
   ```jsonc
   "cCallDepth.fpOverridesPath": "fpkinds/fp-overrides.json"
   ```
2. `fpkinds.c`'yi aç, bir dispatcher'ın indirect çağrı satırına bak (yorumlarda
   `// indirect via ...` yazıyor). `fp-overrides.json`'daki `line` o satırdır.
3. Override'ı düzenle → analiz otomatik yeniden çalışır → yan panelde callee
   listesinin, peak'in ve "fp verified ✓" rozetinin değiştiğini gör.

## Koşullu örnek (global pointer)

`fp_global_dispatch`, global `current_mode` pointer'ı üzerinden çağırır.
`fp-overrides.json`'daki koşullu kural:
- **callerContains `fp_global_set_heavy`** → `handler_large` (ağır mod ayarlanmışsa)
- **fromRoot `fpkinds_root_a`** → `handler_small`

Böylece per-root peak, çağrının hangi yoldan/kökten geldiğine göre değişir;
`fpkinds_root_b` (önce `fp_global_set_heavy` çağırır) ağır handler'ı görür.

## Beklenen (override'larla)

- `fp_array_dispatch` → yalnızca `handler_large`, **fp verified ✓**
- `fp_param_apply` → `handler_large` (eklendi), verified
- `fp_returned_dispatch` → `handler_small` + `handler_large`, verified
- `fp_global_dispatch` → koşula göre per-root'ta `handler_small` veya `handler_large`

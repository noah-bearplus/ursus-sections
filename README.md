# sectionforge

Biến một trang web thật thành **section HTML sạch** và **section Liquid cho Shopify khớp với quy ước theme của bạn** — tự động, có kiểm chứng bằng ảnh chụp.

```
URL / trang đã lưu ──► ingest ──► design ──► convert ──► clone ──► verify
                         │          │           │                    │
                     snapshot   tokens +    Section IR          pixel diff
                                styleguide  (HTML+CSS+fields)   vs bản gốc
                                                │
                                   theme của bạn ──► shopify ──► catalog
                                   (analyzer)       .liquid      gallery + copy code
```

Trang đầu tiên đã convert: **details.so/inspo** → 6 section (header, hero, filter pills, inspiration grid, FAQ + CTA, footer).

| Section | Độ lệch so với bản gốc (desktop / mobile) | Liquid (Dawn) |
|---|---|---|
| Header | 1.43% / 1.30% (lệch 1px theo chiều dọc) | 18 settings, block `nav_link` |
| Hero | 0.00% / 0.00% | 10 settings |
| Filter pills | 0.00% / 0.00% | 10 settings, block `pill` |
| Inspiration grid | 0.05% / 0.15% | block `card` (12 preset) |
| FAQ & CTA | 0.17% / 0.00% | block `question`, `related_link` |
| Footer | 0.01% / 0.02% | block `link_group` |

0 lỗi validate schema/Liquid trên cả 3 profile (Dawn, Horizon, Generic). Bản Liquid render thử (liquidjs + shim Shopify) lệch ≤ 0.17% so với bản HTML clone.

## Cài đặt

```bash
npm install
# Playwright: dùng bản có sẵn trên máy, hoặc
npm i -D playwright && npx playwright install chromium
```

Node ≥ 20. Không cần build — chạy TypeScript trực tiếp qua `tsx`.

## Dùng

```bash
# Chạy toàn bộ pipeline cho một recipe, sinh Liquid theo theme của bạn
npm run sf -- run recipes/details-so-inspo.json --theme ../my-theme

# Chỉ chạy tới một stage (các stage phụ thuộc tự chạy, có cache)
npm run sf -- run recipes/details-so-inspo.json --stages verify

# Xem theme của bạn có quy ước gì
npm run sf -- analyze-theme ../my-theme

# Nhiều nguồn cùng lúc qua job queue
npm run sf -- batch recipes/*.json --concurrency 3 --theme ../my-theme

# Gallery tĩnh (giống Osmo / byq.supply / Ursus): preview + copy Liquid
npm run sf -- catalog --profile dawn
```

Không có `--theme` → profile **Generic OS 2.0** (section tự chứa, chạy trên mọi theme Online Store 2.0).

Nguồn có thể là URL (crawl bằng Playwright, cuộn để kích hoạt lazy-load, lưu mọi CSS/ảnh/font) hoặc trang đã lưu bằng **Save Page As → Webpage, Complete** (như details.so ở đây).

## Kết quả nằm ở đâu

`.sf/projects/<recipe-id>/`

| Thư mục | Nội dung |
|---|---|
| `snapshot/` | HTML đã làm sạch, CSS theo đúng thứ tự cascade, asset, ảnh chụp tham chiếu |
| `design/` | `tokens.json`, `tokens.css`, **`styleguide.html`** (màu 2 mode, type scale, radius, shadow, easing, breakpoint, component) |
| `sections/<key>/` | `ir.json` (Section IR), `section.css`, `template.html`, `preview.html` |
| `clone/index.html` | **bản clone toàn trang** (nút chuyển dark/light) |
| `verify/` | ảnh gốc / clone / diff từng section, `report.json` |
| `shopify/<theme>/theme/` | `sections/*.liquid` + `assets/*` theo quy ước theme (vd. Dawn: CSS qua asset file) |
| `shopify/<theme>/single-file/` | mỗi section là **1 file** copy-paste (CSS/JS inline bằng `{% stylesheet %}`/`{% javascript %}`) |
| `shopify/<theme>/preview/` | Liquid render thử + diff so với clone |
| `.sf/catalog/` | gallery tĩnh |

## Section Liquid "đồng nhất với theme" nghĩa là gì

Theme analyzer đọc theme của bạn và generator làm theo:

- **Cách nạp CSS/JS** giống các section có sẵn: Dawn → `{{ 'section-x.css' | asset_url | stylesheet_tag }}`; Horizon → `{% stylesheet %}`.
- **Padding**: chép nguyên schema `padding_top/bottom` (hoặc `padding-block-start/end` + snippet `spacing-style` của Horizon) và khối `{% style %}` của theme.
- **Colour scheme**: setting `color_scheme` + class `color-{{ ... }} gradient` của theme.
- **Root font-size**: Dawn đặt `html { font-size: 62.5% }` → mọi `rem` của nguồn được đổi sang `px` để không bị co 37.5%.
- **Rule toàn cục gây hại**: Dawn ẩn `div:empty` → section thêm rule bảo vệ phần tử trang trí rỗng.
- **Style source**: mỗi section có setting *Original design* / *Match theme colours & fonts*. Cùng markup, cùng CSS — chỉ trỏ lại design token sang biến của theme (`rgb(var(--color-foreground))`, `var(--font-heading-family)`…).
- Schema hợp lệ theo giới hạn Shopify (tên ≤ 25 ký tự, `max_blocks` ≤ 50, default của `url`, `richtext`, `range` ≤ 101 bước…), có `presets` với nội dung demo, `{{ block.shopify_attributes }}` cho theme editor, `enabled_on` header/footer group.

## Cách CSS được chuyển (vì sao ít lệch)

Không đoán style từ computed style. Converter giữ **chính các rule CSS tác giả viết**:

1. Mỗi selector được thử trong Chromium thật (bỏ `:hover`, `::before`, trạng thái `[data-open]`… khi thử) để biết nó có áp vào phần tử nào của section không, ở mọi colour mode.
2. Vị trí của section trong selector được **kiểm chứng bằng match-set**: viết lại thành `.sf-dtl-hero …` rồi so tập phần tử khớp với selector gốc.
3. Class, id, custom property, keyframes được gắn namespace `dtl-`; attribute scope của framework (`data-astro-cid-*`) thành class và bị bỏ khi không cần.
4. Style kế thừa từ tổ tiên nằm ngoài section (font, màu, letter-spacing, nền của `html/body`) được kéo lên root của section.
5. Chỉ những design token thực sự dùng (kèm token mà chúng tham chiếu, kèm biến thể theo media query và mode) được phát ra trên scope của section.

## Recipe

Pipeline là generic; recipe chỉ thu hẹp nó cho một nguồn (selector section, phần tử bỏ đi, repeater → block, gợi ý tên field, behavior JS). Xem `docs/RECIPES.md`. Không có `sections` trong recipe → tự tách section và tự phát hiện repeater.

## Lưu ý về nội dung nguồn

Font **Season Collection** của details.so là font thương mại, không có trong file đã lưu — bản clone dùng font fallback (`system-ui`). Muốn đúng 100% cần mua license và thêm `@font-face`. Logo, nội dung, ảnh trong `sources/` thuộc về chủ sở hữu trang gốc; `sources/` được gitignore.

## Phát triển

```bash
npm test          # unit test (node:test)
npm run typecheck
```

Kiến trúc và lộ trình mở rộng: `docs/ARCHITECTURE.md`.

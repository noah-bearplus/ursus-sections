# Kiến trúc

## Mục tiêu thiết kế

1. **Đúng trước, đẹp sau** — mọi bước biến đổi CSS đều được kiểm chứng trong trình duyệt thật, và kết quả cuối cùng được chấm điểm bằng pixel diff so với bản gốc.
2. **Một IR, nhiều đích** — Section IR là ranh giới giữa "thế giới web" và "thế giới theme". HTML clone, Liquid Dawn, Liquid Horizon, (sau này) Webflow/React đều render từ cùng một IR.
3. **Stage độc lập, artifact trên đĩa** — mỗi stage đọc/ghi JSON + file trong workspace, nên có thể chạy ở process/worker khác nhau, cache, chạy lại một phần.
4. **Generic + recipe** — pipeline không biết gì về details.so; mọi thứ riêng của một nguồn nằm trong recipe JSON.

## Package

| Package | Trách nhiệm | Phụ thuộc chính |
|---|---|---|
| `@sf/core` | Type dùng chung (Recipe, Snapshot, DesignTokens, SectionIR, ThemeProfile), `Workspace` (artifact store), `Pipeline` (DAG + cache), `JobQueue` | — |
| `@sf/crawler` | Ingest (URL hoặc trang đã lưu) → Snapshot; làm sạch DOM (gỡ extension, script, resource hint); static server; Playwright | linkedom, playwright |
| `@sf/design` | Trích design token (resolve trong browser cho từng mode), type scale, breakpoint, font → `tokens.json`, `tokens.css`, styleguide | postcss |
| `@sf/converter` | Tách section, so khớp & viết lại CSS, làm sạch HTML, field/repeater → Section IR, behavior JS, render tĩnh, verify | postcss, postcss-selector-parser, linkedom |
| `@sf/shopify` | Theme analyzer → ThemeProfile; generator Liquid + schema; validator; runtime preview (liquidjs + shim Shopify); pixel diff | liquidjs, pixelmatch |
| `@sf/catalog` | Gallery tĩnh: lọc theo loại, preview responsive, copy/tải Liquid | — |
| `apps/cli` | Lệnh `sf run / batch / catalog / analyze-theme / stages`, định nghĩa các stage | commander |

## Stage

| Stage | Vào | Ra |
|---|---|---|
| `ingest` | recipe.source | `snapshot/page.html`, `styles/NNN-*.css` (đúng thứ tự cascade, khử trùng lặp giữ bản cuối), `assets/*` (đặt tên lại theo magic bytes), `snapshot.json` |
| `capture` | snapshot | ảnh toàn trang × mode × viewport, root font-size |
| `design` | snapshot | `design/tokens.json`, `tokens.css`, `styleguide.html` |
| `convert` | snapshot + tokens | `sections/<key>/ir.json` … |
| `clone` | IR | `clone/index.html`, `sections/<key>/preview.html`, styleguide kèm component |
| `verify` | clone + snapshot | ảnh gốc/clone/diff từng section × viewport, `verify/report.json` |
| `thumbs` | clone | `sections/<key>/thumb.jpg` (cắt đúng khung section, ảnh 2x) + `sections/thumbs.json` cho catalog |
| `shopify` | IR + theme | `shopify/<profile>/theme`, `single-file`, `preview`, `report.json`, `README.md` |

Cache key của stage = hash(tên stage, recipe, options, cacheKey riêng, key của stage phía trước). Đổi recipe hay đổi input → chỉ những stage bị ảnh hưởng chạy lại. Trong lúc phát triển, `convert/clone/verify/shopify` còn hash cả mã nguồn package.

## Section IR

```jsonc
{
  "key": "grid", "rootClass": "sf-dtl-grid", "classPrefix": "dtl-",
  "template": "<div class=\"dtl-grid-container sf-dtl-grid\"><div data-sf-repeat=\"card\" …>{{sf:title}}…",
  "css": "/* tokens */ .sf-dtl-grid { --dtl-surface-2: … } … /* section */ …",
  "js": "(function(){ … hover-video … })()",
  "fields":    [ { "id": "heading", "type": "inline_richtext", "default": "…", "group": "Intro" } ],
  "repeaters": [ { "blockType": "card", "fields": [...], "items": [ { "title": "Heron AI", … } ], "presetCount": 12 } ],
  "modes": { "attribute": "data-theme", "values": ["dark", "light"], "default": "dark" }
}
```

Marker trong template:

| Marker | Ý nghĩa | HTML tĩnh | Liquid |
|---|---|---|---|
| `{{sf:id}}` | giá trị field | escape theo kiểu field | `{{ section.settings.id \| escape }}`, `newline_to_br`, `image_url`… |
| `data-sf-repeat="t"` | template của một item | lặp theo `items` | `{% for block in section.blocks %}{% if block.type != 't' %}{% continue %}…` + `{{ block.shopify_attributes }}` |
| `data-sf-if="f"` | phần tử tuỳ chọn | bỏ nếu rỗng/false | `{% if … %}` |
| `data-sf-attr-if="f:a b"` | thuộc tính có điều kiện | | `{% if block.settings.f %} a b{% endif %}` |
| `data-sf-list="f"` | danh sách link "Label \| URL" | | `newline_to_br \| split` |
| `{{sf:@index0}}` | chỉ số vòng lặp | | `{{ forloop.index0 }}` |
| `data-sf-role="dropdown.menu"` | điểm bám cho behavior JS | giữ | giữ |

## Converter — chi tiết thuật toán

1. **Chuẩn bị DOM** (trong trang thật, JS tắt): áp `prepare` của recipe (retag, xoá attr/class, wrap để đồng nhất cấu trúc), gỡ `remove`, đánh dấu repeater/hint/role, tự phát hiện repeater nếu recipe không khai báo.
2. **Bỏ phần tử ẩn**: phần tử `display:none` ở *mọi* mode × viewport (vd. UI chỉ dành cho user đã đăng nhập) bị gỡ, trừ phần tử behavior cần (menu dropdown đang đóng).
3. **So khớp CSS**: ~4.100 selector của trang được rút về ~1.500 "test selector" duy nhất (bỏ pseudo-element, `:hover`, trạng thái runtime). Mỗi test selector được thử trên section ở mọi mode; với selector khớp, thử lần lượt các điểm cắt `k` (phần bên trái là tổ tiên ngoài section) và 3 kiểu neo (A: compound k chính là root, B: nằm trong root, C: cả hai), chọn phương án cho **cùng tập phần tử**.
4. **Viết lại**: tiền tố `dtl-` cho class/id/custom property/keyframes, attribute scope framework → class, `rem → px`, điều kiện mode (`html[data-theme=dark] …`) → `.sf-dtl-x[data-theme="dark"] …`.
5. **Kéo style kế thừa** từ tổ tiên (sắp theo độ sâu → specificity → thứ tự; `inherit/unset` giữ giá trị trước đó).
6. **Token**: chỉ token được dùng (đóng theo tham chiếu `var()`), có biến thể mode và media query.
7. **HTML sạch**: giữ class/id/data-* khi CSS/behavior cần, đặt namespace, gỡ framework artefact; sau đó tỉa class scope không cần thiết (kiểm chứng match-set bằng linkedom).
8. **Template**: field từ text/ảnh/link/video/nền; repeater theo đường dẫn cấu trúc; phần tử/thuộc tính tuỳ chọn; thuộc tính suy ra từ field khác (`aria-label="Open {{title}}"`); gộp field trùng (link desktop/mobile).

## Đường mở rộng (scale)

### Ngắn hạn
- **Hàng đợi thật**: `JobQueue` đã là interface; thêm `BullMQQueue` (Redis) và một `worker` chạy `Pipeline.run`. Mỗi job = một recipe/URL; worker Playwright chạy trong container riêng (browser pool).
- **Artifact store**: `Workspace` là chỗ duy nhất chạm filesystem → thêm bản S3/R2 (asset ảnh demo publish lên CDN của dịch vụ, `<image>_fallback` trỏ URL CDN thay vì asset trong theme).
- **API + DB**: Postgres lưu project, section, version, profile theme của từng khách; catalog tĩnh hiện tại thay bằng app (Next.js) đọc cùng dữ liệu, có auth/thanh toán.
- **Theme của khách**: kết nối Shopify Admin API (Theme Asset API) để đọc theme đang dùng → chạy analyzer → đẩy section thẳng vào theme (thay vì copy tay).

### Trung hạn
- **Recipe tự động**: dùng LLM (Claude) đọc screenshot + DOM tóm tắt để đề xuất `sections`, tên field, nhóm setting, repeater — con người duyệt; pipeline vẫn kiểm chứng bằng pixel diff.
- **Adapter Horizon theme blocks**: sinh thêm `blocks/*.liquid` (`content_for 'blocks'`) để block lồng nhau thay cho textarea "Label | URL".
- **Responsive verify** ở nhiều breakpoint + mode, ngưỡng tự động fail job.
- **Font**: map font thương mại sang font_picker của Shopify gần nhất, hoặc cho khách upload font có license.
- **Đích khác**: cùng IR → Webflow, React/Tailwind component.

### Giới hạn hiện tại
- Không chép JS gốc; tương tác được dựng lại từ thư viện behavior (accordion, dropdown, hover-video, drag-scroll). Animation phức tạp (GSAP, scroll-driven) cần behavior mới.
- Repeater lồng nhau → textarea `Label | URL` (Shopify section chỉ có 1 cấp block).
- ID giữ tĩnh (có tiền tố) — thêm section giống nhau 2 lần sẽ trùng id (CSS vẫn đúng).
- Link trỏ về trang nguồn không được đặt làm default (Shopify chỉ cho `/collections`).

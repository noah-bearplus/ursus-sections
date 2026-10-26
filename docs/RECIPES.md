# Viết recipe

Recipe là JSON mô tả **một nguồn**. Mọi đường dẫn tính tương đối từ file recipe.

```jsonc
{
  "id": "details-so-inspo",          // tên thư mục workspace
  "name": "Details.so — Inspo",
  "prefix": "dtl",                    // namespace cho class, biến CSS, tên file (dtl-hero.liquid)
  "source": {
    "url": "https://www.details.so/inspo",              // crawl trực tiếp…
    "savedHtml": "../sources/details-so-inspo/page.html", // …hoặc trang đã lưu
    "savedAssetsDir": "../sources/details-so-inspo/page_files"
  },
  "viewports": { "desktop": 1440, "mobile": 390 },
  "modes": { "selector": "html", "attribute": "data-theme", "values": ["dark", "light"], "default": "dark" },
  "state": { "htmlAttrs": { "data-auth-shell-hint": "guest" } },  // chụp ở trạng thái khách
  "captureCss": "…",                  // gỡ scroll container của app shell, ẩn overlay
  "sections": [ … ]                   // bỏ trống → tự tách section
}
```

## Một section

```jsonc
{
  "key": "grid",                      // → sections/dtl-grid.liquid
  "name": "Details · Inspiration grid",
  "category": "grid",                 // header | hero | filter | grid | faq | footer | …
  "selector": "#swup > .grid-container",
  "remove": [".card-meta-actions"],   // phần tử không cần
  "prepare": [                        // sửa DOM trước khi convert
    { "selector": "video.card-media", "removeClass": ["is-ready"], "removeAttr": ["src"] },
    { "selector": ".link-group > span:first-child", "wrap": "div.group-heading" },
    { "selector": ".search-trigger", "retag": "a", "setAttr": { "href": "/search" } }
  ],
  "repeaters": [                      // → Shopify blocks
    { "item": ".card", "blockType": "card", "blockName": "Inspiration card", "presetCount": 12, "max": 50 }
  ],
  "fields": {                         // đặt tên/nhãn/nhóm cho field; false = giữ tĩnh
    ".card-title": { "id": "title", "label": "Title" },
    ".hero-member-avatars": false
  },
  "keep": ["#inspo-sort-dropdown"],   // không gỡ dù đang ẩn
  "behaviors": [
    { "type": "hover-video", "roles": { "item": ".card", "video": "video.card-media" }, "options": { "readyClass": "is-ready" } }
  ]
}
```

Selector trong recipe viết theo **class gốc** của trang (trước khi đổi tên).

### Quy tắc đặt tên field tự động
- Lấy class cụ thể nhất của phần tử (bỏ tiền tố recipe và tiền tố của block), `card-title` → `title`.
- Link: URL → `<tên>_link`, chữ trong link → `<tên>_label`. Hint `{ "id": "button_link" }` trên `<a>` đặt tên cho URL; chữ thành `button_label`.
- Ảnh → `image_picker` + `<id>_fallback` (tên file asset hoặc URL demo).
- Phần tử chỉ có ở một số item → `show_<tên>` (checkbox), hoặc điều kiện theo chính field text của nó.
- Thuộc tính chỉ có ở một số item (`data-active`, `aria-current`) → checkbox (`active`), `target` → `new_tab`.

### Behavior có sẵn
| type | roles | options |
|---|---|---|
| `accordion` | `item`, `trigger` | `openAttr`, `single` |
| `dropdown` | `trigger`, `menu`, `option`, `label`, `option-label` | — |
| `hover-video` | `item`, `video` | `readyClass` (class gốc, tự thêm tiền tố) |
| `drag-scroll` | `track` | — |

Thêm behavior: `packages/converter/src/behaviors.ts` (hàm `(root, opts) => void`, tìm phần tử qua `data-sf-role`).

## Quy trình làm một recipe mới
1. Tạo recipe chỉ có `source` → `sf run recipe.json --stages convert` → xem `sections/auto-segments.json`.
2. Chép selector vào `sections`, thêm `remove/prepare` cho phần tử app-only.
3. `sf run recipe.json --stages verify` → mở `verify/*.diff.png`, chỉnh tới khi diff thấp.
4. Đặt tên field quan trọng bằng `fields`, rồi `--stages shopify --theme <theme>` → xem `report.json` (0 error) và `preview/*.diff.png`.

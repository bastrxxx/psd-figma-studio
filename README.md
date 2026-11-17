# 🎨 PSD Figma Studio

Ứng dụng web đọc file **Photoshop (.psd)** — toàn bộ layer, group, text, mask, clipping, blend mode, hiệu ứng — cho phép chỉnh sửa layer, lưu trên database và **xuất sang Figma giữ nguyên layer + text sửa được**.

## Tính năng
- **Tải file PSD** (kéo thả, hỗ trợ file hàng trăm MB): phân tích ngay trên trình duyệt bằng Web Worker (`ag-psd`), không bị giới hạn 4.5MB của Vercel Functions.
- **Đọc mọi thứ**: cây layer/group, text (nội dung, font, cỡ, màu, căn lề, style runs), layer mask, group mask, clipping mask, opacity/fill, blend mode, drop shadow/outer glow/color overlay/stroke, smart object, adjustment layer, ảnh composite gốc.
- **Chỉnh layer**: kéo thả đổi thứ tự / đưa vào group, ▲▼ (Ctrl+]/[), ẩn/hiện, đổi tên (double-click), opacity, blend mode, clipping, **gộp layer** (Ctrl+E), nhóm (Ctrl+G), xóa (Delete), sửa nội dung text, Undo/Redo.
- **Lưu database**: metadata layer trong **Neon Postgres**, ảnh layer trong **Vercel Blob** (đóng gói ~8MB/gói). Tự động lưu.
- **Quản lý file**: danh sách file, mở, xóa (xóa cả ảnh trên Blob), tải file mới.
- **Xuất Figma**:
  1. **Plugin Figma** (`figma-plugin/`, tải trong app dạng zip) — dựng lại toàn bộ layer thành node Figma: group, ảnh, **TEXT sửa được** (tự khớp font), clipping mask, group mask, blend mode, opacity, shadow.
  2. **SVG** — kéo thả vào Figma, giữ group, tên layer và text.
  3. JSON / PNG.

## Chạy local
```bash
npm install
vercel link && vercel env pull .env.local   # lấy DATABASE_URL + BLOB_READ_WRITE_TOKEN
npm run dev
```

## Kiến trúc
```
Browser ── Web Worker (ag-psd) ──► PNG từng layer ──► Vercel Blob (client upload, gói 8MB)
   │                                                   ▲
   └── metadata layer (JSON) ──► /api/documents ──► Neon Postgres
Figma plugin ──► /api/documents/:id/figma (JSON) + Blob ──► node Figma
```

## Giới hạn
- Adjustment layer (Curves, Hue/Sat…) được đọc và giữ trong cây layer nhưng chưa áp dụng khi hiển thị trên web; dùng "Ảnh gốc PSD" để so sánh.
- File `.fig` là định dạng đóng của Figma nên việc xuất được thực hiện qua plugin/SVG.
- Font: Figma cần cài sẵn font giống PSD để text hiển thị y hệt; nếu thiếu, plugin dùng Inter và liệt kê font thiếu.

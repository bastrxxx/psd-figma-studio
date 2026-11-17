'use client';
import { upload } from '@vercel/blob/client';
import type { ParsedLayer, WorkerMsg } from './psd.worker';
import type { ImageRef, Layer } from './types';

export type ImportProgress = { stage: string; pct: number };

const BUNDLE_TARGET = 8 * 1024 * 1024;

function parseInWorker(buf: ArrayBuffer, onProgress: (p: ImportProgress) => void) {
  return new Promise<Extract<WorkerMsg, { type: 'done' }>>((resolve, reject) => {
    const w = new Worker(new URL('./psd.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress({ stage: m.total > 1 ? `${m.stage} ${m.done}/${m.total}` : m.stage, pct: 5 + (m.done / Math.max(1, m.total)) * 55 });
      else if (m.type === 'done') { w.terminate(); resolve(m); }
      else { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Worker lỗi (có thể do thiếu bộ nhớ)')); };
    w.postMessage(buf, [buf]);
  });
}

export async function uploadBlob(pathname: string, data: Blob, contentType: string) {
  const res = await upload(pathname, data, {
    access: 'public',
    handleUploadUrl: '/api/upload',
    contentType,
    multipart: data.size > 20 * 1024 * 1024,
  });
  return res.url;
}

export async function importPsd(file: File, onProgress: (p: ImportProgress) => void): Promise<string> {
  onProgress({ stage: 'Đang đọc file…', pct: 1 });
  const buf = await file.arrayBuffer();
  const parsed = await parseInWorker(buf, onProgress);
  const docId = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Pack all PNGs into ~8MB bundles → few Blob operations, fast parallel download.
  type Item = { blob: Blob; assign: (ref: ImageRef) => void };
  const items: Item[] = [];
  const layers: Layer[] = parsed.layers.map((pl: ParsedLayer) => {
    const { png, maskPng, ...layer } = pl;
    const l: Layer = { ...layer, image: null };
    if (png) items.push({ blob: png, assign: (r) => (l.image = r) });
    if (maskPng && l.meta?.groupMask) items.push({ blob: maskPng, assign: (r) => (l.meta!.groupMask!.image = r) });
    return l;
  });
  let compositeRef: ImageRef | null = null;
  if (parsed.composite) items.push({ blob: parsed.composite, assign: (r) => (compositeRef = r) });

  const bundles: { parts: Blob[]; assigns: { assign: (r: ImageRef) => void; offset: number; length: number }[]; size: number }[] = [];
  let cur = { parts: [] as Blob[], assigns: [] as { assign: (r: ImageRef) => void; offset: number; length: number }[], size: 0 };
  for (const it of items) {
    if (cur.size > 0 && cur.size + it.blob.size > BUNDLE_TARGET) { bundles.push(cur); cur = { parts: [], assigns: [], size: 0 }; }
    cur.assigns.push({ assign: it.assign, offset: cur.size, length: it.blob.size });
    cur.parts.push(it.blob);
    cur.size += it.blob.size;
  }
  if (cur.size) bundles.push(cur);

  const totalBytes = bundles.reduce((s, b) => s + b.size, 0);
  let uploaded = 0;
  onProgress({ stage: `Đang tải lên ${bundles.length} gói ảnh (${(totalBytes / 1048576).toFixed(1)} MB)…`, pct: 60 });
  let next = 0;
  const workerFn = async () => {
    while (next < bundles.length) {
      const i = next++;
      const b = bundles[i];
      const url = await uploadBlob(`docs/${docId}/bundle-${i}.bin`, new Blob(b.parts, { type: 'application/octet-stream' }), 'application/octet-stream');
      for (const a of b.assigns) a.assign({ url, offset: a.offset, length: a.length });
      uploaded += b.size;
      onProgress({ stage: `Đang tải lên ảnh layer… ${(uploaded / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB`, pct: 60 + (uploaded / totalBytes) * 32 });
    }
  };
  await Promise.all(Array.from({ length: 4 }, workerFn));

  let previewUrl: string | null = null;
  if (parsed.thumb) previewUrl = await uploadBlob(`docs/${docId}/thumb.jpg`, parsed.thumb, 'image/jpeg');

  onProgress({ stage: 'Đang lưu vào database…', pct: 95 });
  const res = await fetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: docId,
      name: file.name.replace(/\.psd$/i, ''),
      width: parsed.width,
      height: parsed.height,
      previewUrl,
      composite: compositeRef,
      fileSize: file.size,
      layers,
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Lưu thất bại');
  onProgress({ stage: 'Hoàn tất!', pct: 100 });
  return docId;
}

import type { ImageRef, Layer } from './types';

export interface ImageStore {
  bitmaps: Map<string, ImageBitmap>; // key: layer id | 'mask:<id>' | 'composite'
  blobs: Map<string, Blob>; // raw PNG bytes (for export)
}

export function emptyStore(): ImageStore {
  return { bitmaps: new Map(), blobs: new Map() };
}

const bufferCache = new Map<string, Promise<ArrayBuffer>>();

function fetchBuffer(url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  if (!bufferCache.has(url)) {
    bufferCache.set(
      url,
      (async () => {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`Không tải được ${url}`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          onBytes?.(value.length);
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out.buffer;
      })().catch((e) => { bufferCache.delete(url); throw e; })
    );
  }
  return bufferCache.get(url)!;
}

export async function refToBlob(ref: ImageRef, onBytes?: (n: number) => void): Promise<Blob> {
  const buf = await fetchBuffer(ref.url, onBytes);
  const slice = ref.offset !== undefined && ref.length !== undefined ? buf.slice(ref.offset, ref.offset + ref.length) : buf;
  return new Blob([slice], { type: 'image/png' });
}

export async function loadImages(
  layers: Layer[],
  composite: ImageRef | null,
  store: ImageStore,
  onProgress?: (done: number, total: number) => void
) {
  const jobs: { key: string; ref: ImageRef }[] = [];
  for (const l of layers) {
    if (l.image?.url && !store.bitmaps.has(l.id)) jobs.push({ key: l.id, ref: l.image });
    const gm = l.meta?.groupMask;
    if (gm?.image?.url && !store.bitmaps.has('mask:' + l.id)) jobs.push({ key: 'mask:' + l.id, ref: gm.image });
  }
  if (composite?.url && !store.bitmaps.has('composite')) jobs.push({ key: 'composite', ref: composite });
  let done = 0;
  const total = jobs.length;
  onProgress?.(0, total);
  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      try {
        const blob = await refToBlob(job.ref);
        store.blobs.set(job.key, blob);
        store.bitmaps.set(job.key, await createImageBitmap(blob));
      } catch (e) {
        console.warn('image load failed', job.key, e);
      }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

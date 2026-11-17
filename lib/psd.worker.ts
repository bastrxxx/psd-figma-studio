/// <reference lib="webworker" />
import { initializeCanvas, readPsd } from 'ag-psd';
import type { Layer as PsdLayer, Psd, Color } from 'ag-psd';
import type { Layer, LayerKind, TextData, TextRun, LayerEffects } from './types';

// ag-psd needs a canvas factory; inside a worker we use OffscreenCanvas.
initializeCanvas(
  ((w: number, h: number) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h))) as unknown as (w: number, h: number) => HTMLCanvasElement,
  ((w: number, h: number) => new ImageData(Math.max(1, w), Math.max(1, h))) as unknown as (w: number, h: number) => ImageData
);

export interface ParsedLayer extends Layer {
  png?: Blob | null;
  maskPng?: Blob | null;
}

export type WorkerMsg =
  | { type: 'progress'; stage: string; done: number; total: number }
  | { type: 'done'; width: number; height: number; layers: ParsedLayer[]; composite: Blob | null; thumb: Blob | null }
  | { type: 'error'; message: string };

const post = (m: WorkerMsg) => (self as unknown as Worker).postMessage(m);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRGBA(c: Color | any, alpha = 1): [number, number, number, number] {
  if (!c) return [0, 0, 0, alpha];
  if ('r' in c) return [Math.round(c.r), Math.round(c.g), Math.round(c.b), alpha];
  if ('fr' in c) return [Math.round(c.fr * 255), Math.round(c.fg * 255), Math.round(c.fb * 255), alpha];
  if ('k' in c && 'c' in c) {
    const k = c.k / 255;
    return [Math.round(255 * (1 - c.c / 255) * (1 - k)), Math.round(255 * (1 - c.m / 255) * (1 - k)), Math.round(255 * (1 - c.y / 255) * (1 - k)), alpha];
  }
  if ('k' in c) return [Math.round(c.k), Math.round(c.k), Math.round(c.k), alpha];
  if ('h' in c) {
    // HSB
    const h = c.h / 360, s = c.s, v = c.b;
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), alpha];
  }
  return [0, 0, 0, alpha];
}

const unit = (v: unknown) => (typeof v === 'number' ? v : (v as { value?: number })?.value ?? 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertEffects(fx: any, globalAngle: number): LayerEffects | undefined {
  if (!fx || fx.disabled) return undefined;
  const out: LayerEffects = {};
  const arr = (x: unknown) => (Array.isArray(x) ? x : x ? [x] : []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shadow = (s: any) => ({
    color: toRGBA(s.color),
    opacity: s.opacity ?? 1,
    angle: s.useGlobalLight ? globalAngle : s.angle ?? globalAngle,
    distance: unit(s.distance),
    size: unit(s.size),
    blendMode: s.blendMode || 'normal',
  });
  const ds = arr(fx.dropShadow).filter((s) => s.enabled).map(shadow);
  if (ds.length) out.dropShadow = ds;
  const is = arr(fx.innerShadow).filter((s) => s.enabled).map(shadow);
  if (is.length) out.innerShadow = is;
  const og = arr(fx.outerGlow).find((s) => s.enabled && s.color);
  if (og) out.outerGlow = { color: toRGBA(og.color), opacity: og.opacity ?? 1, size: unit(og.size), blendMode: og.blendMode || 'screen' };
  const sf = arr(fx.solidFill).find((s) => s.enabled);
  if (sf) out.colorOverlay = { color: toRGBA(sf.color), opacity: sf.opacity ?? 1, blendMode: sf.blendMode || 'normal' };
  const st = arr(fx.stroke).find((s) => s.enabled && s.color);
  if (st) out.stroke = { color: toRGBA(st.color), opacity: st.opacity ?? 1, size: unit(st.size), position: st.position || 'outside' };
  return Object.keys(out).length ? out : undefined;
}

function convertText(l: PsdLayer): TextData | null {
  const t = l.text;
  if (!t) return null;
  const tr = t.transform ?? [1, 0, 0, 1, 0, 0];
  const scaleY = Math.hypot(tr[2], tr[3]) || 1;
  const scaleX = Math.hypot(tr[0], tr[1]) || 1;
  const base = t.style ?? {};
  const text = (t.text ?? '').replace(/\r\n?/g, '\n');
  const runs: TextRun[] = [];
  let pos = 0;
  for (const r of t.styleRuns ?? []) {
    const s = { ...base, ...(r.style ?? {}) };
    runs.push({
      start: pos,
      end: Math.min(text.length, pos + r.length),
      font: s.font?.name,
      fontSize: s.fontSize ? +(s.fontSize * scaleY).toFixed(2) : undefined,
      color: s.fillColor ? toRGBA(s.fillColor) : undefined,
      fauxBold: s.fauxBold,
      fauxItalic: s.fauxItalic,
      underline: s.underline,
      tracking: s.tracking,
    });
    pos += r.length;
  }
  const first = runs[0];
  const para = t.paragraphStyle ?? t.paragraphStyleRuns?.[0]?.style ?? {};
  const just = para.justification ?? 'left';
  const align: TextData['align'] = just === 'center' ? 'center' : just === 'right' ? 'right' : just.startsWith('justify') ? 'justify' : 'left';
  const fontSize = first?.fontSize ?? +((base.fontSize ?? 12) * scaleY).toFixed(2);
  const data: TextData = {
    text: text.replace(/\n$/, ''),
    font: first?.font ?? base.font?.name ?? 'Arial',
    fontSize,
    color: first?.color ?? (base.fillColor ? toRGBA(base.fillColor) : [0, 0, 0, 1]),
    align,
    tracking: first?.tracking ?? base.tracking ?? 0,
    leading: base.autoLeading === false && base.leading ? +(base.leading * scaleY).toFixed(2) : undefined,
    shapeType: t.shapeType === 'box' ? 'box' : 'point',
    transform: tr,
    runs,
  };
  if (t.shapeType === 'box' && t.boxBounds) {
    const [bl, bt, br, bb] = t.boxBounds;
    data.box = { left: tr[4] + bl * scaleX, top: tr[5] + bt * scaleY, width: (br - bl) * scaleX, height: (bb - bt) * scaleY };
  }
  return data;
}

function kindOf(l: PsdLayer): LayerKind {
  if (l.children) return 'group';
  if (l.text) return 'text';
  if (l.adjustment) return 'adjustment';
  if (l.placedLayer) return 'smart';
  if (l.vectorFill && !l.vectorMask && !l.vectorOrigination) return 'fill';
  if (l.vectorMask || l.vectorOrigination || l.vectorStroke) return 'shape';
  return 'pixel';
}

async function toPng(img: ImageData): Promise<Blob> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

/** Bake a pixel layer mask into the layer's alpha channel. */
function applyMask(img: ImageData, left: number, top: number, mask: NonNullable<PsdLayer['mask']>) {
  const md = mask.imageData as ImageData | undefined;
  const ml = mask.left ?? 0, mt = mask.top ?? 0;
  const mw = md ? md.width : 0, mh = md ? md.height : 0;
  const def = mask.defaultColor ?? 255;
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    const my = top + y - mt;
    for (let x = 0; x < img.width; x++) {
      const mx = left + x - ml;
      const v = md && mx >= 0 && my >= 0 && mx < mw && my < mh ? md.data[(my * mw + mx) * 4] : def;
      if (v !== 255) {
        const i = (y * img.width + x) * 4 + 3;
        d[i] = (d[i] * v) / 255;
      }
    }
  }
}

function isBlank(img: ImageData) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}

async function parse(buf: ArrayBuffer) {
  post({ type: 'progress', stage: 'Đang đọc cấu trúc PSD…', done: 0, total: 1 });
  const psd: Psd = readPsd(buf, {
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
  });
  const globalAngle = psd.imageResources?.globalAngle ?? 120;

  const all: { l: PsdLayer; parentId: string | null; position: number; id: string }[] = [];
  let counter = 0;
  const walk = (children: PsdLayer[] | undefined, parentId: string | null) => {
    (children ?? []).forEach((l, i) => {
      const id = `l${++counter}`;
      all.push({ l, parentId, position: i, id });
      if (l.children) walk(l.children, id);
    });
  };
  walk(psd.children, null);

  const out: ParsedLayer[] = [];
  for (let i = 0; i < all.length; i++) {
    const { l, parentId, position, id } = all[i];
    if (i % 5 === 0) post({ type: 'progress', stage: 'Đang xử lý layer', done: i, total: all.length });
    const kind = kindOf(l);
    let left = l.left ?? 0, top = l.top ?? 0;
    let width = Math.max(0, (l.right ?? 0) - left), height = Math.max(0, (l.bottom ?? 0) - top);
    let png: Blob | null = null;
    let maskPng: Blob | null = null;
    let img = l.imageData as ImageData | undefined;

    // Solid color fill layers without pixels → synthesize.
    if (!img && kind === 'fill' && l.vectorFill?.type === 'color') {
      left = 0; top = 0; width = psd.width; height = psd.height;
      img = new ImageData(width, height);
      const [r, g, b] = toRGBA(l.vectorFill.color);
      for (let p = 0; p < img.data.length; p += 4) { img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255; }
    }

    if (img && kind !== 'group' && kind !== 'adjustment' && img.width > 0 && img.height > 0) {
      if (l.mask && !l.mask.disabled && (l.mask.imageData || l.mask.defaultColor === 0)) applyMask(img, left, top, l.mask);
      if (!isBlank(img)) png = await toPng(img);
      width = img.width; height = img.height;
    }
    const meta: ParsedLayer['meta'] = {};
    if (kind === 'group' && l.mask && !l.mask.disabled && l.mask.imageData) {
      const md = l.mask.imageData as ImageData;
      // convert grayscale mask to alpha mask
      const a = new ImageData(md.width, md.height);
      for (let p = 0; p < md.data.length; p += 4) { a.data[p + 3] = md.data[p]; }
      maskPng = await toPng(a);
      meta.groupMask = { image: { url: '' }, left: l.mask.left ?? 0, top: l.mask.top ?? 0, width: md.width, height: md.height, defaultColor: l.mask.defaultColor ?? 0 };
    }
    const fx = convertEffects(l.effects, globalAngle);
    if (fx) meta.effects = fx;
    if (l.adjustment) meta.adjustment = l.adjustment.type;
    if (kind === 'group' && !l.opened) meta.collapsed = true;

    out.push({
      id,
      parentId,
      position,
      name: l.name ?? 'Layer',
      kind,
      visible: !l.hidden,
      opacity: l.opacity ?? 1,
      fillOpacity: l.fillOpacity ?? 1,
      blendMode: l.blendMode ?? (kind === 'group' ? 'pass through' : 'normal'),
      clipping: !!l.clipping,
      left, top, width, height,
      text: convertText(l),
      meta: Object.keys(meta).length ? meta : null,
      png,
      maskPng,
    });
    // free memory progressively
    l.imageData = undefined;
    if (l.mask) l.mask.imageData = undefined;
  }

  post({ type: 'progress', stage: 'Đang tạo ảnh xem trước…', done: all.length, total: all.length });
  let composite: Blob | null = null, thumb: Blob | null = null;
  if (psd.imageData) {
    composite = await toPng(psd.imageData as ImageData);
    const tw = 640, th = Math.round((psd.height / psd.width) * tw);
    const src = new OffscreenCanvas(psd.width, psd.height);
    src.getContext('2d')!.putImageData(psd.imageData as ImageData, 0, 0);
    const c = new OffscreenCanvas(tw, th);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    thumb = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }
  post({ type: 'done', width: psd.width, height: psd.height, layers: out, composite, thumb });
}

self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    await parse(e.data);
  } catch (err) {
    post({ type: 'error', message: (err as Error).message || String(err) });
  }
};

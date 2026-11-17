import type { Layer, TextData } from './types';
import type { ImageStore } from './images';
import { childrenOf } from './tree';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  dissolve: 'source-over',
  darken: 'darken',
  multiply: 'multiply',
  'color burn': 'color-burn',
  'linear burn': 'multiply',
  'darker color': 'darken',
  lighten: 'lighten',
  screen: 'screen',
  'color dodge': 'color-dodge',
  'linear dodge': 'lighter',
  'lighter color': 'lighten',
  overlay: 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'vivid light': 'hard-light',
  'linear light': 'hard-light',
  'pin light': 'hard-light',
  'hard mix': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  subtract: 'difference',
  divide: 'color-dodge',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'pass through': 'source-over',
};

export const BLEND_MODES = Object.keys(BLEND);
export const blendOp = (m: string): GlobalCompositeOperation => BLEND[m] ?? 'source-over';

function makeCanvas(w: number, h: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
}

const rgba = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 1) * a})`;

// ---------- Fonts ----------
const fontState = new Map<string, 'loading' | 'ok' | 'fail'>();
export function fontFamilyFor(ps: string) {
  return `psd-${ps.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
/** Try to use a locally-installed font by its PostScript name. */
export function ensureFont(ps: string, onLoaded?: () => void) {
  if (!ps || fontState.has(ps) || typeof FontFace === 'undefined') return;
  fontState.set(ps, 'loading');
  const ff = new FontFace(fontFamilyFor(ps), `local("${ps}"), local("${ps.replace(/-/g, ' ')}")`);
  ff.load()
    .then((f) => { (document.fonts as unknown as { add(f: FontFace): void }).add(f); fontState.set(ps, 'ok'); onLoaded?.(); })
    .catch(() => fontState.set(ps, 'fail'));
}
export function fontAvailable(ps: string) {
  return fontState.get(ps) === 'ok';
}

export function cssFont(t: { font?: string; fontSize?: number; fauxBold?: boolean; fauxItalic?: boolean }, fallbackSize: number) {
  const size = t.fontSize ?? fallbackSize;
  const fam = t.font ? `"${fontFamilyFor(t.font)}", "${t.font}", ` : '';
  return `${t.fauxItalic ? 'italic ' : ''}${t.fauxBold ? 'bold ' : ''}${size}px ${fam}"Segoe UI", Arial, sans-serif`;
}

/** Render editable text layer into a canvas positioned at document coordinates. Returns canvas + offset. */
export function renderText(t: TextData, docW: number, docH: number): { canvas: OffscreenCanvas; left: number; top: number } {
  const pad = Math.ceil(t.fontSize * 2);
  const lines = t.text.split('\n');
  const lh = t.leading ?? t.fontSize * 1.2;
  const c = makeCanvas(docW + pad * 2, docH + pad * 2);
  const ctx = c.getContext('2d')!;
  ctx.font = cssFont(t, t.fontSize);
  ctx.fillStyle = rgba(t.color);
  ctx.textBaseline = 'alphabetic';
  // letterSpacing supported in modern browsers
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${(t.tracking / 1000) * t.fontSize}px`;
  let x: number, y: number;
  let wrapW = Infinity;
  if (t.shapeType === 'box' && t.box) {
    wrapW = t.box.width;
    y = t.box.top + t.fontSize;
    x = t.align === 'center' ? t.box.left + t.box.width / 2 : t.align === 'right' ? t.box.left + t.box.width : t.box.left;
  } else {
    x = t.transform[4];
    y = t.transform[5];
  }
  ctx.textAlign = t.align === 'center' ? 'center' : t.align === 'right' ? 'right' : 'left';
  const wrapped: string[] = [];
  for (const line of lines) {
    if (wrapW === Infinity) { wrapped.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width > wrapW && cur) { wrapped.push(cur); cur = word; } else cur = test;
    }
    wrapped.push(cur);
  }
  if (t.stroke) {
    ctx.strokeStyle = rgba(t.stroke.color);
    ctx.lineWidth = t.stroke.width;
  }
  wrapped.forEach((line, i) => {
    if (t.stroke) ctx.strokeText(line, x + pad, y + pad + i * lh);
    ctx.fillText(line, x + pad, y + pad + i * lh);
  });
  return { canvas: c, left: -pad, top: -pad };
}

// ---------- Layer drawing ----------
export interface RenderOptions {
  width: number;
  height: number;
  store: ImageStore;
  /** Ignore effects for speed */
  noEffects?: boolean;
}

function sourceFor(l: Layer, o: RenderOptions): { src: CanvasImageSource; left: number; top: number; w: number; h: number } | null {
  if (l.kind === 'text' && l.text?.edited) {
    const r = renderText(l.text, o.width, o.height);
    return { src: r.canvas, left: r.left, top: r.top, w: r.canvas.width, h: r.canvas.height };
  }
  const bmp = o.store.bitmaps.get(l.id);
  if (!bmp) return null;
  return { src: bmp, left: l.left, top: l.top, w: bmp.width, h: bmp.height };
}

function drawLeaf(ctx: Ctx2D, l: Layer, o: RenderOptions, opts: { asBase?: boolean } = {}) {
  const s = sourceFor(l, o);
  if (!s) return;
  let src: CanvasImageSource = s.src;
  const fx = o.noEffects ? undefined : l.meta?.effects;
  const alpha = opts.asBase ? 1 : l.opacity;

  // Color overlay
  if (fx?.colorOverlay) {
    const c = makeCanvas(s.w, s.h);
    const cx = c.getContext('2d')!;
    cx.drawImage(src, 0, 0);
    cx.globalCompositeOperation = 'source-atop';
    cx.globalAlpha = fx.colorOverlay.opacity;
    cx.fillStyle = rgba(fx.colorOverlay.color);
    cx.fillRect(0, 0, s.w, s.h);
    src = c;
  }

  // Shadows / glow (drawn below the content)
  if (fx?.dropShadow || fx?.outerGlow) {
    const OFF = 100000;
    const shadows = [
      ...(fx.dropShadow ?? []).map((d) => ({
        color: rgba(d.color, d.opacity),
        blur: d.size,
        dx: -Math.cos((d.angle * Math.PI) / 180) * d.distance,
        dy: Math.sin((d.angle * Math.PI) / 180) * d.distance,
        blend: d.blendMode,
      })),
      ...(fx.outerGlow ? [{ color: rgba(fx.outerGlow.color, fx.outerGlow.opacity), blur: fx.outerGlow.size, dx: 0, dy: 0, blend: fx.outerGlow.blendMode }] : []),
    ];
    for (const sh of shadows) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blendOp(sh.blend);
      ctx.shadowColor = sh.color;
      ctx.shadowBlur = sh.blur;
      ctx.shadowOffsetX = sh.dx + OFF;
      ctx.shadowOffsetY = sh.dy;
      ctx.drawImage(src, s.left - OFF, s.top);
      ctx.restore();
    }
  }

  ctx.save();
  ctx.globalAlpha = alpha * l.fillOpacity;
  ctx.globalCompositeOperation = opts.asBase ? 'source-over' : blendOp(l.blendMode);
  ctx.drawImage(src, s.left, s.top);
  ctx.restore();
}

function applyGroupMask(ctx: Ctx2D, l: Layer, o: RenderOptions) {
  const gm = l.meta?.groupMask;
  const bmp = o.store.bitmaps.get('mask:' + l.id);
  if (!gm || !bmp) return;
  const m = makeCanvas(o.width, o.height);
  const mx = m.getContext('2d')!;
  if (gm.defaultColor === 255) {
    mx.fillStyle = '#000';
    mx.fillRect(0, 0, o.width, o.height);
    mx.clearRect(gm.left, gm.top, gm.width, gm.height);
  }
  mx.drawImage(bmp, gm.left, gm.top);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(m, 0, 0);
  ctx.restore();
}

function drawNode(ctx: Ctx2D, l: Layer, all: Layer[], o: RenderOptions, clipped: Layer[] = []) {
  if (!l.visible || l.kind === 'adjustment') return;
  if (l.kind === 'group') {
    const isolate = l.blendMode !== 'pass through' || l.opacity < 1 || !!l.meta?.groupMask || clipped.length > 0;
    if (!isolate) { renderChildren(ctx, l.id, all, o); return; }
    const c = makeCanvas(o.width, o.height);
    const cx = c.getContext('2d')!;
    renderChildren(cx, l.id, all, o);
    applyGroupMask(cx, l, o);
    applyClipped(cx, clipped, all, o);
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = blendOp(l.blendMode);
    ctx.drawImage(c, 0, 0);
    ctx.restore();
    return;
  }
  const visibleClipped = clipped.filter((c) => c.visible && c.kind !== 'adjustment');
  if (!visibleClipped.length) { drawLeaf(ctx, l, o); return; }
  const base = makeCanvas(o.width, o.height);
  const bx = base.getContext('2d')!;
  drawLeaf(bx, l, o, { asBase: true });
  applyClipped(bx, visibleClipped, all, o);
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.globalCompositeOperation = blendOp(l.blendMode);
  ctx.drawImage(base, 0, 0);
  ctx.restore();
}

/** Draw clipped layers onto `bx`, restricted to the current alpha of `bx`. */
function applyClipped(bx: Ctx2D, clipped: Layer[], all: Layer[], o: RenderOptions) {
  if (!clipped.length) return;
  const baseAlpha = makeCanvas(o.width, o.height);
  baseAlpha.getContext('2d')!.drawImage(bx.canvas as AnyCanvas, 0, 0);
  for (const c of clipped) {
    if (!c.visible || c.kind === 'adjustment') continue;
    const t = makeCanvas(o.width, o.height);
    const tx = t.getContext('2d')!;
    drawNode(tx, { ...c, blendMode: c.kind === 'group' ? c.blendMode : 'normal' }, all, o);
    tx.globalCompositeOperation = 'destination-in';
    tx.drawImage(baseAlpha, 0, 0);
    bx.save();
    bx.globalCompositeOperation = c.kind === 'group' ? 'source-atop' : blendOp(c.blendMode);
    bx.drawImage(t, 0, 0);
    bx.restore();
  }
}

export function renderChildren(ctx: Ctx2D, parentId: string | null, all: Layer[], o: RenderOptions) {
  const kids = childrenOf(all, parentId);
  for (let i = 0; i < kids.length; i++) {
    const l = kids[i];
    if (l.clipping && i > 0) continue; // drawn with its base
    const clipped: Layer[] = [];
    for (let j = i + 1; j < kids.length && kids[j].clipping; j++) clipped.push(kids[j]);
    drawNode(ctx, l, all, o, clipped);
  }
}

export function renderDocument(ctx: Ctx2D, layers: Layer[], o: RenderOptions) {
  ctx.clearRect(0, 0, o.width, o.height);
  renderChildren(ctx, null, layers, o);
}

/** Render only the given top-level nodes (in render order) – used for merging. */
export function renderSubset(nodes: Layer[], all: Layer[], o: RenderOptions): OffscreenCanvas {
  const c = makeCanvas(o.width, o.height);
  const ctx = c.getContext('2d')!;
  for (const n of nodes) drawNode(ctx, n, all, o);
  return c;
}

/** Crop transparent borders. */
export function cropToContent(c: OffscreenCanvas): { canvas: OffscreenCanvas; left: number; top: number } | null {
  const ctx = c.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = makeCanvas(w, h);
  out.getContext('2d')!.drawImage(c, -minX, -minY);
  return { canvas: out, left: minX, top: minY };
}

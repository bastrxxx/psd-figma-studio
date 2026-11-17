import type { Layer, TextData } from './types';
import type { ImageStore } from './images';
import { childrenOf } from './tree';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS_BLEND: Record<string, string> = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color dodge': 'color-dodge', 'color burn': 'color-burn', 'hard light': 'hard-light', 'soft light': 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
  'linear dodge': 'plus-lighter',
};

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(b);
  });
}

function textSvg(t: TextData, id: string, style: string) {
  const lines = t.text.split('\n');
  const lh = t.leading ?? t.fontSize * 1.2;
  let x: number, y: number;
  if (t.shapeType === 'box' && t.box) {
    x = t.align === 'center' ? t.box.left + t.box.width / 2 : t.align === 'right' ? t.box.left + t.box.width : t.box.left;
    y = t.box.top + t.fontSize;
  } else { x = t.transform[4]; y = t.transform[5]; }
  const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
  const [r, g, b, a] = t.color;
  const tspans = lines.map((ln, i) => `<tspan x="${x.toFixed(2)}" ${i ? `dy="${lh.toFixed(2)}"` : ''}>${esc(ln) || ' '}</tspan>`).join('');
  return `<text id="${esc(id)}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="${esc(t.font)}" font-size="${t.fontSize}" fill="rgb(${r},${g},${b})"${a < 1 ? ` fill-opacity="${a}"` : ''} text-anchor="${anchor}" letter-spacing="${((t.tracking / 1000) * t.fontSize).toFixed(2)}"${style}>${tspans}</text>`;
}

/** Build an SVG that Figma imports with groups, layer names and editable text preserved. */
export async function exportSvg(name: string, width: number, height: number, layers: Layer[], store: ImageStore, onProgress?: (d: number, t: number) => void) {
  const total = layers.length;
  let done = 0;
  const out: string[] = [];
  const walk = async (pid: string | null, depth: number) => {
    for (const l of childrenOf(layers, pid)) {
      done++;
      if (done % 20 === 0) onProgress?.(done, total);
      if (l.kind === 'adjustment') continue;
      const styles: string[] = [];
      if (!l.visible) styles.push('display:none');
      if (l.blendMode && CSS_BLEND[l.blendMode]) styles.push(`mix-blend-mode:${CSS_BLEND[l.blendMode]}`);
      const op = l.kind === 'group' ? l.opacity : l.opacity * l.fillOpacity;
      const style = (styles.length ? ` style="${styles.join(';')}"` : '') + (op < 1 ? ` opacity="${op.toFixed(3)}"` : '');
      const pad = '  '.repeat(depth);
      if (l.kind === 'group') {
        out.push(`${pad}<g id="${esc(l.name)}"${style}>`);
        await walk(l.id, depth + 1);
        out.push(`${pad}</g>`);
      } else if (l.kind === 'text' && l.text) {
        out.push(pad + textSvg(l.text, l.name, style));
      } else {
        const blob = store.blobs.get(l.id);
        if (!blob) continue;
        const href = await blobToDataUrl(blob);
        out.push(`${pad}<image id="${esc(l.name)}" x="${l.left}" y="${l.top}" width="${l.width}" height="${l.height}" href="${href}"${style}/>`);
      }
    }
  };
  await walk(null, 1);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<title>${esc(name)}</title>\n${out.join('\n')}\n</svg>`;
}

export function download(data: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

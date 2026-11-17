export type LayerKind = 'group' | 'pixel' | 'text' | 'shape' | 'smart' | 'adjustment' | 'fill';

/** Reference to a PNG image stored in Vercel Blob (optionally a byte range inside a bundle). */
export interface ImageRef {
  url: string;
  offset?: number;
  length?: number;
}

export interface TextRun {
  start: number;
  end: number;
  font?: string;
  fontSize?: number; // already scaled to px
  color?: [number, number, number, number];
  fauxBold?: boolean;
  fauxItalic?: boolean;
  underline?: boolean;
  tracking?: number;
}

export interface TextData {
  text: string;
  font: string; // PostScript name from PSD
  fontSize: number; // px (scaled by transform)
  color: [number, number, number, number]; // rgba 0-255, a 0-1
  align: 'left' | 'center' | 'right' | 'justify';
  tracking: number; // 1/1000 em
  leading?: number; // px, undefined = auto
  shapeType: 'point' | 'box';
  box?: { left: number; top: number; width: number; height: number };
  transform: number[]; // [xx, xy, yx, yy, tx, ty]
  runs: TextRun[];
  stroke?: { color: [number, number, number, number]; width: number };
  edited?: boolean; // true once user changed text → render live instead of PSD raster
}

export interface LayerEffects {
  dropShadow?: { color: [number, number, number, number]; opacity: number; angle: number; distance: number; size: number; blendMode: string }[];
  innerShadow?: { color: [number, number, number, number]; opacity: number; angle: number; distance: number; size: number; blendMode: string }[];
  outerGlow?: { color: [number, number, number, number]; opacity: number; size: number; blendMode: string };
  colorOverlay?: { color: [number, number, number, number]; opacity: number; blendMode: string };
  stroke?: { color: [number, number, number, number]; opacity: number; size: number; position: string };
}

export interface Layer {
  id: string;
  parentId: string | null;
  position: number; // index inside parent, 0 = bottom-most (like Figma)
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number; // 0..1
  fillOpacity: number; // 0..1
  blendMode: string; // PSD blend mode name
  clipping: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  image?: ImageRef | null;
  text?: TextData | null;
  meta?: {
    effects?: LayerEffects;
    groupMask?: { image: ImageRef; left: number; top: number; width: number; height: number; defaultColor: number } | null;
    adjustment?: string;
    collapsed?: boolean;
    merged?: boolean;
  } | null;
}

export interface DocumentInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  layerCount: number;
  previewUrl: string | null;
  composite: ImageRef | null;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentWithLayers extends DocumentInfo {
  layers: Layer[];
}

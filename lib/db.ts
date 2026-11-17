import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import type { DocumentInfo, Layer } from './types';

let _sql: NeonQueryFunction<false, false> | null = null;
let _schemaReady: Promise<void> | null = null;

export function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL chưa được cấu hình');
    _sql = neon(url);
  }
  return _sql;
}

export async function ensureSchema() {
  if (!_schemaReady) {
    const sql = getSql();
    _schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        width INT NOT NULL,
        height INT NOT NULL,
        layer_count INT NOT NULL DEFAULT 0,
        preview_url TEXT,
        file_size BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS composite JSONB`;
      await sql`CREATE TABLE IF NOT EXISTS layers (
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        parent_id TEXT,
        position INT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        visible BOOLEAN NOT NULL DEFAULT true,
        opacity REAL NOT NULL DEFAULT 1,
        fill_opacity REAL NOT NULL DEFAULT 1,
        blend_mode TEXT NOT NULL DEFAULT 'normal',
        clipping BOOLEAN NOT NULL DEFAULT false,
        "left" INT NOT NULL DEFAULT 0,
        top INT NOT NULL DEFAULT 0,
        width INT NOT NULL DEFAULT 0,
        height INT NOT NULL DEFAULT 0,
        image JSONB,
        text JSONB,
        meta JSONB,
        PRIMARY KEY (doc_id, id)
      )`;
    })().catch((e) => {
      _schemaReady = null;
      throw e;
    });
  }
  return _schemaReady;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToDoc(r: any): DocumentInfo {
  return {
    id: r.id,
    name: r.name,
    width: r.width,
    height: r.height,
    layerCount: r.layer_count,
    previewUrl: r.preview_url,
    composite: r.composite ?? null,
    fileSize: Number(r.file_size),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToLayer(r: any): Layer {
  return {
    id: r.id,
    parentId: r.parent_id,
    position: r.position,
    name: r.name,
    kind: r.kind,
    visible: r.visible,
    opacity: r.opacity,
    fillOpacity: r.fill_opacity,
    blendMode: r.blend_mode,
    clipping: r.clipping,
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    image: r.image,
    text: r.text,
    meta: r.meta,
  };
}

/** Replace the whole layer set of a document in one transaction. */
export async function replaceLayers(docId: string, layers: Layer[]) {
  const sql = getSql();
  const payload = JSON.stringify(
    layers.map((l) => ({
      id: l.id,
      parent_id: l.parentId,
      position: l.position,
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      opacity: l.opacity,
      fill_opacity: l.fillOpacity,
      blend_mode: l.blendMode,
      clipping: l.clipping,
      left: Math.round(l.left),
      top: Math.round(l.top),
      width: Math.round(l.width),
      height: Math.round(l.height),
      image: l.image ?? null,
      text: l.text ?? null,
      meta: l.meta ?? null,
    }))
  );
  await sql.transaction([
    sql`DELETE FROM layers WHERE doc_id = ${docId}`,
    sql`INSERT INTO layers (doc_id, id, parent_id, position, name, kind, visible, opacity, fill_opacity, blend_mode, clipping, "left", top, width, height, image, text, meta)
        SELECT ${docId}, x.id, x.parent_id, x.position, x.name, x.kind, x.visible, x.opacity, x.fill_opacity, x.blend_mode, x.clipping, x."left", x.top, x.width, x.height, x.image, x.text, x.meta
        FROM jsonb_to_recordset(${payload}::jsonb) AS x(
          id TEXT, parent_id TEXT, position INT, name TEXT, kind TEXT, visible BOOLEAN, opacity REAL, fill_opacity REAL,
          blend_mode TEXT, clipping BOOLEAN, "left" INT, top INT, width INT, height INT, image JSONB, text JSONB, meta JSONB)`,
    sql`UPDATE documents SET layer_count = ${layers.length}, updated_at = now() WHERE id = ${docId}`,
  ]);
}

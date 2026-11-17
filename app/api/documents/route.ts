import { NextResponse } from 'next/server';
import { ensureSchema, getSql, replaceLayers, rowToDoc } from '@/lib/db';
import type { ImageRef, Layer } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`SELECT * FROM documents ORDER BY created_at DESC`;
    return NextResponse.json(rows.map(rowToDoc));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as {
      id: string;
      name: string;
      width: number;
      height: number;
      previewUrl: string | null;
      composite: ImageRef | null;
      fileSize: number;
      layers: Layer[];
    };
    if (!body.id || !body.name || !Array.isArray(body.layers)) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 });
    }
    const sql = getSql();
    await sql`INSERT INTO documents (id, name, width, height, layer_count, preview_url, composite, file_size)
              VALUES (${body.id}, ${body.name}, ${body.width}, ${body.height}, ${body.layers.length}, ${body.previewUrl}, ${body.composite ? JSON.stringify(body.composite) : null}::jsonb, ${body.fileSize})`;
    await replaceLayers(body.id, body.layers);
    return NextResponse.json({ id: body.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

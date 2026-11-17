import { NextResponse } from 'next/server';
import { del, list } from '@vercel/blob';
import { ensureSchema, getSql, rowToDoc, rowToLayer } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    await ensureSchema();
    const sql = getSql();
    const docs = await sql`SELECT * FROM documents WHERE id = ${id}`;
    if (!docs.length) return NextResponse.json({ error: 'Không tìm thấy file' }, { status: 404 });
    const layers = await sql`SELECT * FROM layers WHERE doc_id = ${id} ORDER BY parent_id NULLS FIRST, position`;
    return NextResponse.json({ ...rowToDoc(docs[0]), layers: layers.map(rowToLayer) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { name } = (await req.json()) as { name?: string };
    await ensureSchema();
    const sql = getSql();
    if (name) await sql`UPDATE documents SET name = ${name}, updated_at = now() WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    await ensureSchema();
    const sql = getSql();
    // Remove every blob that belongs to this document
    let cursor: string | undefined;
    do {
      const res = await list({ prefix: `docs/${id}/`, cursor, limit: 1000 });
      if (res.blobs.length) await del(res.blobs.map((b) => b.url));
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);
    await sql`DELETE FROM documents WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

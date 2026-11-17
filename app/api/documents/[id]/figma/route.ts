import { NextResponse } from 'next/server';
import { ensureSchema, getSql, rowToDoc, rowToLayer } from '@/lib/db';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export function OPTIONS() {
  return new NextResponse(null, { headers: CORS });
}

/** JSON consumed by the PSD → Figma plugin (figma-plugin/ folder). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await ensureSchema();
    const sql = getSql();
    const docs = await sql`SELECT * FROM documents WHERE id = ${id}`;
    if (!docs.length) return NextResponse.json({ error: 'Không tìm thấy file' }, { status: 404, headers: CORS });
    const layers = await sql`SELECT * FROM layers WHERE doc_id = ${id} ORDER BY parent_id NULLS FIRST, position`;
    return NextResponse.json(
      { format: 'psd-figma-studio/v1', ...rowToDoc(docs[0]), layers: layers.map(rowToLayer) },
      { headers: CORS }
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: CORS });
  }
}

import { NextResponse } from 'next/server';
import { ensureSchema, replaceLayers } from '@/lib/db';
import type { Layer } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { layers } = (await req.json()) as { layers: Layer[] };
    if (!Array.isArray(layers)) return NextResponse.json({ error: 'layers phải là mảng' }, { status: 400 });
    await ensureSchema();
    await replaceLayers(id, layers);
    return NextResponse.json({ ok: true, count: layers.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

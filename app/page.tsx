'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { DocumentInfo } from '@/lib/types';
import { importPsd, type ImportProgress } from '@/lib/importer';

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

export default function Home() {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<(ImportProgress & { file: string }) | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/documents', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setDocs(j);
    } catch (e) {
      setError((e as Error).message);
      setDocs([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      if (!/\.(psd|psb)$/i.test(file.name)) { setError(`${file.name}: chỉ hỗ trợ file .psd`); continue; }
      try {
        setProgress({ file: file.name, stage: 'Bắt đầu…', pct: 0 });
        await importPsd(file, (p) => setProgress({ ...p, file: file.name }));
        await load();
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`);
      }
    }
    setProgress(null);
  };

  const remove = async (d: DocumentInfo) => {
    if (!confirm(`Xóa "${d.name}"? Toàn bộ layer và ảnh sẽ bị xóa khỏi database.`)) return;
    const r = await fetch(`/api/documents/${d.id}`, { method: 'DELETE' });
    if (!r.ok) setError((await r.json()).error);
    load();
  };

  return (
    <main className="home">
      <h1>🎨 PSD Figma Studio</h1>
      <div className="sub">Đọc toàn bộ layer, text, group, mask, hiệu ứng trong file PSD · sắp xếp / gộp / xóa layer · lưu trên database · xuất sang Figma giữ nguyên layer và text.</div>

      <div
        className={`drop ${over ? 'over' : ''}`}
        onClick={() => !progress && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!progress) handleFiles(e.dataTransfer.files); }}
      >
        <b>⬆ Kéo thả file .psd vào đây hoặc bấm để chọn</b>
        <div className="sub" style={{ margin: '6px 0 0' }}>File được phân tích ngay trên trình duyệt (hỗ trợ file lớn hàng trăm MB), sau đó ảnh layer được lưu lên Vercel Blob và dữ liệu layer vào Postgres.</div>
        <input ref={inputRef} type="file" accept=".psd,.psb" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {progress && (
        <div className="progress">
          <div><b>{progress.file}</b> — {progress.stage}</div>
          <div className="bar"><div style={{ width: `${progress.pct}%` }} /></div>
        </div>
      )}
      {error && <div className="err">{error}</div>}

      {docs === null ? (
        <div className="empty">Đang tải…</div>
      ) : docs.length === 0 ? (
        <div className="empty">Chưa có file nào. Hãy tải lên file PSD đầu tiên.</div>
      ) : (
        <div className="grid">
          {docs.map((d) => (
            <div className="card" key={d.id}>
              <Link href={`/doc/${d.id}`} className="thumb" style={{ backgroundImage: d.previewUrl ? `url(${d.previewUrl})` : undefined }} />
              <div className="body">
                <div className="name" title={d.name}>{d.name}</div>
                <div className="meta">{d.width}×{d.height}px · {d.layerCount} layer · {fmtSize(d.fileSize)}</div>
                <div className="meta">Cập nhật {new Date(d.updatedAt).toLocaleString('vi-VN')}</div>
                <div className="actions">
                  <Link href={`/doc/${d.id}`} className="btn primary sm">Mở</Link>
                  <button className="btn danger sm" onClick={() => remove(d)}>🗑 Xóa</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

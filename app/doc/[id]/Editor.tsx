'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { DocumentWithLayers, Layer } from '@/lib/types';
import { emptyStore, loadImages, type ImageStore } from '@/lib/images';
import { BLEND_MODES, cropToContent, ensureFont, fontAvailable, renderDocument, renderSubset } from '@/lib/render';
import { childrenOf, deleteLayers, moveLayers, newId, normalize, renderOrder, topMostSelection, type DropWhere } from '@/lib/tree';
import { uploadBlob } from '@/lib/importer';
import { download, exportSvg } from '@/lib/export-svg';

const KIND_ICON: Record<string, string> = { group: '📁', pixel: '🖼', text: 'T', shape: '◆', smart: '🧩', adjustment: '◐', fill: '■' };
const KIND_LABEL: Record<string, string> = { group: 'Group', pixel: 'Pixel', text: 'Text', shape: 'Shape', smart: 'Smart Object', adjustment: 'Adjustment', fill: 'Fill' };

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const toHex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): [number, number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];

export default function Editor({ id }: { id: string }) {
  const [doc, setDoc] = useState<DocumentWithLayers | null>(null);
  const [layers, setLayersRaw] = useState<Layer[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [imgProgress, setImgProgress] = useState<[number, number]>([0, 0]);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [showComposite, setShowComposite] = useState(false);
  const [zoom, setZoom] = useState(0.5);
  const [busy, setBusy] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [drag, setDrag] = useState<{ ids: string[]; over: string | null; where: DropWhere } | null>(null);
  const [fontTick, setFontTick] = useState(0);

  const storeRef = useRef<ImageStore>(emptyStore());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const history = useRef<{ past: Layer[][]; future: Layer[][] }>({ past: [], future: [] });
  const layersRef = useRef<Layer[]>([]);
  layersRef.current = layers;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromise = useRef<Promise<void> | null>(null);

  // ---------- load ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/documents/${id}`, { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        if (cancelled) return;
        const d = j as DocumentWithLayers;
        setDoc(d);
        setLayersRaw(d.layers);
        for (const l of d.layers) if (l.text?.font) ensureFont(l.text.font, () => setFontTick((t) => t + 1));
        await loadImages(d.layers, d.composite, storeRef.current, (a, b) => !cancelled && setImgProgress([a, b]));
        if (cancelled) return;
        setReady(true);
        const stageW = stageRef.current?.clientWidth ?? window.innerWidth - 340;
        setZoom(Math.min(1, (stageW - 80) / d.width));
      } catch (e) {
        setLoadErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // ---------- persistence ----------
  const saveNow = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const p = (async () => {
      setSaveState('saving');
      try {
        const r = await fetch(`/api/documents/${id}/layers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layers: layersRef.current }),
        });
        if (!r.ok) throw new Error((await r.json()).error);
        setSaveState('saved');
      } catch (e) {
        console.error(e);
        setSaveState('error');
      }
    })();
    savePromise.current = p;
    return p;
  }, [id]);

  const setLayers = useCallback((next: Layer[] | ((prev: Layer[]) => Layer[]), opts: { record?: boolean } = {}) => {
    setLayersRaw((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      if (value === prev) return prev;
      if (opts.record !== false) {
        history.current.past.push(prev);
        if (history.current.past.length > 60) history.current.past.shift();
        history.current.future = [];
      }
      return value;
    });
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveNow(); }, 1200);
  }, [saveNow]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (saveState === 'dirty' || saveState === 'saving') { e.preventDefault(); } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [saveState]);

  const undo = useCallback(() => {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push(layersRef.current);
    setLayers(prev, { record: false });
  }, [setLayers]);
  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(layersRef.current);
    setLayers(next, { record: false });
  }, [setLayers]);

  // ---------- rendering ----------
  useEffect(() => {
    if (!ready || !doc || !canvasRef.current) return;
    const raf = requestAnimationFrame(() => {
      const c = canvasRef.current!;
      const ctx = c.getContext('2d')!;
      if (showComposite) {
        ctx.clearRect(0, 0, doc.width, doc.height);
        const comp = storeRef.current.bitmaps.get('composite');
        if (comp) ctx.drawImage(comp, 0, 0);
      } else {
        renderDocument(ctx, layers, { width: doc.width, height: doc.height, store: storeRef.current });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [layers, ready, doc, showComposite, fontTick]);

  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const sel = selected.map((s) => byId.get(s)).filter(Boolean) as Layer[];
  const one = sel.length === 1 ? sel[0] : null;

  // ---------- operations ----------
  const updateLayer = (lid: string, patch: Partial<Layer>, record = true) =>
    setLayers((prev) => prev.map((l) => (l.id === lid ? { ...l, ...patch } : l)), { record });

  const toggleVisible = (l: Layer) => updateLayer(l.id, { visible: !l.visible });

  const removeSelected = () => {
    if (!selected.length) return;
    if (!confirm(`Xóa ${selected.length} layer đã chọn?`)) return;
    setLayers((prev) => deleteLayers(prev, selected));
    setSelected([]);
  };

  const moveStep = (dir: 1 | -1) => {
    if (!one) return;
    setLayers((prev) => {
      const sibs = childrenOf(prev, one.parentId);
      const i = sibs.findIndex((s) => s.id === one.id);
      const j = i + dir;
      if (j < 0 || j >= sibs.length) return prev;
      const other = sibs[j];
      return prev.map((l) => (l.id === one.id ? { ...l, position: other.position } : l.id === other.id ? { ...l, position: one.position } : l));
    });
  };

  const groupSelected = () => {
    if (!selected.length) return;
    setLayers((prev) => {
      const tops = topMostSelection(prev, selected);
      const order = renderOrder(prev).map((l) => l.id);
      const topmost = prev.find((l) => l.id === [...tops].sort((a, b) => order.indexOf(a) - order.indexOf(b)).at(-1))!;
      const g: Layer = {
        id: newId('g'), parentId: topmost.parentId, position: topmost.position + 0.5, name: 'Group mới', kind: 'group',
        visible: true, opacity: 1, fillOpacity: 1, blendMode: 'pass through', clipping: false, left: 0, top: 0, width: 0, height: 0,
      };
      const withGroup = normalize([...prev, g]);
      return moveLayers(withGroup, tops, g.id, 'inside');
    });
  };

  const mergeSelected = async () => {
    if (!doc) return;
    const all = layersRef.current;
    const tops = topMostSelection(all, selected);
    if (!tops.length) return;
    if (tops.length === 1 && byId.get(tops[0])?.kind !== 'group') { alert('Chọn ít nhất 2 layer (giữ Ctrl/Shift) hoặc 1 group để gộp.'); return; }
    const hasText = tops.some((t) => byId.get(t)?.kind === 'text' || all.some((l) => l.kind === 'text' && l.parentId === t));
    if (hasText && !confirm('Gộp layer sẽ chuyển text thành ảnh (raster) giống Photoshop. Tiếp tục?')) return;
    setBusy('Đang gộp layer…');
    try {
      const order = renderOrder(all).map((l) => l.id);
      const nodes = tops.map((t) => byId.get(t)!).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const canvas = renderSubset(nodes, all, { width: doc.width, height: doc.height, store: storeRef.current });
      const cropped = cropToContent(canvas);
      const topmost = nodes[nodes.length - 1];
      if (!cropped) {
        setLayers((prev) => deleteLayers(prev, tops));
      } else {
        const blob = await cropped.canvas.convertToBlob({ type: 'image/png' });
        const url = await uploadBlob(`docs/${doc.id}/merged-${newId()}.png`, blob, 'image/png');
        const nl: Layer = {
          id: newId('m'), parentId: topmost.parentId, position: topmost.position + 0.5, name: topmost.name, kind: 'pixel',
          visible: true, opacity: 1, fillOpacity: 1, blendMode: 'normal', clipping: false,
          left: cropped.left, top: cropped.top, width: cropped.canvas.width, height: cropped.canvas.height,
          image: { url }, text: null, meta: { merged: true },
        };
        storeRef.current.blobs.set(nl.id, blob);
        storeRef.current.bitmaps.set(nl.id, await createImageBitmap(blob));
        setLayers((prev) => deleteLayers(normalize([...prev, nl]), tops));
        setSelected([nl.id]);
      }
    } catch (e) {
      alert('Gộp thất bại: ' + (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doExportSvg = async () => {
    if (!doc) return;
    setBusy('Đang tạo SVG…');
    try {
      const svg = await exportSvg(doc.name, doc.width, doc.height, layersRef.current, storeRef.current, (a, b) => setBusy(`Đang tạo SVG… ${a}/${b}`));
      download(new Blob([svg], { type: 'image/svg+xml' }), `${doc.name}.svg`);
    } finally { setBusy(null); }
  };
  const doExportPng = () => {
    if (!doc || !canvasRef.current) return;
    canvasRef.current.toBlob((b) => b && download(b, `${doc.name}.png`), 'image/png');
  };
  const openExport = async () => {
    if (saveState !== 'saved') await saveNow();
    setShowExport(true);
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); mergeSelected(); }
      else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); groupSelected(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
      else if (mod && e.key === ']') { e.preventDefault(); moveStep(1); }
      else if (mod && e.key === '[') { e.preventDefault(); moveStep(-1); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---------- layer panel rows ----------
  const rows = useMemo(() => {
    const out: { l: Layer; depth: number }[] = [];
    const visit = (pid: string | null, depth: number) => {
      const kids = childrenOf(layers, pid).reverse(); // top first
      for (const l of kids) {
        out.push({ l, depth });
        if (l.kind === 'group' && !l.meta?.collapsed) visit(l.id, depth + 1);
      }
    };
    visit(null, 0);
    return out;
  }, [layers]);

  const clickRow = (e: React.MouseEvent, l: Layer) => {
    if (e.shiftKey && anchor) {
      const ids = rows.map((r) => r.l.id);
      const a = ids.indexOf(anchor), b = ids.indexOf(l.id);
      setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(l.id) ? s.filter((x) => x !== l.id) : [...s, l.id]));
      setAnchor(l.id);
    } else {
      setSelected([l.id]);
      setAnchor(l.id);
    }
  };

  const onDragOver = (e: React.DragEvent, l: Layer) => {
    if (!drag) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const where: DropWhere = l.kind === 'group' ? (y < 0.25 ? 'above' : y > 0.75 ? 'below' : 'inside') : y < 0.5 ? 'above' : 'below';
    if (drag.over !== l.id || drag.where !== where) setDrag({ ...drag, over: l.id, where });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (drag?.over) setLayers((prev) => moveLayers(prev, drag.ids, drag.over, drag.where));
    setDrag(null);
  };

  // ---------- canvas picking ----------
  const pickCanvas = useRef<OffscreenCanvas | null>(null);
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!doc) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * doc.width;
    const y = ((e.clientY - rect.top) / rect.height) * doc.height;
    if (!pickCanvas.current) pickCanvas.current = new OffscreenCanvas(1, 1);
    const pc = pickCanvas.current.getContext('2d', { willReadFrequently: true })!;
    const order = renderOrder(layers).reverse();
    const hiddenByAncestor = (l: Layer): boolean => { let p = l.parentId; while (p) { const g = byId.get(p); if (!g || !g.visible) return true; p = g.parentId; } return false; };
    for (const l of order) {
      if (l.kind === 'group' || !l.visible || hiddenByAncestor(l)) continue;
      if (x < l.left || y < l.top || x >= l.left + l.width || y >= l.top + l.height) continue;
      const bmp = storeRef.current.bitmaps.get(l.id);
      if (!bmp) continue;
      pc.clearRect(0, 0, 1, 1);
      pc.drawImage(bmp, Math.floor(x - l.left), Math.floor(y - l.top), 1, 1, 0, 0, 1, 1);
      if (pc.getImageData(0, 0, 1, 1).data[3] > 10) {
        setSelected([l.id]);
        setAnchor(l.id);
        // expand ancestors
        const anc: string[] = [];
        let p = l.parentId; while (p) { anc.push(p); p = byId.get(p)?.parentId ?? null; }
        if (anc.some((a) => byId.get(a)?.meta?.collapsed)) {
          setLayers((prev) => prev.map((x2) => (anc.includes(x2.id) && x2.meta?.collapsed ? { ...x2, meta: { ...x2.meta, collapsed: false } } : x2)), { record: false });
        }
        setTimeout(() => document.getElementById('row-' + l.id)?.scrollIntoView({ block: 'nearest' }), 50);
        return;
      }
    }
    setSelected([]);
  };

  // ---------- render ----------
  if (loadErr) return <div className="loading"><div className="err">{loadErr}</div><Link href="/" className="btn">← Về trang chủ</Link></div>;
  if (!doc || !ready)
    return (
      <div className="loading">
        <div>Đang tải {doc ? `"${doc.name}"` : ''}… {imgProgress[1] ? `${imgProgress[0]}/${imgProgress[1]} ảnh layer` : ''}</div>
        <div className="bar"><div style={{ width: `${imgProgress[1] ? (imgProgress[0] / imgProgress[1]) * 100 : 5}%` }} /></div>
      </div>
    );

  const exportUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/documents/${doc.id}/figma` : '';
  const selBoxes = sel.filter((l) => l.kind !== 'group' && l.width > 0);
  const textCount = layers.filter((l) => l.kind === 'text').length;

  return (
    <div className="editor">
      <div className="topbar">
        <div className="title">
          <Link href="/" className="btn sm">←</Link>
          <span title={doc.name}>{doc.name}</span>
          <span className="save-state">{doc.width}×{doc.height} · {layers.length} layer · {textCount} text</span>
          <span className="save-state">{saveState === 'saved' ? '✓ Đã lưu' : saveState === 'saving' ? 'Đang lưu…' : saveState === 'dirty' ? '● Chưa lưu' : '⚠ Lỗi lưu'}</span>
        </div>
        {busy && <span className="save-state">{busy}</span>}
        <button className="btn sm" onClick={undo} title="Ctrl+Z">↶</button>
        <button className="btn sm" onClick={redo} title="Ctrl+Shift+Z">↷</button>
        <button className="btn sm" onClick={() => saveNow()} title="Ctrl+S">💾 Lưu</button>
        <button className="btn sm" onClick={doExportPng}>PNG</button>
        <button className="btn primary sm" onClick={openExport}>Xuất Figma</button>
      </div>

      <div className="stage" ref={stageRef}>
        <div className="stage-tools">
          <button className="btn sm" onClick={() => setZoom((z) => Math.max(0.05, z / 1.25))}>−</button>
          <span style={{ alignSelf: 'center', minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button className="btn sm" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>+</button>
          <button className="btn sm" onClick={() => setZoom(Math.min(1, ((stageRef.current?.clientWidth ?? 1200) - 80) / doc.width))}>Vừa</button>
          <button className="btn sm" onClick={() => setZoom(1)}>100%</button>
          <label className="btn sm" title="Ảnh composite gốc do Photoshop lưu trong file">
            <input type="checkbox" checked={showComposite} onChange={(e) => setShowComposite(e.target.checked)} /> Ảnh gốc PSD
          </label>
        </div>
        <div className="stage-inner" style={{ width: doc.width * zoom, height: doc.height * zoom }}>
          <canvas ref={canvasRef} width={doc.width} height={doc.height} onClick={onCanvasClick} />
          {!showComposite && selBoxes.map((l) => (
            <div key={l.id} className="sel-box" style={{ left: l.left * zoom, top: l.top * zoom, width: l.width * zoom, height: l.height * zoom }} />
          ))}
        </div>
      </div>

      <aside className="side">
        <h4>Thuộc tính {sel.length > 1 && <span>({sel.length} layer)</span>}</h4>
        <div className="props">
          {!one && sel.length === 0 && <div className="info">Chọn layer ở bảng bên dưới hoặc bấm trực tiếp lên ảnh. Ctrl/Shift để chọn nhiều. Kéo thả để đổi thứ tự / đưa vào group.</div>}
          {sel.length > 1 && <div className="info">Đã chọn {sel.length} layer. Ctrl+E để gộp, Ctrl+G để nhóm, Delete để xóa.</div>}
          {one && (
            <>
              <div className="row"><label>Tên</label><input value={one.name} onChange={(e) => updateLayer(one.id, { name: e.target.value })} /></div>
              <div className="row"><label>Loại</label><span>{KIND_ICON[one.kind]} {KIND_LABEL[one.kind]}{one.meta?.adjustment ? ` (${one.meta.adjustment})` : ''}{one.meta?.merged ? ' · đã gộp' : ''}</span></div>
              <div className="row"><label>Opacity</label><input type="range" min={0} max={1} step={0.01} value={one.opacity} onChange={(e) => updateLayer(one.id, { opacity: +e.target.value })} /><span style={{ flex: 'none', width: 36 }}>{Math.round(one.opacity * 100)}%</span></div>
              <div className="row"><label>Blend</label>
                <select value={one.blendMode} onChange={(e) => updateLayer(one.id, { blendMode: e.target.value })}>
                  {BLEND_MODES.filter((m) => one.kind === 'group' || m !== 'pass through').map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="row"><label>Hiển thị</label><input type="checkbox" checked={one.visible} onChange={() => toggleVisible(one)} style={{ flex: 'none' }} />
                {one.kind !== 'group' && <><span style={{ flex: 'none', marginLeft: 12 }}>Clipping mask</span><input type="checkbox" checked={one.clipping} onChange={(e) => updateLayer(one.id, { clipping: e.target.checked })} style={{ flex: 'none' }} /></>}
              </div>
              {one.kind !== 'group' && <div className="info">Vị trí x:{one.left} y:{one.top} · {one.width}×{one.height}px</div>}
              {one.meta?.effects && <div className="info">Hiệu ứng: {Object.keys(one.meta.effects).join(', ')}</div>}
              {one.text && (
                <>
                  <div className="row" style={{ alignItems: 'flex-start' }}><label>Nội dung</label>
                    <textarea rows={3} value={one.text.text} onChange={(e) => updateLayer(one.id, { text: { ...one.text!, text: e.target.value, edited: true } })} />
                  </div>
                  <div className="row"><label>Font</label><span title={one.text.font} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{one.text.font} {fontAvailable(one.text.font) ? '✓' : <span className="info">(máy chưa cài)</span>}</span></div>
                  <div className="row"><label>Cỡ chữ</label><input type="number" step={0.5} value={one.text.fontSize} onChange={(e) => updateLayer(one.id, { text: { ...one.text!, fontSize: +e.target.value, runs: [], edited: true } })} /></div>
                  <div className="row"><label>Màu</label><input type="color" value={toHex(one.text.color)} onChange={(e) => updateLayer(one.id, { text: { ...one.text!, color: fromHex(e.target.value), runs: [], edited: true } })} /></div>
                  <div className="row"><label>Căn lề</label>
                    <select value={one.text.align} onChange={(e) => updateLayer(one.id, { text: { ...one.text!, align: e.target.value as 'left', edited: true } })}>
                      <option value="left">Trái</option><option value="center">Giữa</option><option value="right">Phải</option><option value="justify">Đều</option>
                    </select>
                  </div>
                  {one.text.edited && <button className="btn sm" onClick={() => updateLayer(one.id, { text: { ...one.text!, edited: false } })}>Hiển thị lại ảnh text gốc từ PSD</button>}
                  <div className="info">{one.text.edited ? 'Text đang được vẽ trực tiếp (đã chỉnh sửa).' : 'Đang hiển thị ảnh text gốc từ PSD; chỉnh sửa sẽ chuyển sang vẽ trực tiếp.'}</div>
                </>
              )}
            </>
          )}
        </div>
        <h4>
          Layers
          <span className="sp">
            <button className="btn sm" title="Lên (Ctrl+])" disabled={!one} onClick={() => moveStep(1)}>▲</button>
            <button className="btn sm" title="Xuống (Ctrl+[)" disabled={!one} onClick={() => moveStep(-1)}>▼</button>
            <button className="btn sm" title="Nhóm (Ctrl+G)" disabled={!sel.length} onClick={groupSelected}>📁</button>
            <button className="btn sm" title="Gộp layer (Ctrl+E)" disabled={!sel.length} onClick={mergeSelected}>⧉ Gộp</button>
            <button className="btn sm danger" title="Xóa (Delete)" disabled={!sel.length} onClick={removeSelected}>🗑</button>
          </span>
        </h4>
        <div className="layers" onDragOver={(e) => drag && e.preventDefault()} onDrop={onDrop}>
          {rows.map(({ l, depth }) => {
            const isSel = selected.includes(l.id);
            const dropCls = drag?.over === l.id ? `drop-${drag.where}` : '';
            return (
              <div
                key={l.id}
                id={'row-' + l.id}
                className={`lrow ${isSel ? 'sel' : ''} ${!l.visible ? 'hidden-layer' : ''} ${dropCls}`}
                style={{ paddingLeft: 4 + depth * 14 }}
                draggable={renaming !== l.id}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); setDrag({ ids: isSel ? selected : [l.id], over: null, where: 'above' }); }}
                onDragOver={(e) => onDragOver(e, l)}
                onDragEnd={() => setDrag(null)}
                onClick={(e) => clickRow(e, l)}
                onDoubleClick={() => setRenaming(l.id)}
              >
                <span className={`eye ${l.visible ? '' : 'off'}`} onClick={(e) => { e.stopPropagation(); toggleVisible(l); }}>👁</span>
                <span className="caret" onClick={(e) => { if (l.kind !== 'group') return; e.stopPropagation(); updateLayer(l.id, { meta: { ...(l.meta ?? {}), collapsed: !l.meta?.collapsed } }, false); }}>
                  {l.kind === 'group' ? (l.meta?.collapsed ? '▸' : '▾') : ''}
                </span>
                {l.clipping && <span className="clip" title="Clipping mask">↳</span>}
                <span className="ico">{KIND_ICON[l.kind]}</span>
                <span className="nm">
                  {renaming === l.id ? (
                    <input autoFocus defaultValue={l.name} onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { updateLayer(l.id, { name: e.target.value || l.name }); setRenaming(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : l.name}
                </span>
                {l.meta?.effects && <span className="badge">fx</span>}
                {l.kind === 'smart' && <span className="badge">SO</span>}
              </div>
            );
          })}
        </div>
      </aside>

      {showExport && (
        <div className="modal-bg" onClick={() => setShowExport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Xuất sang Figma</h3>
            <p><b>Cách 1 — Plugin Figma (khuyên dùng, giữ nguyên toàn bộ layer, group, clipping mask, hiệu ứng và text có thể sửa):</b></p>
            <ol>
              <li>Tải plugin: <a href="/psd-figma-plugin.zip" download>psd-figma-plugin.zip</a> và giải nén.</li>
              <li>Mở <b>Figma Desktop</b> → Menu → Plugins → Development → <b>Import plugin from manifest…</b> → chọn file <code>manifest.json</code>.</li>
              <li>Chạy plugin <b>PSD Figma Studio Importer</b>, dán URL bên dưới rồi bấm <b>Nhập vào Figma</b>.</li>
            </ol>
            <div className="copy">
              <input readOnly value={exportUrl} onFocus={(e) => e.target.select()} />
              <button className="btn primary" onClick={() => navigator.clipboard.writeText(exportUrl)}>Copy</button>
            </div>
            <p><b>Cách 2 — File SVG:</b> tải file SVG rồi kéo thả vào Figma. Group, tên layer và text (dạng text sửa được) được giữ nguyên; clipping mask và hiệu ứng có thể không đầy đủ.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={doExportSvg} disabled={!!busy}>⬇ Tải SVG</button>
              <button className="btn" onClick={() => download(new Blob([JSON.stringify({ ...doc, layers }, null, 1)], { type: 'application/json' }), `${doc.name}.json`)}>⬇ Tải JSON layer</button>
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setShowExport(false)}>Đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

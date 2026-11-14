import { useEffect, useMemo, useRef, useState } from 'react';
import { add, fromAngle, inflate, rectOfPoints, rectUnion, type P, type Rect } from '../chem/geometry';
import { analyzeFragment, targetFragments } from '../chem/analysis';
import { freeDirection } from '../render/labels';
import { COMPOUND_MIME } from './LibraryPanel';
import { adjacency } from '../chem/model';
import { kindOf } from '../chem/model';
import { valenceErrors } from '../chem/hydrogens';
import { ACS } from '../chem/style';
import { hitTest } from '../editor/hit';
import { beginSession, type Ctx, type Preview, type Session } from '../editor/interaction';
import { useEditor, type EditorStore } from '../editor/store';
import { layout, type Prim } from '../render/layout';
import { fragmentOf, ringPreview, rotateHandle, selectionFrame } from '../editor/tools2';
import { pageDims, pagesBox, type PageSetup } from '../chem/page';
import { partPreview } from '../chem/partOps';

import { schemeTargetOf, type SchemeTarget } from '../scheme/pick';

const HILITE = '#3b82f6';
/** 右ボタン: これより動かしたらドラッグ（表示を動かす）、動かさなければメニュー。環を回す操作と同じ 3 pt */
const MENU_SLOP = 3;

/** 表示の位置と拡大率。x, y は画面の左上に来る文書の座標（pt） */
export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** 縮小の下限。大きなキャンバスでも全体を表示できるように */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function Canvas({ store, view, setView, showStereo, marks, onDropCompound, onLabelEdit, onTextEdit, onMenu, onBusy, onSchemeEdit }: {
  /** 右ボタンを押しただけのとき（ドラッグしなかったとき）。at は画面の座標、hit は押した物 */
  onMenu?(at: { x: number; y: number }, hit: string | null): void;
  /** スキームの矢印・条件の文字・番号の文字をダブルクリックした（図の上で直す） */
  onSchemeEdit?(target: SchemeTarget): void;
  /** ドラッグなどの操作の始まりと終わり（選んだ物の帯を、操作の間は隠すため） */
  onBusy?(busy: boolean): void;
  showStereo?: boolean;
  /** 分析の欄（NMR の予測）で指した原子。緑で強く示す */
  marks?: string[];
  /** ライブラリの化合物がキャンバスに落とされた */
  onDropCompound?(compoundId: string, at: P): void;
  store: EditorStore;
  view: View;
  setView(v: View | ((v: View) => View)): void;
  onLabelEdit(atomId: string): void;
  onTextEdit(textId: string | null, at: P): void;
}) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  // 選んだ原子が塩（まとまり）に入っていれば、まとまり全体を薄い点線の枠で示す（docs/salt-design.md）
  const unitFrames = useMemo(() => {
    const units = new Set<string>();
    for (const id of selection) {
      const u = doc.atoms[id]?.unit;
      if (u) units.add(u);
    }
    return [...units]
      .map((u) => rectOfPoints(Object.values(doc.atoms).filter((a) => a.unit === u)))
      .filter((r): r is Rect => !!r)
      .map((r) => inflate(r, 12));
  }, [doc, selection]);
  const hover = useEditor(store, (s) => s.hover);
  const tool = useEditor(store, (s) => s.tool);
  const lay = useMemo(() => layout(doc), [doc]);
  // スキームの枠（構造の分からない仮の化合物: 結合の無い「*」の原子）は、おかしな原子ではなく、点線の枠で示す
  const placeholders = useMemo(
    () => Object.values(doc.atoms).filter((a) => a.ref && a.element === '*' && !Object.values(doc.bonds).some((b) => b.a1 === a.id || b.a2 === a.id)).map((a) => a.id),
    [doc],
  );
  const errors = useMemo(() => {
    const e = valenceErrors(doc);
    return new Set([...e].filter((id) => !placeholders.includes(id)));
  }, [doc, placeholders]);
  const drafts = useMemo(() => draftFrames(doc, lay), [doc, lay]);
  // R/S の表示（分析パネルで切り替える）。原子の空いている向きに小さく出す
  const stereoLabels = useMemo(() => {
    if (!showStereo) return [];
    const adj = adjacency(doc);
    const out: { id: string; x: number; y: number; label: string }[] = [];
    for (const f of targetFragments(doc, new Set())) {
      try {
        const r = analyzeFragment(doc, f);
        if ('error' in r) continue;
        for (const s of r.stereo) {
          const a = doc.atoms[s.atomId];
          const p = add(a, fromAngle(freeDirection(a, doc, adj), 7.5));
          out.push({ id: s.atomId, x: p.x, y: p.y, label: `(${s.label})` });
        }
        // 二重結合の E/Z は、結合の中ほどの横に出す（2 本目の線の反対側）
        for (const s of r.bondStereo) {
          const b = doc.bonds[s.bondId];
          const p = doc.atoms[b.a1];
          const q = doc.atoms[b.a2];
          const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          const nx = -(q.y - p.y) / L;
          const ny = (q.x - p.x) / L;
          out.push({ id: s.bondId, x: (p.x + q.x) / 2 - nx * 6, y: (p.y + q.y) / 2 - ny * 6, label: `(${s.label})` });
        }
      } catch {
        // 解析できない分子は表示しない
      }
    }
    return out;
  }, [doc, showStereo]);
  const svgRef = useRef<SVGSVGElement>(null);
  const session = useRef<Session | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoom = view.zoom;
  const toDoc = (e: { clientX: number; clientY: number }): P => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return { x: view.x + (e.clientX - r.left) / zoom, y: view.y + (e.clientY - r.top) / zoom };
  };

  // スペースを押している間は、ドラッグで表示を動かす（ChemDraw などと同じ）
  const spaceDown = useRef(false);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number; right: boolean } | null>(null);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code === 'Space' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) {
        spaceDown.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ホイールで表示を動かし、Ctrl（Mac は ⌘）＋ホイールでカーソルの位置を中心に拡大・縮小する
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-e.deltaY * 0.002)));
          const px = v.x + (e.clientX - r.left) / v.zoom;
          const py = v.y + (e.clientY - r.top) / v.zoom;
          return { zoom: z, x: px - (e.clientX - r.left) / z, y: py - (e.clientY - r.top) / z };
        }
        return { ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [setView]);

  const ctx: Ctx = { store, layout: lay, setPreview, openLabelEditor: onLabelEdit, openTextEditor: onTextEdit };

  const onPointerDown = (e: React.PointerEvent) => {
    // 表示を動かす: 中ボタン・スペース＋左ボタン・右ボタンのドラッグ（ホワイトボードのように手繰り寄せる）
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown.current)) {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, right: e.button === 2 };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toDoc(e);
    const hit = hitTest(store.get().doc, lay, p);
    session.current = beginSession(ctx, p, hit, { shift: e.shiftKey, alt: e.altKey });
    onBusy?.(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const s0 = pan.current;
      setView((v) => ({ ...v, x: s0.vx - (e.clientX - s0.x) / v.zoom, y: s0.vy - (e.clientY - s0.y) / v.zoom }));
      return;
    }
    const p = toDoc(e);
    if (session.current) {
      session.current.move(p, { shift: e.shiftKey, alt: e.altKey });
      return;
    }
    const hit = hitTest(store.get().doc, lay, p);
    if (hit !== store.get().hover) store.set({ hover: hit });
    const st = store.get();
    const rp = st.tool === 'part' && st.part ? partPreview(st.doc, st.part.structure, p, hit) : ringPreview(st.doc, st.tool, p, hit);
    if (rp || preview) setPreview(rp ? { prims: rp } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (pan.current) {
      const s0 = pan.current;
      pan.current = null;
      // 右ボタンを押してから 3 pt より動かさずに離したら、表示は動かさず、メニューを出す
      if (s0.right && Math.hypot(e.clientX - s0.x, e.clientY - s0.y) <= MENU_SLOP * zoom) {
        setView((v) => ({ ...v, x: s0.vx, y: s0.vy }));
        onMenu?.({ x: e.clientX, y: e.clientY }, hitTest(store.get().doc, lay, toDoc(e)));
      }
      return;
    }
    const s = session.current;
    session.current = null;
    onBusy?.(false);
    if (s) s.up(toDoc(e), { shift: e.shiftKey, alt: e.altKey });
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const p = toDoc(e);
    const hit = hitTest(store.get().doc, lay, p);
    const t = store.get().tool;
    // スキームの矢印・条件・番号は、データを直す小さな欄を出す（文字を直接直しても、描き直すと戻るため）
    if (hit && onSchemeEdit && (kindOf(hit) === 'arrow' || kindOf(hit) === 'text')) {
      const target = schemeTargetOf(store.get().doc, hit);
      if (target) return onSchemeEdit(target);
    }
    if ((t === 'select' || t === 'lasso') && hit && (kindOf(hit) === 'atom' || kindOf(hit) === 'bond')) {
      store.set({ selection: fragmentOf(store.get().doc, hit) });
    } else if (hit && kindOf(hit) === 'atom') onLabelEdit(hit);
    else if (hit && kindOf(hit) === 'text') onTextEdit(hit, p);
  };

  const hl = (id: string, color: string, key: string) => {
    if (doc.atoms[id]) {
      const a = doc.atoms[id];
      const l = lay.labels.get(id);
      if (l && l.boxes.length) {
        return l.boxes.map((b, i) => {
          const r = inflate(b, 1.2);
          return <rect key={`${key}${i}`} x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1} fill={color} opacity={0.35} rx={1} />;
        });
      }
      return <circle key={key} cx={a.x} cy={a.y} r={3.2} fill={color} opacity={0.45} />;
    }
    if (doc.bonds[id]) {
      const b = doc.bonds[id];
      const p = doc.atoms[b.a1];
      const q = doc.atoms[b.a2];
      return <line key={key} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={color} strokeWidth={4} opacity={0.35} strokeLinecap="round" />;
    }
    if (doc.arrows[id]) {
      const r = doc.arrows[id];
      return <line key={key} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke={color} strokeWidth={7} opacity={0.3} strokeLinecap="round" />;
    }
    const sh = doc.shapes?.[id];
    if (sh) {
      return (
        <rect key={key} x={Math.min(sh.x1, sh.x2) - 2} y={Math.min(sh.y1, sh.y2) - 2} width={Math.abs(sh.x2 - sh.x1) + 4} height={Math.abs(sh.y2 - sh.y1) + 4} fill="none" stroke={color} strokeWidth={3} opacity={0.35} />
      );
    }
    const box = lay.textBoxes.get(id);
    if (box) return <rect key={key} x={box.x1 - 1} y={box.y1 - 1} width={box.x2 - box.x1 + 2} height={box.y2 - box.y1 + 2} fill={color} opacity={0.25} />;
    if (doc.pluses[id]) return <circle key={key} cx={doc.pluses[id].x} cy={doc.pluses[id].y} r={5} fill={color} opacity={0.3} />;
    return null;
  };

  return (
    <svg
      ref={svgRef}
      data-testid="canvas"
      width={size.w}
      height={size.h}
      viewBox={`${view.x} ${view.y} ${size.w / zoom} ${size.h / zoom}`}
      className={`canvas tool-${tool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (session.current) return;
        store.set({ hover: null });
        setPreview(null);
      }}
      onDoubleClick={onDoubleClick}
      // 右ボタンはドラッグで表示を動かすのに使うので、ブラウザのメニューは出さない
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(COMPOUND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(COMPOUND_MIME);
        if (!id) return;
        e.preventDefault();
        onDropCompound?.(id, toDoc(e));
      }}
    >
      <rect x={view.x} y={view.y} width={size.w / zoom} height={size.h / zoom} fill={doc.page ? 'var(--canvas-outside, #e6e9ef)' : '#fff'} />
      {doc.page && <Pages page={doc.page} zoom={zoom} />}
      {/* 言葉から作った下書き: 薄い枠と、確かめてほしい化合物の橙の点線の枠（押せる印は App の issue-mark） */}
      <g className="drafts" pointerEvents="none">
        {drafts.map((f) => (
          <g key={f.id} data-testid="draft-frame">
            <rect x={f.box.x1} y={f.box.y1} width={f.box.x2 - f.box.x1} height={f.box.y2 - f.box.y1} fill="#fffbeb" stroke="#f59e0b" strokeWidth={0.6} strokeDasharray="4 2" rx={3} />
            <text x={f.box.x1 + 2} y={f.box.y1 - 3} fontFamily={ACS.font} fontSize={7} fill="#b45309">下書き: 右の欄で確定</text>
            {f.issues.map((r, i) => (
              <rect key={i} data-testid="draft-issue" x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1} fill="none" stroke="#d97706" strokeWidth={0.8} strokeDasharray="3 2" rx={2} />
            ))}
          </g>
        ))}
      </g>
      {/* 選択の印は、線とラベルが読めるように薄く描く */}
      <g className="selection" opacity={0.55}>{[...selection].map((id) => hl(id, HILITE, `s${id}`))}</g>
      {unitFrames.length > 0 && (
        <g className="unit-frames" pointerEvents="none" data-testid="unit-frame">
          {unitFrames.map((r, i) => (
            <rect key={i} x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1} fill="none" stroke={HILITE} strokeOpacity={0.6} strokeWidth={0.6} strokeDasharray="2 2" rx={3} />
          ))}
        </g>
      )}
      {marks && marks.length > 0 && (
        <g className="nmr-marks" data-testid="nmr-marks" data-ids={marks.join(' ')}>
          {marks.map((id) => hl(id, '#16a34a', `n${id}`))}
        </g>
      )}
      {hover && !selection.has(hover) && <g className="hover">{hl(hover, '#f59e0b', `h${hover}`)}</g>}
      <g className="placeholders" pointerEvents="none">
        {placeholders.map((id) => {
          const b = (lay.labels.get(id)?.boxes ?? []).reduce<Rect | null>((r, x) => rectUnion(r, x), null);
          const a = doc.atoms[id];
          const r = b ?? { x1: a.x - 8, y1: a.y - 8, x2: a.x + 8, y2: a.y + 8 };
          return <rect key={id} data-testid="placeholder-frame" x={r.x1 - 6} y={r.y1 - 8} width={r.x2 - r.x1 + 12} height={r.y2 - r.y1 + 16} fill="none" stroke="#94a3b8" strokeWidth={0.8} strokeDasharray="4 3" rx={4} />;
        })}
      </g>
      <g className="errors">
        {[...errors].map((id) => {
          const a = doc.atoms[id];
          return <rect key={id} x={a.x - 6} y={a.y - 6} width={12} height={12} fill="none" stroke="#dc2626" strokeWidth={0.6} />;
        })}
      </g>
      <g className="drawing">{lay.prims.map((p, i) => renderPrim(p, i))}</g>
      <g className="stereo-labels" pointerEvents="none">
        {stereoLabels.map((s) => (
          <text key={s.id} x={s.x} y={s.y + 2} textAnchor="middle" fontFamily={ACS.font} fontSize={5.5} fill={s.label === '(?)' ? '#b45309' : '#1d4ed8'} data-testid="stereo-label">
            {s.label}
          </text>
        ))}
      </g>
      {(tool === 'select' || tool === 'lasso') && selection.size > 0 && <SelectionFrame doc={doc} selection={selection} />}
      {preview && (
        <g className="preview" opacity={0.5}>
          {preview.prims.map((p, i) => renderPrim(p, i, HILITE))}
          {preview.outline && (
            <polygon points={preview.outline.map((q) => `${q.x},${q.y}`).join(' ')} fill="rgba(59,130,246,0.08)" stroke={HILITE} strokeWidth={0.5} strokeDasharray="2 2" />
          )}
        </g>
      )}
    </svg>
  );
}

/** ページの紙（白）と、ページの境目（点線）。ページの外は灰色で、印刷されない */
function Pages({ page, zoom }: { page: PageSetup; zoom: number }) {
  const { w, h } = pageDims(page);
  const box = pagesBox(page);
  const px = 1 / zoom;
  return (
    <g className="pages" pointerEvents="none" data-testid="pages" data-cols={page.cols} data-rows={page.rows}>
      <rect x={box.x1 + 2 * px} y={box.y1 + 3 * px} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="rgba(15,23,42,0.12)" />
      <rect x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="#fff" stroke="#b8c0cc" strokeWidth={px} />
      {Array.from({ length: page.cols - 1 }, (_, i) => (
        <line key={`c${i}`} x1={(i + 1) * w} y1={box.y1} x2={(i + 1) * w} y2={box.y2} stroke="#b8c0cc" strokeWidth={px} strokeDasharray={`${6 * px} ${4 * px}`} />
      ))}
      {Array.from({ length: page.rows - 1 }, (_, i) => (
        <line key={`r${i}`} x1={box.x1} y1={(i + 1) * h} x2={box.x2} y2={(i + 1) * h} stroke="#b8c0cc" strokeWidth={px} strokeDasharray={`${6 * px} ${4 * px}`} />
      ))}
    </g>
  );
}

function SelectionFrame({ doc, selection }: { doc: import('../chem/model').Doc; selection: Set<string> }) {
  const r = selectionFrame(doc, selection);
  const h = rotateHandle(doc, selection);
  if (!r) return null;
  return (
    <g className="frame" pointerEvents="none">
      <rect x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1} fill="none" stroke={HILITE} strokeWidth={0.4} strokeDasharray="2 1.5" />
      {h && (
        <>
          <line x1={h.x} y1={h.y} x2={h.x} y2={r.y1} stroke={HILITE} strokeWidth={0.4} />
          <circle cx={h.x} cy={h.y} r={2.6} fill="#fff" stroke={HILITE} strokeWidth={0.6} data-testid="rotate-handle" />
        </>
      )}
    </g>
  );
}

export function renderPrim(p: Prim, key: number, over?: string) {
  // 下書きや選択の色（over）が無ければ、物の色（無ければ黒）
  const color = over ?? p.color ?? '#000';
  switch (p.k) {
    case 'line':
      return <line key={key} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke={color} strokeWidth={p.w} strokeLinecap="round" data-owner={p.owner} />;
    case 'poly':
      return <polygon key={key} points={p.pts.map((q) => `${q.x},${q.y}`).join(' ')} fill={color} stroke={color} strokeWidth={0.2} strokeLinejoin="round" data-owner={p.owner} />;
    case 'path':
      return <path key={key} d={p.d} fill="none" stroke={color} strokeWidth={p.w} strokeLinecap="round" data-owner={p.owner} />;
    case 'tline': {
      let cur = 0;
      return (
        <text key={key} x={p.x} y={p.y} fontFamily={ACS.font} fontSize={p.runs[0]?.size ?? ACS.captionSize} fontWeight={p.bold ? 'bold' : undefined} fill={color} data-owner={p.owner} style={{ userSelect: 'none' }}>
          {p.runs.map((r, i) => {
            const dy = r.shift - cur;
            cur = r.shift;
            return (
              <tspan key={i} fontSize={r.size} dy={dy || undefined} fontStyle={r.italic ? 'italic' : undefined} fontWeight={r.bold ? 'bold' : undefined}>
                {r.text}
              </tspan>
            );
          })}
        </text>
      );
    }
    case 'text':
      return (
        <text key={key} x={p.run.x} y={p.run.y} fontFamily={ACS.font} fontSize={p.run.size} fontWeight={p.run.bold ? 'bold' : undefined} fill={color} data-owner={p.owner} style={{ userSelect: 'none' }}>
          {p.run.text}
        </text>
      );
  }
}

/** 下書きのスキームの範囲と、要確認の化合物の範囲 */
function draftFrames(doc: import('../chem/model').Doc, lay: { textBoxes: Map<string, Rect>; labels: Map<string, { boxes: Rect[] }> }): { id: string; box: Rect; issues: Rect[] }[] {
  const { textBoxes } = lay;
  // 原子の範囲（ラベルがあれば、ラベルの文字の範囲も）
  const atomBox = (atoms: import('../chem/model').Atom[]) =>
    atoms.reduce<Rect | null>((r, a) => (lay.labels.get(a.id)?.boxes ?? []).reduce((q, b) => rectUnion(q, b), rectUnion(r, { x1: a.x, y1: a.y, x2: a.x, y2: a.y })), null);
  const out: { id: string; box: Rect; issues: Rect[] }[] = [];
  for (const s of Object.values(doc.schemes ?? {})) {
    if (!s.draft) continue;
    const atoms = Object.values(doc.atoms).filter((a) => a.ref?.startsWith(`${s.id}:`));
    let box = atomBox(atoms);
    for (const r of Object.values(doc.arrows)) if (r.ref === s.id) box = rectUnion(box, rectOfPoints([{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }])!);
    for (const t of Object.values(doc.texts)) if (t.ref === s.id && textBoxes.get(t.id)) box = rectUnion(box, textBoxes.get(t.id)!);
    if (!box) continue;
    const issues = [...new Set(s.draft.issues.map((i) => i.compoundId).filter((c): c is string => !!c))]
      .map((c) => atomBox(atoms.filter((a) => a.ref === `${s.id}:${c}`)))
      .filter((r): r is Rect => !!r)
      .map((r) => inflate(r, 6));
    out.push({ id: s.id, box: inflate(box, 16), issues });
  }
  return out;
}

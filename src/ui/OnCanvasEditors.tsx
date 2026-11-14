// 図の上で直す: スキームの矢印や条件の文字、化合物の番号をダブルクリックすると、そのそばに小さな入力欄を出す。
// 右の欄を探さなくても、見えている所で直せるようにする
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { track } from '../analytics';
import type { Doc } from '../chem/model';
import { importText } from '../io/convert';
import type { EditorStore } from '../editor/store';
import { useEditor } from '../editor/store';
import { addStepWithProduct, freeFragments, updateCompound, updateStep } from '../scheme/ops';
import { schemeArrows, type SchemeTarget } from '../scheme/pick';
import type { View } from './Canvas';
import { resolveName } from './NewSchemeForm';
import { Field, parseYield, reagentsFromText, reagentsToText } from './SchemePanel';

/** 押した物（段・化合物）の、文書の座標での置き場所（小さな欄を出す所） */
function anchorOf(doc: Doc, t: SchemeTarget): { x: number; y: number } | null {
  if (t.kind === 'step') {
    const r = schemeArrows(doc, t.schemeId)[t.stepIndex];
    if (!r) return null;
    // 矢印の下の条件の文字（多くて 3 行）の下
    const below = Object.values(doc.texts).filter((x) => x.ref === t.schemeId && x.y > r.y1 && x.y < r.y1 + 60 && x.x >= Math.min(r.x1, r.x2) - 40 && x.x <= Math.max(r.x1, r.x2));
    return { x: Math.min(r.x1, r.x2), y: Math.max(r.y1 + 8, ...below.map((x) => x.y + 4)) };
  }
  const atoms = Object.values(doc.atoms).filter((a) => a.ref === `${t.schemeId}:${t.compoundId}`);
  if (!atoms.length) return null;
  const x1 = Math.min(...atoms.map((a) => a.x));
  const x2 = Math.max(...atoms.map((a) => a.x));
  const y2 = Math.max(...atoms.map((a) => a.y));
  return { x: (x1 + x2) / 2 - 40, y: y2 + 30 };
}

/** キャンバスの上の小さな欄の枠。外を押すか Esc で閉じる。はじめの入力欄にカーソルを入れる */
function Popover({ at, view, onClose, children, testId, focus }: { at: { x: number; y: number }; view: View; onClose(): void; children: ReactNode; testId: string; focus?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = (focus ? el?.querySelector<HTMLInputElement>(`[data-testid="${focus}"]`) : null) ?? el?.querySelector<HTMLInputElement>('input');
    first?.focus();
    first?.select();
    const onDown = (e: PointerEvent) => {
      if (!el?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 開くきっかけのダブルクリックで閉じないよう、次の描画の後から聞く
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
    // 開いたときに 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // キャンバスからはみ出すときは、中に入るように寄せる
  const [fit, setFit] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const left = Math.max(8, (at.x - view.x) * view.zoom);
  const top = Math.max(8, (at.y - view.y) * view.zoom + 8);
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = el?.offsetParent as HTMLElement | null;
    if (!el || !stage) return;
    const dx = Math.min(0, stage.clientWidth - 8 - (left + el.offsetWidth));
    const dy = Math.min(0, stage.clientHeight - 8 - (top + el.offsetHeight));
    if (dx !== fit.dx || dy !== fit.dy) setFit({ dx, dy });
  }, [left, top, fit.dx, fit.dy]);
  return (
    <div className="canvas-pop" ref={ref} data-testid={testId} style={{ left: Math.max(8, left + fit.dx), top: Math.max(8, top + fit.dy) }}>
      {children}
    </div>
  );
}

/** 段の条件を、矢印のそばで直す。field は、押した文字に合うはじめの入力欄 */
export function SchemeEditPopover({ store, target, view, onClose }: { store: EditorStore; target: SchemeTarget; view: View; onClose(): void }) {
  const doc = useEditor(store, (s) => s.doc);
  const scheme = doc.schemes?.[target.schemeId];
  const at = anchorOf(doc, target);
  // スキームが消えた・段が減ったら閉じる
  const gone = !scheme || !at || (target.kind === 'step' && !scheme.steps[target.stepIndex]) || (target.kind === 'compound' && !doc.compounds?.[target.compoundId]);
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (gone || !scheme || !at) return null;
  if (target.kind === 'compound') {
    const c = doc.compounds![target.compoundId];
    const cid = target.compoundId;
    return (
      <Popover at={at} view={view} onClose={onClose} testId="compound-pop">
        <div className="canvas-pop-grid two">
          <Field label="番号" testId="pop-number" value={c.number ?? ''} onCommit={(v) => store.commit(updateCompound(store.get().doc, cid, { number: v || undefined }))} />
          <Field label="呼び名" testId="pop-nickname" value={c.nickname ?? ''} onCommit={(v) => store.commit(updateCompound(store.get().doc, cid, { nickname: v || undefined }))} />
        </div>
        <p className="canvas-pop-foot">Enter で確定、Esc で閉じる</p>
      </Popover>
    );
  }
  const i = target.stepIndex;
  const sid = target.schemeId;
  const st = scheme.steps[i];
  const set = (patch: Parameters<typeof updateStep>[3]) => store.commit(updateStep(store.get().doc, sid, i, patch));
  return (
    <Popover at={at} view={view} onClose={onClose} testId="step-pop">
      <h4>
        段 {i + 1}
        <button type="button" className="link" aria-label="閉じる" onClick={onClose}>✕</button>
      </h4>
      <div className="canvas-pop-grid">
        <Field label="試薬（当量は括弧で）" width="1 / 4" testId="pop-reagents" value={reagentsToText(st)} onCommit={(v) => set({ reagents: reagentsFromText(st, v) })} />
        <Field label="溶媒" width="1 / 3" testId="pop-solvent" value={st.solvent ?? ''} onCommit={(v) => set({ solvent: v || undefined })} />
        <Field label="収率（%）" testId="pop-yield" value={st.yield === undefined ? '' : String(st.yield)} onCommit={(v) => set({ yield: parseYield(v) })} />
        <Field label="温度" width="1 / 3" testId="pop-temp" value={st.temp ?? ''} onCommit={(v) => set({ temp: v || undefined })} />
        <Field label="時間" testId="pop-time" value={st.time ?? ''} onCommit={(v) => set({ time: v || undefined })} />
      </div>
      <p className="canvas-pop-foot">Tab で次の欄、Enter で確定、Esc で閉じる</p>
    </Popover>
  );
}

/** スキームの右端に出す「＋ 次の段」。押すと、選んだ分子か、名前・SMILES から生成物を足す */
export function NextStepGhost({ store, schemeId, view }: { store: EditorStore; schemeId: string; view: View }) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scheme = doc.schemes?.[schemeId];
  if (!scheme || scheme.pinned || scheme.draft || !scheme.steps.length) return null;
  // 最後の段の生成物の右
  const last = scheme.steps.at(-1)!.to[0];
  const atoms = Object.values(doc.atoms).filter((a) => a.ref === `${schemeId}:${last}`);
  if (!atoms.length) return null;
  const x = Math.max(...atoms.map((a) => a.x)) + 26;
  const y = (Math.min(...atoms.map((a) => a.y)) + Math.max(...atoms.map((a) => a.y))) / 2;
  const free = freeFragments(doc, selection);
  const one = selection.size > 0 && free.length === 1 ? free[0] : null;
  const addSelected = () => {
    if (!one) return;
    store.commit(addStepWithProduct(store.get().doc, schemeId, one), new Set());
    track('scheme:next-step-selected');
    setOpen(false);
  };
  const addNamed = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      const r = await resolveName(t);
      if (!r) return store.set({ message: `「${t}」を構造にできませんでした。SMILES で入れるか、キャンバスに描いて選んでください` });
      const d0 = store.get().doc;
      const placed = importText(d0, r.smiles);
      const ids = [...placed.ids].filter((id) => placed.doc.atoms[id]);
      store.commit(addStepWithProduct(placed.doc, schemeId, ids), new Set());
      track('scheme:next-step-named');
      setText('');
      setOpen(false);
    } catch (e) {
      store.set({ message: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  const left = (x - view.x) * view.zoom;
  const top = (y - view.y) * view.zoom;
  return (
    <>
      <button type="button" className="next-step" data-testid="next-step" style={{ left, top }} title="次の段を足す" onClick={() => setOpen((v) => !v)}>
        ＋ 次の段
      </button>
      {open && (
        <div className="canvas-pop" data-testid="next-step-pop" style={{ left: Math.max(8, left - 150), top: top + 34 }}>
          <label className="field">
            <span>生成物の名前か SMILES</span>
            <input
              data-testid="next-step-text"
              value={text}
              autoFocus
              placeholder="例: CC(N)C(=O)O"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addNamed();
                if (e.key === 'Escape') setOpen(false);
              }}
            />
          </label>
          <div className="row">
            <button type="button" className="primary" data-testid="next-step-add" disabled={busy || !text.trim()} onClick={() => void addNamed()}>
              段を足す
            </button>
            <button type="button" data-testid="next-step-selected" disabled={!one} title="キャンバスに描いた分子を選んでから押す" onClick={addSelected}>
              選んだ分子を生成物にする
            </button>
          </div>
        </div>
      )}
    </>
  );
}

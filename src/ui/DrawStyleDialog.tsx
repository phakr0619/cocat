// 図の設定: 図全体の線の太さと文字の大きさ。ファイルのメニューから開く
import { useEffect, useRef, useState } from 'react';
import { track } from '../analytics';
import { edit, type Doc } from '../chem/model';
import { DEFAULT_DRAW, type DrawStyle } from '../chem/style';
import type { EditorStore } from '../editor/store';
import { renderScheme } from '../scheme/layout';
import { renderTable } from '../table/layout';

const PRESETS: { name: string; style: Required<DrawStyle> }[] = [
  { name: 'ACS の論文（ChemDraw の ACS Document 1996）', style: { lineWidth: 0.6, fontSize: 10 } },
  { name: '発表用の太い線', style: { lineWidth: 1.0, fontSize: 10 } },
  { name: '大きい文字', style: { lineWidth: 0.8, fontSize: 12 } },
];

/** 図の設定を変え、文字の大きさで並びが変わるスキームと検討表を描き直す */
export function setDrawStyle(doc: Doc, style: DrawStyle): Doc {
  const same = (style.lineWidth ?? DEFAULT_DRAW.lineWidth) === DEFAULT_DRAW.lineWidth && (style.fontSize ?? DEFAULT_DRAW.fontSize) === DEFAULT_DRAW.fontSize;
  let d = edit(doc, (x) => {
    if (same) delete x.drawStyle;
    else x.drawStyle = { ...style };
  });
  for (const id of Object.keys(d.schemes ?? {})) d = renderScheme(d, id);
  for (const id of Object.keys(d.tables ?? {})) d = renderTable(d, id);
  return d;
}

export function DrawStyleDialog({ store, onClose }: { store: EditorStore; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cur = store.get().doc.drawStyle;
  const [lw, setLw] = useState(String(cur?.lineWidth ?? DEFAULT_DRAW.lineWidth));
  const [fs, setFs] = useState(String(cur?.fontSize ?? DEFAULT_DRAW.fontSize));
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const apply = (style: DrawStyle) => {
    store.commit(setDrawStyle(store.get().doc, style));
    track('draw-style');
  };
  const num = (s: string, lo: number, hi: number) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
  };
  return (
    <dialog ref={ref} className="about draw-style" data-testid="draw-style" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>図の設定</h2>
      <p className="muted">この文書の図全体の、線の太さと文字の大きさです。CDXML・CDX・SVG・PNG に書き出すときも、この大きさを使います。</p>
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => {
              setLw(String(p.style.lineWidth));
              setFs(String(p.style.fontSize));
              apply(p.style);
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <form
        method="dialog"
        onSubmit={() => apply({ lineWidth: num(lw, 0.2, 4), fontSize: num(fs, 5, 30) })}
      >
        <label className="field">
          <span>線の太さ（pt）</span>
          <input type="number" step="0.1" min="0.2" max="4" value={lw} onChange={(e) => setLw(e.target.value)} data-testid="draw-line-width" />
        </label>
        <label className="field">
          <span>文字の大きさ（pt）</span>
          <input type="number" step="1" min="5" max="30" value={fs} onChange={(e) => setFs(e.target.value)} data-testid="draw-font-size" />
        </label>
        <div className="row">
          <button type="submit" className="primary" data-testid="draw-style-apply">当てる</button>
          <button type="button" onClick={() => ref.current?.close()}>閉じる</button>
        </div>
      </form>
    </dialog>
  );
}

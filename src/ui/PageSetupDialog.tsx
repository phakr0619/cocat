// ページの設定: キャンバスを A4 かスライド 1 枚を単位に、横と縦に何枚並べるかで決める。設定のメニューから開く
import { renderScheme } from '../scheme/layout';
import { useEffect, useRef, useState } from 'react';
import { track } from '../analytics';
import { edit, type Doc } from '../chem/model';
import { MAX_PAGES, normalizePage, PAGE_SIZES, pagesToFit, type PageSetup, type PageSize } from '../chem/page';
import type { EditorStore } from '../editor/store';
import { layout } from '../render/layout';

/** ページの設定を変える（null でページの枠をやめる） */
export function setPage(doc: Doc, page: PageSetup | null): Doc {
  let out = edit(doc, (d) => {
    if (page) d.page = normalizePage(page);
    else delete d.page;
  });
  // スキームの行の幅はページに合わせるので、描き直す
  for (const id of Object.keys(out.schemes ?? {})) out = renderScheme(out, id);
  return out;
}

type SizeChoice = PageSize | 'none';

export function PageSetupDialog({ store, onClose, onApplied }: { store: EditorStore; onClose(): void; onApplied?(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cur = store.get().doc.page;
  const [size, setSize] = useState<SizeChoice>(cur?.size ?? 'a4');
  const [landscape, setLandscape] = useState(!!cur?.landscape);
  const [cols, setCols] = useState(String(cur?.cols ?? 1));
  const [rows, setRows] = useState(String(cur?.rows ?? 1));
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const current = (): PageSetup | null => (size === 'none' ? null : normalizePage({ size, landscape, cols: parseInt(cols, 10), rows: parseInt(rows, 10) }));
  const fit = () => {
    const p = current();
    if (!p) return;
    const f = pagesToFit(p, layout(store.get().doc).bbox);
    setCols(String(f.cols));
    setRows(String(f.rows));
  };
  const apply = () => {
    store.commit(setPage(store.get().doc, current()));
    track(`page:${size}`);
    onApplied?.();
  };
  return (
    <dialog ref={ref} className="about draw-style page-setup" data-testid="page-setup" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>ページの設定</h2>
      <p className="muted">キャンバスを、A4 か PowerPoint のスライド 1 枚を単位に、横と縦に並べた大きさにします。印刷と PDF では、1 ページずつ、その大きさの紙に原寸で出します。ページの外の灰色の所は、印刷されません。</p>
      <form method="dialog" onSubmit={apply}>
        <label className="field">
          <span>ページの大きさ</span>
          <select value={size} onChange={(e) => setSize(e.target.value as SizeChoice)} data-testid="page-size">
            {(Object.keys(PAGE_SIZES) as PageSize[]).map((k) => (
              <option key={k} value={k}>{PAGE_SIZES[k].name}</option>
            ))}
            <option value="none">ページにしない: どこまでも広いキャンバス</option>
          </select>
        </label>
        {size === 'a4' && (
          <label className="field">
            <span>向き</span>
            <select value={landscape ? 'landscape' : 'portrait'} onChange={(e) => setLandscape(e.target.value === 'landscape')} data-testid="page-orientation">
              <option value="portrait">縦</option>
              <option value="landscape">横</option>
            </select>
          </label>
        )}
        {size !== 'none' && (
          <div className="page-count">
            <label className="field">
              <span>横に（枚）</span>
              <input type="number" min={1} max={MAX_PAGES} value={cols} onChange={(e) => setCols(e.target.value)} data-testid="page-cols" />
            </label>
            <span className="times">×</span>
            <label className="field">
              <span>縦に（枚）</span>
              <input type="number" min={1} max={MAX_PAGES} value={rows} onChange={(e) => setRows(e.target.value)} data-testid="page-rows" />
            </label>
            <button type="button" onClick={fit} data-testid="page-fit" title="今の図が入る枚数にする">図に合わせる</button>
          </div>
        )}
        <div className="row">
          <button type="submit" className="primary" data-testid="page-apply">当てる</button>
          <button type="button" onClick={() => ref.current?.close()}>閉じる</button>
        </div>
      </form>
    </dialog>
  );
}

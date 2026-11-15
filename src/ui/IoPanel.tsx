import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '../analytics';
import { detectFormat, exportCdx, exportCdxml, exportMol, exportPng, exportSmiles, exportSvg, importText, labelReportText } from '../io/convert';
import type { LabelReport } from '../io/cdxml';
import { cdxToCdxml, isCdx } from '../io/cdx';
import type { EditorStore } from '../editor/store';
import { isDocFile, parseDocFile } from '../io/docfile';
import { baseNameOf, DEFAULT_FILE_BASE, fileNameFor } from '../io/filename';
import { useEditor } from '../editor/store';
import type { Doc } from '../chem/model';
import { isPngBytes, pngWithData, readPngData } from '../io/figureData';
import { findSlideFigures, isZipBytes, type SlideFigure } from '../io/pptx';
import { SlideFigurePicker } from './SlideFigurePicker';
import { extract } from '../chem/transform';
import type { Rect } from '../chem/geometry';
import { countOutside } from '../editor/visible';

/** Cocat の図が見つからなかったときの理由（docs/reopen-figure.md） */
export const NO_FIGURE_HELP =
  'Cocat からコピーして貼った図か、Cocat で書き出した PNG を挿入した図だけを開けます。PowerPoint の「図として保存」で取り出した画像からは開けないので、pptx のファイルを開いてください';

export function download(name: string, data: Blob | string, type: string) {
  // 書き出しの形式だけを数える（ファイルの名前や中身は送らない）
  track(`export:${(name.split('.').pop() ?? 'file').toLowerCase()}`);
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 開き直した図の名前（「発表 スライド 3」） */
const figureName = (file: string, f: SlideFigure) => `${baseNameOf(file)}${f.slides.length ? ` スライド ${f.slides[0]}` : ''}`;

export function IoPanel({ store, visibleRect, part = 'both', preview = false, testId = 'io-panel', initialOnlySelected = false }: {
  store: EditorStore;
  visibleRect?: Rect | null;
  /** 出す部分。書き出しの画面では書き出しだけを出す */
  part?: 'both' | 'import' | 'export';
  /** 書き出す範囲の絵を出す */
  preview?: boolean;
  testId?: string;
  /** はじめから「選んだ物だけ」にする */
  initialOnlySelected?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  /** pptx の中に Cocat の図が 2 つ以上あったとき、選ぶ画面に出すもの */
  const [picking, setPicking] = useState<{ fileName: string; figures: SlideFigure[] } | null>(null);
  /** スライドに貼った図・書き出した PNG から開き直す。.acedoc と同じく、今の文書と置き換える（元に戻すで戻せる） */
  const openFigure = (doc: Doc, name: string, kind: 'pptx' | 'png') => {
    store.commit(doc, new Set());
    store.set({ fileName: name });
    track(`import:figure-${kind}`);
    setError('');
  };
  const fileName = useEditor(store, (s) => s.fileName ?? '');
  /** ファイルから読んだら、その名前を書き出しの名前にする（文書を置き換えたとき、または名前がまだ無いとき） */
  const nameFrom = (filename: string | undefined, replaced: boolean) => {
    if (filename && (replaced || !store.get().fileName)) store.set({ fileName: baseNameOf(filename) });
  };
  const out = (ext: string) => fileNameFor(store.get().fileName, ext);
  /** ChemDraw のファイルで構造の抜けていたラベルを補った・読めなかったことを知らせる */
  const tellLabels = (r: LabelReport) => {
    const t = labelReportText(r);
    if (t) {
      store.set({ message: t });
      track('import:label-repair', { once: true });
    }
  };

  const load = (src: string, filename?: string) => {
    try {
      if (isDocFile(src)) {
        // エディタの文書は、今の文書と置き換える（元に戻すで戻せる）
        store.commit(parseDocFile(src), new Set());
        nameFrom(filename, true);
        track('import:acedoc');
        setError('');
        return;
      }
      const report: LabelReport = { repaired: [], unreadable: [] };
      const { doc, ids } = importText(store.get().doc, src, filename, report);
      store.commit(doc, ids);
      tellLabels(report);
      nameFrom(filename, false);
      track(`import:${detectFormat(src, filename)}`);
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const run = (fn: () => void | Promise<void>) => async () => {
    try {
      await fn();
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const hasSelection = useEditor(store, (s) => s.selection.size > 0);
  /** 選んだ物だけを書き出す（選んでいるときだけ効く） */
  const [onlySelected, setOnlySelected] = useState(initialOnlySelected);
  const selectedOnly = hasSelection && onlySelected;
  const current = useEditor(store, (s) => s.doc);
  /** 全体を書き出すとき、表示の外にある物の数（見えていない物まで書き出さないように知らせる） */
  const outside = !selectedOnly && visibleRect ? countOutside(current, visibleRect) : 0;
  /** 書き出す元の文書全体 */
  const whole = () => store.get().doc;
  /** 書き出す物: 選んだ物だけのときは、コピーと同じ範囲を取り出す */
  const doc = () => {
    const s = store.get();
    return selectedOnly && s.selection.size ? extract(s.doc, s.selection) : s.doc;
  };

  return (
    <section data-testid={testId}>
      {part !== 'export' && <>
      <h2>読み込み（SMILES / MOL / CDXML / CDX）</h2>
      <textarea
        data-testid="import-text"
        placeholder="SMILES、A.B>>C のような反応 SMILES、Molfile、CDXML を貼り付け"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button type="button" className="primary" data-testid="import-button" onClick={() => load(text)}>
          読み込む
        </button>
        <label className="file">
          ファイルを開く
          <input
            type="file"
            accept=".cdx,.cdxml,.mol,.sdf,.smi,.smiles,.txt,.acedoc,.pptx,.png"
            data-testid="import-file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              // ChemDraw のバイナリ（.cdx）は、CDXML に直して読む
              const bytes = new Uint8Array(await f.arrayBuffer());
              // PowerPoint のファイル: 中の Cocat の図を探す。1 つならすぐ開き、2 つ以上なら選ぶ画面を出す
              if (isZipBytes(bytes)) {
                try {
                  const figures = await findSlideFigures(bytes);
                  if (!figures.length) setError(`${f.name} の中に、Cocat で作った図が見つかりませんでした。${NO_FIGURE_HELP}`);
                  else if (figures.length === 1) openFigure(figures[0].doc, figureName(f.name, figures[0]), 'pptx');
                  else setPicking({ fileName: f.name, figures });
                } catch (err) {
                  setError(`${f.name} を読めませんでした: ${String((err as Error).message ?? err)}`);
                }
                return;
              }
              // 書き出した PNG: 中のデータから開く
              if (isPngBytes(bytes)) {
                try {
                  const doc = await readPngData(bytes);
                  if (doc) openFigure(doc, baseNameOf(f.name), 'png');
                  else setError(`この PNG には Cocat のデータが入っていません。${NO_FIGURE_HELP}`);
                } catch (err) {
                  setError(String((err as Error).message ?? err));
                }
                return;
              }
              if (isCdx(bytes)) {
                try {
                  const report: LabelReport = { repaired: [], unreadable: [] };
                  const { doc, ids } = importText(store.get().doc, cdxToCdxml(bytes), 'file.cdxml', report);
                  store.commit(doc, ids);
                  tellLabels(report);
                  nameFrom(f.name, false);
                  track('import:cdx');
                  setError('');
                } catch (err) {
                  setError(String((err as Error).message ?? err));
                }
              } else load(new TextDecoder().decode(bytes), f.name);
            }}
          />
        </label>
      </div>
      <p className="muted" data-testid="reopen-help">PowerPoint のファイル（.pptx）や、Cocat で書き出した PNG を開くと、Cocat からコピーして貼った図を開き直せます。</p>
      </>}
      {part !== 'import' && <>
      {part === 'both' && <h2>書き出し</h2>}
      {preview && <ExportPreview doc={selectedOnly ? extract(current, store.get().selection) : current} />}
      <p className="muted export-scope" data-testid="export-scope">
        {selectedOnly ? '選んだ物だけを書き出します。' : hasSelection ? 'キャンバス全体を書き出します。' : 'キャンバス全体を書き出します。分子などを選ぶと、選んだ物だけにもできます。'}
      </p>
      {outside > 0 && (
        <p className="export-outside" data-testid="export-outside">
          表示の外にも {outside} 個の物があります。「全体を表示」で確かめられます。
        </p>
      )}
      {hasSelection && (
        <label className="export-only-selected">
          <input type="checkbox" data-testid="export-only-selected" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
          選んだ物だけ書き出す
        </label>
      )}
      <label className="export-name">
        <span>ファイル名</span>
        <input
          data-testid="export-name"
          placeholder={DEFAULT_FILE_BASE}
          value={fileName}
          onChange={(e) => store.set({ fileName: e.target.value })}
          spellCheck={false}
        />
        <small className="muted">拡張子は形式に合わせて付きます</small>
      </label>
      <div className="row">
        <button type="button" onClick={run(() => download(out('.smi'), exportSmiles(doc()), 'text/plain'))}>SMILES</button>
        <button type="button" onClick={run(() => download(out('.mol'), exportMol(doc()), 'chemical/x-mdl-molfile'))}>MOL</button>
        <button type="button" onClick={run(() => download(out('.cdxml'), exportCdxml(doc()), 'chemical/x-cdxml'))}>CDXML</button>
        <button type="button" title="ChemDraw のバイナリの形式" onClick={run(() => download(out('.cdx'), new Blob([exportCdx(doc()) as BlobPart], { type: 'chemical/x-cdx' }), 'chemical/x-cdx'))}>CDX</button>
        <button type="button" onClick={run(() => download(out('.svg'), exportSvg(doc()), 'image/svg+xml'))}>SVG</button>
        <button type="button" title="図のデータを中に入れ、あとで Cocat で開き直せるようにする" onClick={run(async () => download(out('.png'), await pngWithData(await exportPng(doc()), whole(), doc()), 'image/png'))}>PNG</button>
      </div>
      </>}
      {error && <output className="error" data-testid="io-error">{error}</output>}
      {picking && (
        <SlideFigurePicker
          fileName={picking.fileName}
          figures={picking.figures}
          onPick={(fig) => {
            const from = picking.fileName;
            setPicking(null);
            if (fig) openFigure(fig.doc, figureName(from, fig), 'pptx');
          }}
        />
      )}
    </section>
  );
}

/** 書き出す範囲の絵。形式を選ぶ前に、何が書き出されるかを見せる */
function ExportPreview({ doc }: { doc: Doc }) {
  const src = useMemo(() => {
    try {
      const empty = !Object.keys(doc.atoms).length && !Object.keys(doc.arrows).length && !Object.keys(doc.texts).length && !Object.keys(doc.shapes ?? {}).length;
      return empty ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg(doc))}`;
    } catch {
      return null;
    }
  }, [doc]);
  return (
    <div className="export-preview" data-testid="export-preview">
      {src ? <img src={src} alt="書き出す範囲の絵" /> : <span className="muted">書き出す物がありません</span>}
    </div>
  );
}

/** 「書き出す」の画面: 書き出す範囲の絵・範囲・ファイル名・形式を 1 つにまとめる */
export function ExportDialog({ store, visibleRect, onlySelected, onCopyImage, onClose }: { store: EditorStore; visibleRect?: Rect | null; onlySelected?: boolean; onCopyImage(): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="about export-dialog" data-testid="export-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>書き出す</h2>
      <IoPanel store={store} visibleRect={visibleRect} part="export" preview testId="export-panel" initialOnlySelected={onlySelected} />
      <div className="row export-foot">
        <button type="button" data-testid="export-copy-image" title="Word や PowerPoint に貼れる画像でコピーする" onClick={() => (onCopyImage(), ref.current?.close())}>
          画像でコピー
        </button>
        <span className="spacer" />
        <button type="button" onClick={() => ref.current?.close()}>閉じる</button>
      </div>
    </dialog>
  );
}

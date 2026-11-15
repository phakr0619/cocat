// PDF のページと図の範囲を選ぶ画面。PDF はブラウザの中で開いたまま、外へは送らない
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { figureToCrop, findFigures } from '../llm/findFigures';
import { imageSummary, type PreparedImage } from '../llm/image';
import { isLowRes, type OpenedPdf, type PdfCrop } from '../llm/pdf';
import { providerInfo } from '../llm/providers';
import { getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { llmErrorText } from '../llm/types';
import { LlmConsent } from './LlmConsent';

/** 大きい絵の幅（px）の目安 */
const VIEW_WIDTH = 640;
/** 小さい絵の幅（px） */
const THUMB_WIDTH = 96;
/** これより小さいドラッグは、範囲として受けない（クリックのつもりの揺れ） */
const MIN_DRAG = 8;

/** 見えているときだけ描く、ページの小さい絵 */
function Thumb({ pdf, page, selected, onPick }: { pdf: OpenedPdf; page: number; selected: boolean; onPick(): void }) {
  const box = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    const c = canvas.current;
    let alive = true;
    void pdf.pageSize(page).then((size) => {
      if (alive) return pdf.renderPage(page, c, THUMB_WIDTH / size.width);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [visible, pdf, page]);
  return (
    <button type="button" ref={box} className={`pdf-thumb${selected ? ' on' : ''}`} data-testid="pdf-page-thumb" data-page={page} aria-label={`${page} ページ`} aria-current={selected} onClick={onPick}>
      <canvas ref={canvas} />
      <span>{page}</span>
    </button>
  );
}

/** AI で見つけた図の範囲（ページごと。PDF の座標、倍率 1）と、その状態 */
type Found =
  | { state: 'busy'; abort: AbortController }
  | { state: 'cancelled' }
  | { state: 'error'; text: string }
  | { state: 'done'; figures: { crop: PdfCrop; label: string }[] };

/**
 * ページを選び、大きい絵の上をドラッグして図の範囲を選ぶ。「この範囲を使う」で画像にして onUse に渡す（dpi は、範囲に重なる画像の最も低い解像度。画像が無ければ null）。
 * キーがあり同意済みなら、ページを開くと AI で図の範囲を探して先に描く
 */
export function PdfPickerDialog({
  pdf,
  fileName,
  onUse,
  onClose,
  si,
}: {
  pdf: OpenedPdf;
  fileName: string;
  onUse(image: PreparedImage, dpi: number | null): void;
  onClose(): void;
  /** SI（Supporting Information）の PDF を足す・外す・本文と入れ替える。無ければ出さない */
  si?: { file: { name: string; numPages: number } | null; error: string | null; onAdd(file: File): void; onRemove(): void; onSwap(): void };
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const siInput = useRef<HTMLInputElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  /** 大きい絵の倍率（ページの幅が VIEW_WIDTH px になる） */
  const [scale, setScale] = useState<number | null>(null);
  /** 選んだ範囲（大きい絵の上の px） */
  const [box, setBox] = useState<PdfCrop | null>(null);
  /** 利用者が範囲を消したページでは、見つけた範囲を描き直さない（ページを開き直したら、また描く） */
  const cleared = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 範囲に重なる画像の最も低い解像度（dpi）。画像が無ければ null */
  const [dpi, setDpi] = useState<number | null>(null);
  /** dpi を測り終えた所（「ページ」か「ページ:crop」）。E2E が、測り終えたかを data-dpi-at で待つ */
  const [dpiAt, setDpiAt] = useState('');
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const to = providerInfo(s.provider).label;
  const hasKey = !!s.apiKey;
  const [found, setFound] = useState<Record<number, Found>>({});
  /** 探し始めたページ（同じページは一度だけ。やめた・失敗したページは外して、押して探し直せるようにする） */
  const started = useRef(new Set<number>());
  const aborts = useRef(new Set<AbortController>());
  const [consent, setConsent] = useState(false);
  /** 「送る内容を見る」の、ページの画像の説明（ページごと） */
  const [summaries, setSummaries] = useState<Record<number, string>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const set = aborts.current;
    // 閉じたら、探している最中の呼び出しはやめる
    return () => set.forEach((a) => a.abort());
  }, []);
  // ページを替えたら、大きい絵を描き直し、範囲を消す
  useEffect(() => {
    let alive = true;
    cleared.current = false;
    setBox(null);
    setError(null);
    setScale(null);
    void (async () => {
      try {
        const size = await pdf.pageSize(page);
        const k = Math.min(VIEW_WIDTH / size.width, 3);
        if (!alive || !canvas.current) return;
        setScale(k);
        await pdf.renderPage(page, canvas.current, k);
      } catch {
        if (alive) setError('このページを描けませんでした');
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf, page]);

  /** このページ全体の画像を AI に送って、図の範囲を探す（結果はページごとに覚える） */
  const find = async (n: number) => {
    const llm = llmProvider();
    if (!llm || started.current.has(n)) return;
    started.current.add(n);
    const abort = new AbortController();
    aborts.current.add(abort);
    const put = (f: Found) => setFound((m) => ({ ...m, [n]: f }));
    const fail = (f: Found) => {
      started.current.delete(n);
      put(f);
    };
    put({ state: 'busy', abort });
    track('llm:pdf-find-figures');
    try {
      const img = await pdf.cropToImage(n);
      if (abort.signal.aborted) return fail({ state: 'cancelled' });
      if (!img.ok) return fail({ state: 'error', text: img.error });
      setSummaries((m) => ({ ...m, [n]: imageSummary(img.image) }));
      const r = await findFigures(llm, { image: { mimeType: img.image.mimeType, data: img.image.data }, signal: abort.signal });
      if (!r.ok) {
        if (r.error.kind === 'aborted') return fail({ state: 'cancelled' });
        track(`llm:error-${r.error.kind}`);
        return fail({ state: 'error', text: llmErrorText(r.error, getLlmSettings()) });
      }
      const size = await pdf.pageSize(n);
      // 反応スキームを先に。無ければ、矢印の無い構造の図
      const schemes = r.figures.filter((f) => f.kind === 'reaction-scheme');
      const list = schemes.length ? schemes : r.figures.filter((f) => f.kind === 'structure');
      put({ state: 'done', figures: list.map((f) => ({ crop: figureToCrop(f, size), label: f.label })) });
    } catch {
      fail({ state: 'error', text: '図の範囲を探せませんでした' });
    } finally {
      aborts.current.delete(abort);
    }
  };
  // キーがあり同意済みなら、ページを大きく表示したときに自動で探す
  useEffect(() => {
    if (scale && hasKey && s.consented && !started.current.has(page)) void find(page);
    // find は pdf と page だけに頼る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, scale, hasKey, s.consented]);

  const here = found[page];
  /** 見つけた図の範囲を、大きい絵の上の px にする */
  const onView = (c: PdfCrop): PdfCrop => ({ x: c.x * scale!, y: c.y * scale!, width: c.width * scale!, height: c.height * scale! });
  // 見つけた反応スキームが 1 つなら、範囲として先に描く（利用者がもう選んでいれば上書きしない）
  useEffect(() => {
    if (scale && !box && !cleared.current && here?.state === 'done' && here.figures.length === 1) setBox(onView(here.figures[0].crop));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, scale, box]);

  // 範囲（なければページ全体）の画像の解像度を測る
  useEffect(() => {
    if (!scale) {
      setDpiAt('');
      return setDpi(null);
    }
    let alive = true;
    const crop = box ? { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale } : undefined;
    void pdf.imageDpi(page, crop).then((d) => {
      if (!alive) return;
      setDpi(d);
      setDpiAt(crop ? `${page}:crop` : String(page));
    });
    return () => {
      alive = false;
    };
  }, [pdf, page, scale, box]);

  // 「送る内容を見る」を開いたら、このページの画像の説明を出す（送るのと同じ画像の大きさ）
  useEffect(() => {
    if (!previewOpen || summaries[page]) return;
    let alive = true;
    void pdf.cropToImage(page).then((r) => alive && r.ok && setSummaries((m) => ({ ...m, [page]: imageSummary(r.image) })));
    return () => {
      alive = false;
    };
  }, [previewOpen, page, pdf, summaries]);

  const point = (e: React.PointerEvent) => {
    const r = view.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  const rect = (a: { x: number; y: number }, b: { x: number; y: number }): PdfCrop => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
  const use = async () => {
    setBusy(true);
    setError(null);
    // 大きい絵の px を PDF の座標（倍率 1）に戻す
    const crop = box && scale ? { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale } : undefined;
    const r = await pdf.cropToImage(page, crop);
    const d = r.ok ? await pdf.imageDpi(page, crop) : null;
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onUse(r.image, d);
  };
  const lowRes = isLowRes(dpi);
  const choosing = scale && here?.state === 'done' && here.figures.length > 1 && !box;

  return (
    <>
      <dialog ref={ref} className="about pdf-picker" data-testid="pdf-picker" data-dpi={dpi ?? 'none'} data-dpi-at={dpiAt} onClose={onClose}>
        <h2>PDF から図を選ぶ</h2>
        <div className="muted" data-testid="pdf-notice">
          <p>PDF はこの端末の中で開き、外へは送りません。査読で預かった原稿は送らないでください。</p>
          <details>
            <summary>詳しく</summary>
            <p>{`${to}に送るのは、選んだ範囲の画像と、図のページ・図の化合物の段落の文字です。AI で図の範囲を探すときは、ページ全体の画像を送ります。`}未発表の論文や投稿前の原稿は、共著者や所属の決まりで、AI に入れてよいかを確かめてください。</p>
          </details>
        </div>
        <p className="muted">{fileName}（{pdf.numPages} ページ）。左でページを選び、右の絵の上をドラッグして図の範囲を選びます。選ばなければページ全体を使います。</p>
        {si && (
          <div className="pdf-si" data-testid="pdf-si">
            <div className="row">
              {si.file ? (
                <>
                  <span data-testid="pdf-si-name">{`SI: ${si.file.name}（${si.file.numPages} ページ）`}</span>
                  <button type="button" className="link" data-testid="pdf-si-swap" title="本文と SI を取り違えていたら" onClick={si.onSwap}>本文と入れ替える</button>
                  <button type="button" className="link" data-testid="pdf-si-remove" onClick={si.onRemove}>SI を外す</button>
                </>
              ) : (
                <>
                  <input
                    ref={siInput}
                    type="file"
                    hidden
                    accept="application/pdf,.pdf"
                    data-testid="pdf-si-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) si.onAdd(f);
                    }}
                  />
                  <button type="button" data-testid="pdf-si-add" onClick={() => siInput.current?.click()}>SI の PDF を足す</button>
                </>
              )}
            </div>
            <p className="muted">SI を足すと、図の化合物の合成手順を SI からも探し、条件を補って、名前と構造を確かめます。SI の PDF も外へは送りません。</p>
            {si.error && <p className="warn" data-testid="pdf-si-error">{si.error}</p>}
          </div>
        )}
        {hasKey && (
          <div className="pdf-find">
            {here?.state === 'busy' && (
              <p className="muted" data-testid="pdf-find-status">
                AI で図を探しています…
                <button type="button" className="link" data-testid="pdf-find-cancel" onClick={() => here.abort.abort()}>やめる</button>
              </p>
            )}
            {(!s.consented || here?.state === 'cancelled' || here?.state === 'error') && (
              <button
                type="button"
                data-testid="pdf-find"
                disabled={!scale}
                onClick={() => {
                  if (!getLlmSettings().consented) setConsent(true);
                  else void find(page);
                }}
              >
                AI で図の範囲を探す
              </button>
            )}
            {here?.state === 'error' && <p className="warn" data-testid="pdf-find-error">{here.text}。ドラッグで範囲を選んでください。</p>}
            {here?.state === 'done' && here.figures.length === 0 && <p className="muted" data-testid="pdf-find-none">図が見つかりませんでした。ドラッグで範囲を選んでください。</p>}
            {choosing && <p className="muted" data-testid="pdf-find-choose">図が複数あります。使う図を選んでください。</p>}
            {here?.state === 'done' && here.figures.length === 1 && <p className="muted" data-testid="pdf-find-one">AI が見つけた図の範囲を選んでおきました。ずれていれば、ドラッグで選び直してください。</p>}
            <details className="tts-preview" data-testid="pdf-find-details" onToggle={(e) => setPreviewOpen(e.currentTarget.open)}>
              <summary>送る内容を見る</summary>
              <pre data-testid="pdf-find-preview">{summaries[page] ?? '（ページの画像を作っています…）'}</pre>
              <p className="muted">{`図の位置を探すために、このページの画像を ${to}に送ります。`}</p>
            </details>
          </div>
        )}
        <div className="pdf-body">
          <div className="pdf-thumbs" aria-label="ページの一覧">
            {Array.from({ length: pdf.numPages }, (_, i) => (
              <Thumb key={i + 1} pdf={pdf} page={i + 1} selected={page === i + 1} onPick={() => setPage(i + 1)} />
            ))}
          </div>
          <div className="pdf-main">
            <div
              ref={view}
              className="pdf-view"
              data-testid="pdf-page-view"
              data-page={page}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = point(e);
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const r = rect(drag.current, point(e));
                if (r.width >= MIN_DRAG || r.height >= MIN_DRAG) setBox(r);
              }}
              onPointerUp={(e) => {
                if (!drag.current) return;
                const r = rect(drag.current, point(e));
                drag.current = null;
                if (r.width >= MIN_DRAG && r.height >= MIN_DRAG) setBox(r);
                else {
                  cleared.current = true;
                  setBox(null);
                }
                setError(null);
              }}
            >
              <canvas ref={canvas} />
              {choosing &&
                here.figures.map((f, i) => {
                  const r = onView(f.crop);
                  return (
                    <button
                      key={i}
                      type="button"
                      className="pdf-found"
                      data-testid="pdf-found"
                      aria-label={`図 ${i + 1}${f.label ? `（${f.label}）` : ''}を使う`}
                      style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setBox(r);
                        setError(null);
                      }}
                    >
                      <span>{f.label || i + 1}</span>
                    </button>
                  );
                })}
              {box && <div className="pdf-crop" data-testid="pdf-crop" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
            </div>
            {error && <p className="warn" data-testid="pdf-error">{error}</p>}
          </div>
        </div>
        {lowRes && (
          <p className="pdf-lowres" data-testid="pdf-lowres">
            {`この図は画像として貼られていて、解像度が低め（約 ${Math.round(dpi)} dpi）です。読み違いがいつもより起きやすくなります。`}
          </p>
        )}
        <div className="row pdf-actions">
          <button type="button" className="primary" data-testid="pdf-use" disabled={busy || !scale} onClick={() => void use()}>
            {box ? 'この範囲を使う' : 'このページ全体を使う'}
          </button>
          <button type="button" className="link" disabled={!box} onClick={() => {
              cleared.current = true;
              setBox(null);
            }}>範囲を消す</button>
          <button type="button" data-testid="pdf-cancel" onClick={() => ref.current?.close()}>やめる</button>
        </div>
      </dialog>
      {consent && (
        <LlmConsent
          paidKey={s.paidKey}
          onClose={(ok) => {
            setConsent(false);
            if (ok) setLlmSettings({ consented: true });
          }}
        />
      )}
    </>
  );
}

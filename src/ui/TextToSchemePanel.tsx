import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import type { Doc } from '../chem/model';
import { useEditor, type EditorStore } from '../editor/store';
import { imageSummary, LLM_IMAGE_TYPES, prepareImage, type PreparedImage } from '../llm/image';
import { isLowRes, isPdfFile, openPdf, parsePdfImageName, type OpenedPdf } from '../llm/pdf';
import { providerInfo, showFreeKeyNotes } from '../llm/providers';
import { getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { applyEdit, editChanges, editPrompt, textEdit, type EditOp } from '../llm/textEdit';
import { applyNameStructure, confirmDraft, discardDraft, draftScheme, existingCompounds, textToScheme, userPrompt, type CheckedPlan } from '../llm/textToScheme';
import { addPaperFacts, collectForFigure, guessSiIndex, indexPdf, withoutParts } from '../llm/paperFacts';
import type { Collected } from '../llm/pdfText';
import type { ReconcileNotes } from '../llm/reconcile';
import { opsinName } from '../chem/opsin';
import type { LlmProvider } from '../llm/types';
import { PaperFactsView, type PaperRun } from './PaperFactsView';
import { llmErrorText } from '../llm/types';
import type { LibraryCompound } from '../project/model';
import { belowDrawing } from '../table/ops';
import { FinishPanel } from './FinishPanel';
import { AiNotice } from './AiNotice';
import { LlmConsent } from './LlmConsent';
import { PdfPickerDialog } from './PdfPickerDialog';
import { activeSchemeId } from './SchemePanel';
import { WriteUpPanel } from './WriteUpPanel';

type Run = { state: 'idle' } | { state: 'busy'; abort: AbortController; started: number; phase?: 'text' } | { state: 'error'; text: string };

/** OPSIN で名前を SMILES にする（このサイトのサーバー。届かなければ null） */
const opsinSmiles = async (name: string) => (await opsinName(name).catch(() => null))?.smiles ?? null;
/** 言葉での編集の答え: 当てる操作と、前と後の差の一覧（確定まで文書は変えない） */
type Proposal = {
  schemeId: string;
  text: string;
  ops: EditOp[];
  changes: string[];
  rejected: string[];
  warnings: string[];
  wholeScheme: boolean;
  questions: string[];
  base: string;
};
/** 操作は段・試薬の位置で指すので、答えの後にスキームか化合物を直していたら当てない */
function schemeKey(doc: Doc, sid: string): string {
  const s = doc.schemes?.[sid];
  const ids = s ? [...new Set(s.steps.flatMap((st) => [...st.from, ...st.to]))] : [];
  return JSON.stringify([s ?? null, ids.map((id) => doc.compounds?.[id] ?? null)]);
}

/** 選んでいる化合物（そのスキームの化合物 id） */
function selectedCompounds(doc: Doc, sid: string, selection: Set<string>): string[] {
  const out = new Set<string>();
  for (const id of selection) {
    const [s, c] = doc.atoms[id]?.ref?.split(':') ?? [];
    if (s === sid && c) out.add(c);
  }
  return [...out];
}

/** 下書きのスキーム（あれば最後のもの） */
function draftOf(doc: Doc) {
  return Object.values(doc.schemes ?? {}).filter((s) => s.draft).at(-1) ?? null;
}

/**
 * 言葉から作る: 文章 → LLM → 下書きのスキーム → 確定・やめる
 * 「直す」に切り替えると言葉での編集: 文章 → LLM → 操作の並び → 差の一覧 → 確定・やめる（4章）
 */
export function TextToSchemePanel({
  store,
  library,
  onOpenSettings,
  onCreated,
  mode = 'create',
}: {
  store: EditorStore;
  library(): LibraryCompound[];
  onOpenSettings(): void;
  onCreated?(): void;
  /** 作る・直す・書く・仕上げ（右の欄の見出しとボタンで選ぶ） */
  mode?: 'create' | 'edit' | 'write' | 'finish';
}) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const editTarget = activeSchemeId(doc, selection);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const [text, setText] = useState('');
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [consent, setConsent] = useState(false);
  /** 添付した画像（作るときだけ。今は 1 枚） */
  const [image, setImage] = useState<PreparedImage | null>(null);
  /** PDF の範囲を選んだときに測った、画像の解像度（dpi）。画像として貼られていなければ null */
  const [imageDpi, setImageDpi] = useState<number | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageRef = useRef<PreparedImage | null>(null);
  imageRef.current = image;
  const fileInput = useRef<HTMLInputElement>(null);
  /** 最後に送った画像。下書きの質問に答えて送り直すときに、同じ画像をもう一度送る（文書には残さない） */
  const sentImage = useRef<PreparedImage | null>(null);
  /** 開いている PDF（ブラウザの中だけ。範囲を選び直せるように、画像を外すまで持つ）と、そのファイル名 */
  const [pdf, setPdf] = useState<{ doc: OpenedPdf; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  /** 画像・PDF をこの欄の上にドラッグしているか */
  const [dragging, setDragging] = useState(false);
  const pdfRef = useRef<OpenedPdf | null>(null);
  /** SI の PDF（本文と同じく、ブラウザの中だけ） */
  const [si, setSi] = useState<{ doc: OpenedPdf; name: string } | null>(null);
  const [siError, setSiError] = useState<string | null>(null);
  const siRef = useRef<OpenedPdf | null>(null);
  /** 本文・SI の文字も読んで補う・確かめるか（PDF から作るときだけ） */
  const [useText, setUseText] = useState(true);
  /** 下書きを作ったときの、本文・SI の文字を読んだ記録と、補い直しに使う①の結果 */
  const [paperRun, setPaperRun] = useState<(PaperRun & { plan: CheckedPlan; text: string; image: string; dpi: number | null }) | null>(null);
  const dropSi = () => {
    siRef.current?.destroy();
    siRef.current = null;
    setSi(null);
    setSiError(null);
  };
  /** 持っている PDF を捨てる（PDF を残さない） */
  const dropPdf = () => {
    pdfRef.current?.destroy();
    pdfRef.current = null;
    setPdf(null);
    setPicking(false);
    dropSi();
  };
  useEffect(
    () => () => {
      pdfRef.current?.destroy();
      siRef.current?.destroy();
    },
    [],
  );
  const addSi = async (file: File) => {
    const r = await openPdf(file);
    if (!r.ok) return setSiError(r.error);
    siRef.current?.destroy();
    siRef.current = r.pdf;
    setSi({ doc: r.pdf, name: file.name });
    setSiError(null);
  };
  const swapSi = () => {
    if (!pdf || !si) return;
    [pdfRef.current, siRef.current] = [si.doc, pdf.doc];
    setPdf(si);
    setSi(pdf);
  };
  const attach = async (files: File | File[] | undefined) => {
    const list = Array.isArray(files) ? files : files ? [files] : [];
    const file = list[0];
    if (!file) return;
    if (isPdfFile(file)) {
      // 本文と SI の 2 本をまとめて選んだら、どちらが SI かを推す（違えば画面で入れ替えられる）
      const pdfs = list.filter(isPdfFile).slice(0, 2);
      const opened = await Promise.all(pdfs.map((f) => openPdf(f)));
      const bad = opened.find((r) => !r.ok);
      if (bad && !bad.ok) {
        opened.forEach((r) => r.ok && r.pdf.destroy());
        setImageError(bad.error);
        return;
      }
      const docs = opened.map((r, i) => ({ doc: (r as { ok: true; pdf: OpenedPdf }).pdf, name: pdfs[i].name }));
      const siAt = docs.length === 2 ? guessSiIndex([{ name: docs[0].name, numPages: docs[0].doc.numPages }, { name: docs[1].name, numPages: docs[1].doc.numPages }]) : -1;
      const main = docs[siAt === 0 ? 1 : 0];
      dropSi();
      pdfRef.current?.destroy();
      pdfRef.current = main.doc;
      setPdf(main);
      if (siAt >= 0) {
        siRef.current = docs[siAt].doc;
        setSi(docs[siAt]);
      }
      setImageError(null);
      setPicking(true);
      return;
    }
    const r = await prepareImage(file, s.provider);
    if (r.ok) dropPdf();
    setImage(r.ok ? r.image : null);
    setImageDpi(null);
    setImageError(r.ok ? null : r.error);
  };
  const [answers, setAnswers] = useState<Record<number, string>>({});
  /** 描ける手順が無く、聞き返しだけが返ってきたとき */
  const [ask, setAsk] = useState<{ text: string; image: PreparedImage | null; dpi: number | null; questions: string[] } | null>(null);
  /** かかった時間（秒）。作っている間は1秒ごとに進める */
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (run.state !== 'busy') return;
    const t = setInterval(() => setSeconds(Math.round((Date.now() - run.started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [run]);
  const draft = draftOf(doc);
  /** 呼び出しの途中で PDF を替えても、その時の PDF を見るため */
  const paperRef = useRef({ pdf, si, useText });
  paperRef.current = { pdf, si, useText };

  /** 本文・SI の文字を集める（AI は使わない）。図のページは、画像を作った PDF の、そのページ */
  const collectPaper = async (plan: CheckedPlan, from: { file: string; page: number }, signal: AbortSignal): Promise<Collected | null> => {
    const { pdf: main, si: sup } = paperRef.current;
    if (!main) return null;
    const docs = [];
    if (sup) docs.push(await indexPdf(sup.doc, 'SI', signal));
    docs.push(await indexPdf(main.doc, '本文', signal));
    const fig = sup && from.file === sup.name && from.file !== main.name ? { x: sup, source: 'SI' } : { x: main, source: '本文' };
    const lines = from.page <= fig.x.doc.numPages ? await fig.x.doc.textLines(from.page).catch(() => []) : [];
    return collectForFigure(plan, { source: fig.source, page: from.page, lines }, docs);
  };

  /** ②文字 → 事実と突き合わせ。失敗しても①の結果で下書きを作れるよう、理由を返す */
  const factsStep = async (llm: LlmProvider, plan: CheckedPlan, collected: Collected, removed: string[], signal: AbortSignal) => {
    const c = withoutParts(collected, new Set(removed));
    track('llm:paper-facts');
    const two = await addPaperFacts(llm, { checked: plan, collected: c, opsin: opsinSmiles, thinking: getLlmSettings().thinking, signal });
    if (!two.ok) {
      if (two.error.kind !== 'aborted') track(`llm:error-${two.error.kind}`);
      const text = two.error.kind === 'aborted' ? '途中でやめました' : llmErrorText(two.error, getLlmSettings());
      return { checked: plan, notes: undefined as ReconcileNotes | undefined, result: { ok: false as const, text } };
    }
    return { checked: two.checked, notes: two.notes, result: { ok: true as const, dropped: two.dropped } };
  };

  /** 外したまとまりを除いて、②だけをやり直す（図は読み直さない）。下書きは置き換える */
  const refill = async (removed: string[]) => {
    const pr = paperRun;
    const llm = llmProvider();
    const d0 = store.get().doc;
    const old = pr ? d0.schemes?.[pr.schemeId] : undefined;
    if (!pr || !llm || !old?.draft) return;
    const abort = new AbortController();
    const started = Date.now();
    setRun({ state: 'busy', abort, started, phase: 'text' });
    setSeconds(0);
    const got = await factsStep(llm, pr.plan, pr.collected, removed, abort.signal);
    setSeconds(Math.round((Date.now() - started) / 1000));
    setRun({ state: 'idle' });
    let d = store.get().doc;
    if (!d.schemes?.[pr.schemeId]?.draft) return;
    d = discardDraft(d, pr.schemeId);
    const out = draftScheme(d, got.checked, { text: pr.text, model: s.model, origin: old.origin, image: pr.image, imageDpi: pr.dpi ?? undefined, notes: got.notes });
    store.commit(out.doc, new Set());
    setPaperRun({ ...pr, schemeId: out.schemeId, removed, result: got.result });
  };
  const modelName = providerInfo(s.provider).models.find((m) => m.id === s.model)?.name ?? s.model;

  /** replace: 今の下書きの質問に答えて送り直すとき（前の下書きと置き換える） */
  const send = async (input: string, qa?: { question: string; answer: string }[], replace = false, img: PreparedImage | null = null, dpi: number | null = null) => {
    const llm = llmProvider();
    if (!llm || (!input.trim() && !img)) return;
    const abort = new AbortController();
    const started = Date.now();
    setRun({ state: 'busy', abort, started });
    setSeconds(0);
    track(img ? (parsePdfImageName(img.name) ? 'llm:pdf-to-scheme' : 'llm:image-to-scheme') : 'llm:text-to-scheme');
    sentImage.current = img;
    const d0 = store.get().doc;
    const r = await textToScheme(llm, {
      text: input,
      existing: existingCompounds(d0, library()),
      answers: qa,
      image: img ? { summary: imageSummary(img), images: [{ mimeType: img.mimeType, data: img.data }] } : undefined,
      thinking: getLlmSettings().thinking,
      signal: abort.signal,
    });
    setSeconds(Math.round((Date.now() - started) / 1000));
    setAnswers({});
    if (!r.ok) {
      setRun(r.error.kind === 'aborted' ? { state: 'idle' } : { state: 'error', text: llmErrorText(r.error, getLlmSettings()) });
      if (r.error.kind !== 'aborted') track(`llm:error-${r.error.kind}`);
      return;
    }
    // 描ける段が無ければ、下書きは作らずに聞き返す
    if (!r.checked.steps.length) {
      setRun({ state: 'idle' });
      setAsk({ text: input, image: img, dpi, questions: r.checked.questions.length ? r.checked.questions : ['文章から反応の手順を読み取れませんでした。基質・試薬・生成物を書いてください'] });
      track('llm:ask');
      return;
    }
    setAsk(null);
    // PDF から作ったなら、本文・SI の文字も読んで補う・確かめる（①の番号で段落を探すので①の後）
    let checked = r.checked;
    let notes: ReconcileNotes | undefined;
    let paper: PaperRun | null = null;
    const from = img ? parsePdfImageName(img.name) : null;
    if (from && paperRef.current.useText && paperRef.current.pdf) {
      setRun({ state: 'busy', abort, started, phase: 'text' });
      const collected = await collectPaper(r.checked, from, abort.signal).catch(() => null);
      if (collected?.parts.length && !abort.signal.aborted) {
        const got = await factsStep(llm, r.checked, collected, [], abort.signal);
        checked = got.checked;
        notes = got.notes;
        paper = { schemeId: '', collected, removed: [], result: got.result };
      } else if (collected) paper = { schemeId: '', collected, removed: [], result: { ok: true, dropped: 0 } };
      setSeconds(Math.round((Date.now() - started) / 1000));
    }
    setRun({ state: 'idle' });
    let d = store.get().doc;
    const old = draftOf(d);
    if (old && replace) d = discardDraft(d, old.id);
    const out = draftScheme(d, checked, { text: input, model: s.model, origin: belowDrawing(d), image: img?.name, imageDpi: dpi ?? undefined, notes });
    store.commit(out.doc, new Set());
    setPaperRun(paper ? { ...paper, schemeId: out.schemeId, plan: r.checked, text: input, image: img!.name, dpi } : null);
    onCreated?.();
  };

  /** 言葉での編集: 操作の並びを返させ、今の文書の写しに当てて差を出す */
  const sendEdit = async (input: string, qa?: { question: string; answer: string }[]) => {
    const llm = llmProvider();
    const d0 = store.get().doc;
    const sid = activeSchemeId(d0, store.get().selection);
    if (!llm || !sid || !input.trim()) return;
    const abort = new AbortController();
    const started = Date.now();
    setRun({ state: 'busy', abort, started });
    setSeconds(0);
    track('llm:text-edit');
    const selected = selectedCompounds(d0, sid, store.get().selection);
    const r = await textEdit(llm, { doc: d0, schemeId: sid, text: input, answers: qa, selected, thinking: getLlmSettings().thinking, signal: abort.signal });
    setSeconds(Math.round((Date.now() - started) / 1000));
    setAnswers({});
    if (!r.ok) {
      setRun(r.error.kind === 'aborted' ? { state: 'idle' } : { state: 'error', text: llmErrorText(r.error, getLlmSettings()) });
      if (r.error.kind !== 'aborted') track(`llm:error-${r.error.kind}`);
      return;
    }
    setRun({ state: 'idle' });
    const after = applyEdit(d0, sid, r.checked.ops);
    setProposal({ schemeId: sid, text: input, ops: r.checked.ops, changes: editChanges(d0, after, sid), rejected: r.checked.rejected,
      warnings: r.checked.warnings,
      wholeScheme: r.checked.wholeScheme,
      questions: r.checked.questions,
      base: schemeKey(d0, sid),
    });
  };

  const go = () => void (mode === 'edit' ? sendEdit(text) : send(text, undefined, false, image, imageDpi));
  const start = () => {
    if (!getLlmSettings().consented) setConsent(true);
    else go();
  };
  const pinnedTarget = !!(editTarget && doc.schemes?.[editTarget]?.pinned);
  const editable = mode === 'create' || (!!editTarget && !pinnedTarget);

  if (!s.apiKey) {
    return (
      <section className="tts" data-testid="tts">
        <p className="muted">{`文章から反応スキームの下書きを作ります。使うには、AI の設定で ${providerInfo(s.provider).product} の API キーを入れてください。`}</p>
        <button type="button" className="primary" data-testid="tts-open-settings" onClick={onOpenSettings}>AI の設定を開く</button>
      </section>
    );
  }

  // 仕上げの一括の指示は別の部品（src/ui/FinishPanel.tsx）
  if (mode === 'finish') {
    return (
      <section className="tts" data-testid="tts">
        <FinishPanel store={store} onOpenSettings={onOpenSettings} modelName={modelName} />
      </section>
    );
  }

  return (
    <section
      className={`tts${dragging ? ' tts-drop' : ''}`}
      data-testid="tts"
      // 画像・PDF を落として添付する（本文と SI の 2 本を一度に落としてもよい）
      onDragOver={(e) => {
        if (mode !== 'create' || run.state === 'busy' || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (mode !== 'create' || run.state === 'busy' || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void attach([...e.dataTransfer.files]);
      }}
    >
      {dragging && <p className="tts-drop-hint" data-testid="tts-drop-hint">ここに落とすと添付します</p>}
      {mode === 'write' ? <WriteUpPanel store={store} /> : <>
      {mode === 'edit' && (
        <p className="muted" data-testid="tts-edit-target">
          {pinnedTarget
            ? '選んでいる反応スキームは固定中です。直すときは、反応スキームの欄で固定を外してください。'
            : editTarget
            ? '選んでいるスキームの試薬・条件・番号・呼び名・書式・構造を直します。構造を書き換えるのは、指示に番号か呼び名を書いた化合物と、選んでいる化合物だけです。スキーム全体を書き換えるときは、そう書いてください。'
            : '直す反応スキームがありません。先にスキームを作ってください。'}
        </p>
      )}
      <textarea
        data-testid="tts-text"
        value={text}
        placeholder={
          mode === 'edit'
            ? '例: 2 段目の TFA を 4 M HCl/dioxane に。番号を 1 から振り直して、脚注の書式に。'
            : '例: 1 と 2 を HATU で縮合して 3 を得た（85%）'
        }
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          if (mode !== 'create') return;
          const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
          if (!f) return;
          e.preventDefault();
          void attach(f);
        }}
      />
      {mode === 'create' && (
        <div className="tts-image" data-testid="tts-image">
          <div className="row">
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={[...LLM_IMAGE_TYPES, 'application/pdf', '.pdf'].join(',')}
              data-testid="tts-image-input"
              multiple
              onChange={(e) => {
                void attach([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <button type="button" data-testid="tts-image-attach" disabled={run.state === 'busy'} onClick={() => fileInput.current?.click()} title="反応スキームの画像か、論文の PDF を添付します。文章欄への貼り付けや、この欄へのドラッグでも添付できます">
              {image ? '画像を替える' : '画像を添付'}
            </button>
            {image && (
              <>
                <img className="tts-image-thumb" data-testid="tts-image-thumb" src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
                <span className="muted" data-testid="tts-image-name">{image.name}</span>
                {pdf && parsePdfImageName(image.name) && (
                  <button type="button" className="link" data-testid="tts-pdf-reselect" disabled={run.state === 'busy'} onClick={() => setPicking(true)}>
                    ほかの範囲を選ぶ
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  data-testid="tts-image-remove"
                  disabled={run.state === 'busy'}
                  onClick={() => {
                    setImage(null);
                    setImageDpi(null);
                    dropPdf();
                  }}
                >
                  外す
                </button>
              </>
            )}
          </div>
          {picking && pdf && (
            <PdfPickerDialog
              pdf={pdf.doc}
              fileName={pdf.name}
              key={pdf.name}
              si={{ file: si ? { name: si.name, numPages: si.doc.numPages } : null, error: siError, onAdd: (f) => void addSi(f), onRemove: dropSi, onSwap: swapSi }}
              onUse={(img, dpi) => {
                setImage(img);
                setImageDpi(isLowRes(dpi) ? Math.round(dpi!) : null);
                setPicking(false);
              }}
              onClose={() => {
                setPicking(false);
                // 一度も画像にしないまま閉じたら、PDF は捨てる
                if (parsePdfImageName(imageRef.current?.name ?? '')?.file !== pdf.name) dropPdf();
              }}
            />
          )}
          {image && pdf && parsePdfImageName(image.name) && (
            <label className="tts-paper-text" data-testid="tts-paper-text">
              <input type="checkbox" data-testid="tts-paper-text-check" checked={useText} disabled={run.state === 'busy'} onChange={(e) => setUseText(e.target.checked)} />
              {`本文${si ? `と SI（${si.name}）` : ''}からも、条件と名前を読む`}
            </label>
          )}
          {imageError && <p className="warn" data-testid="tts-image-error">{imageError}</p>}
        </div>
      )}
      <div className="row">
        {run.state === 'busy' ? (
          <>
            <span className="muted" data-testid="tts-busy">{run.phase === 'text' ? '本文・SI の文字を読んでいます…' : '作っています…'}（{seconds ?? 0} 秒）</span>
            <button type="button" onClick={() => run.abort.abort()}>やめる</button>
          </>
        ) : (
          <button type="button" className="primary" data-testid="tts-run" disabled={!(text.trim() || (mode === 'create' && image)) || !editable} onClick={start}>
            {mode === 'edit' ? '直し方を作る' : '下書きを作る'}
          </button>
        )}
        {run.state !== 'busy' && seconds !== null && <span className="muted" data-testid="tts-seconds">{seconds} 秒</span>}
        <button type="button" className="link" onClick={onOpenSettings} title="AI の設定（モデル・考える深さ）">
          {modelName}
        </button>
      </div>
      {showFreeKeyNotes(s) && (
        <p className="warn" data-testid="tts-free-warning">{providerInfo(s.provider).freeKeyWarning.short}</p>
      )}
      {mode === 'create' && (
        <details className="tts-send-notes" data-testid="tts-send-notes">
          <summary>送る前に: 画像の権利と、回数の目安</summary>
          <p data-testid="tts-image-rights">送れる画像は、権利を持っているものか、AI に入れてよいと許されているものだけです。出版社によっては、論文の図を AI に入れることを認めていません。</p>
          {showFreeKeyNotes(s) && (
            <p data-testid="tts-free-limits">{providerInfo(s.provider).freeKeyWarning.textToSchemeLimits}</p>
          )}
        </details>
      )}
      {run.state === 'error' && <p className="warn" data-testid="tts-error">{run.text}</p>}
      {(text.trim() || (mode === 'create' && image)) && (
        <details className="tts-preview">
          <summary>送る内容を見る</summary>
          {mode === 'create' && image && pdf && useText && parsePdfImageName(image.name) && (
            <p className="muted" data-testid="tts-preview-paper">
              {`図を読んだ後に、もう一度 AI に送ります。送るのは、${parsePdfImageName(image.name)!.page} ページの文字と、図の化合物番号が出てくる本文${si ? '・SI ' : ''}の段落です。送った段落は、下書きで外して読み直せます。`}
            </p>
          )}
          <pre data-testid="tts-preview">{mode === 'edit' ? (editTarget ? editPrompt(doc, editTarget, text, { selected: selectedCompounds(doc, editTarget, selection) }) : '') : userPrompt(text, existingCompounds(doc, library()), undefined, image ? imageSummary(image) : undefined)}</pre>
        </details>
      )}
      {ask && (
        <div className="tts-draft tts-ask" data-testid="tts-ask">
          <h3>下書きを作れませんでした</h3>
          <Questions questions={ask.questions} answers={answers} setAnswers={setAnswers} busy={run.state === 'busy'} onRetry={(qa) => void send(ask.text, qa, false, ask.image, ask.dpi)} />
          <div className="row">
            <button type="button" onClick={() => setAsk(null)}>閉じる</button>
          </div>
        </div>
      )}
      {draft?.draft && (
        <div className="tts-draft" data-testid="tts-draft">
          <h3>下書き</h3>
          {draft.draft.image && (
            <p className="muted" data-testid="tts-draft-image">
              {(() => {
                const p = parsePdfImageName(draft.draft.image);
                return p ? `『${p.file}』の ${p.page} ページから読み取りました。` : `画像「${draft.draft.image}」から読み取りました。`;
              })()}
            </p>
          )}
          <AiNotice
            kind={draft.draft.image ? 'image' : 'text'}
            lowResDpi={isLowRes(draft.draft.imageDpi) ? draft.draft.imageDpi : null}
            fromPaper={!!(draft.draft.textSources?.length || draft.draft.nameChecks?.length)}
          />
          <div className="tts-check" data-testid="tts-check">
            <h4>
              確かめてほしい所 <span data-testid="tts-issue-count">{draft.draft.issues.length} 件</span>
            </h4>
            {draft.draft.issues.length ? (
              <ul className="issues" data-testid="tts-issues">
                {draft.draft.issues.map((i, n) => {
                  // 名前の構造と図の構造が違うときは、その場で名前の構造に置き換えられる
                  const named = i.kind === 'name' ? draft.draft!.nameChecks?.find((c) => c.compoundId === i.compoundId && c.smiles && (c.result === 'mismatch' || c.result === 'stereo')) : undefined;
                  return (
                    <li key={n}>
                      <span className="dot" aria-hidden="true" />
                      <div>
                        <button
                          type="button"
                          className="link"
                          title={i.compoundId ? '押すと、その化合物を選びます' : undefined}
                          onClick={() => {
                            if (!i.compoundId) return;
                            const ids = Object.values(store.get().doc.atoms).filter((a) => a.ref === `${draft.id}:${i.compoundId}`).map((a) => a.id);
                            store.set({ selection: new Set(ids) });
                          }}
                        >
                          {i.message}
                        </button>
                        {named && (
                          <button
                            type="button"
                            data-testid="tts-use-name"
                            disabled={run.state === 'busy'}
                            onClick={() => {
                              store.commit(applyNameStructure(store.get().doc, draft.id, named.compoundId));
                              track('llm:use-name-structure');
                            }}
                          >
                            名前の構造にする
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">構造と元素の数に、おかしな所は見つかりませんでした。条件と立体は、元の図や文章と見比べてください。</p>
            )}
          </div>
          <PaperFactsView
            key={draft.id}
            doc={doc}
            draft={draft.draft}
            run={paperRun?.schemeId === draft.id ? paperRun : null}
            busy={run.state === 'busy'}
            onRefill={(removed) => void refill(removed)}
          />
          {draft.draft.questions.length > 0 && (
            <Questions
              questions={draft.draft.questions}
              answers={answers}
              setAnswers={setAnswers}
              busy={run.state === 'busy'}
              onRetry={(qa) => void send(draft.draft!.text, qa, true, draft.draft!.image && sentImage.current?.name === draft.draft!.image ? sentImage.current : null, draft.draft!.imageDpi ?? null)}
            />
          )}
          <div className="row">
            <button className="primary"
              type="button"
              data-testid="tts-confirm"
              onClick={() => {
                store.commit(confirmDraft(store.get().doc, draft.id));
                track('llm:confirm');
              }}
            >
              確定
            </button>
            <button
              type="button"
              data-testid="tts-discard"
              onClick={() => {
                store.commit(discardDraft(store.get().doc, draft.id), new Set());
                track('llm:discard');
              }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
      {proposal && (
        <div className="tts-draft" data-testid="tts-proposal">
          <h3>直す所（確定するまで、図は変わりません）</h3>
          <AiNotice kind="edit" />
          {proposal.wholeScheme && (
            <p className="warn" data-testid="tts-whole-scheme">指示に従い、スキーム全体の構造と条件を書き換えます。すべての変更を確かめてください。</p>
          )}
          {proposal.warnings.length > 0 && (
            <ul className="issues" data-testid="tts-edit-warnings">
              {proposal.warnings.map((c, n) => (
                <li key={n}>要確認: {c}</li>
              ))}
            </ul>
          )}
          {proposal.changes.length ? (
            <ul data-testid="tts-changes">
              {proposal.changes.map((c, n) => (
                <li key={n}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="muted" data-testid="tts-no-change">変わる所はありませんでした。</p>
          )}
          {proposal.rejected.length > 0 && (
            <ul className="issues" data-testid="tts-rejected">
              {proposal.rejected.map((c, n) => (
                <li key={n}>使えなかった指示: {c}</li>
              ))}
            </ul>
          )}
          {proposal.questions.length > 0 && (
            <Questions questions={proposal.questions} answers={answers} setAnswers={setAnswers} busy={run.state === 'busy'} onRetry={(qa) => void sendEdit(proposal.text, qa)} />
          )}
          <div className="row">
            <button
              type="button"
              data-testid="tts-edit-confirm"
              disabled={!proposal.changes.length}
              onClick={() => {
                const d = store.get().doc;
                if (schemeKey(d, proposal.schemeId) !== proposal.base) {
                  store.set({ message: '直し方を作った後にスキームが変わったので、当てませんでした。もう一度作ってください' });
                  setProposal(null);
                  return;
                }
                store.commit(applyEdit(d, proposal.schemeId, proposal.ops));
                setProposal(null);
                track('llm:edit-confirm');
              }}
            >
              確定
            </button>
            <button
              type="button"
              data-testid="tts-edit-discard"
              onClick={() => {
                setProposal(null);
                track('llm:edit-discard');
              }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
      </>}
      {consent && (
        <LlmConsent
          paidKey={s.paidKey}
          onClose={(ok) => {
            setConsent(false);
            if (ok) {
              setLlmSettings({ consented: true });
              go();
            }
          }}
        />
      )}
    </section>
  );
}

/** LLM からの質問。答えて「もう一度」で、前の文章と答えを合わせて送り直す */
export function Questions({
  questions,
  answers,
  setAnswers,
  busy,
  onRetry,
}: {
  questions: string[];
  answers: Record<number, string>;
  setAnswers(a: Record<number, string>): void;
  busy: boolean;
  onRetry(qa: { question: string; answer: string }[]): void;
}) {
  return (
    <div className="questions" data-testid="tts-questions">
      <p>AI からの質問です。答えて「もう一度」を押すと、作り直します。</p>
      {questions.map((q, n) => (
        <label key={n} className="field">
          <span>{q}</span>
          <input value={answers[n] ?? ''} data-testid="tts-answer" onChange={(e) => setAnswers({ ...answers, [n]: e.target.value })} />
        </label>
      ))}
      <button
        type="button"
        data-testid="tts-retry"
        disabled={busy || !Object.values(answers).some((a) => a.trim())}
        onClick={() => onRetry(questions.map((question, n) => ({ question, answer: answers[n] ?? '' })))}
      >
        もう一度
      </button>
    </div>
  );
}

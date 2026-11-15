import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { useEditor, type EditorStore } from '../editor/store';
import { providerLabel } from '../llm/providerLabel';
import { getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { llmErrorText } from '../llm/types';
import { refillWriteUp, runsForScheme, schemeNotebook, schemeStoichTables, writeFacts, writeUp, writeUpPrompt, type CheckedWriteUp, type WriteLanguage } from '../llm/writeUp';
import { AiNotice } from './AiNotice';
import { activeSchemeId } from './SchemePanel';

type Draft = { schemeId: string; instruction: string; checked: CheckedWriteUp; /** 実験の記録の量と行を使って書いた */ useRuns?: boolean };
/** 「作る / 直す」に切り替えて欄が消えても、書いたものは残す（文書には入れないので、ここに置く。読み込み直すと消える） */
const kept: { table: { markdown: string; tsv: string } | null; notebook: string | null; text: string; language: WriteLanguage; draft: Draft | null; out: string } = {
  table: null,
  notebook: null,
  text: '',
  language: 'en',
  draft: null,
  out: '',
};

type Run = { state: 'idle' } | { state: 'busy'; abort: AbortController; started: number } | { state: 'error'; text: string };

/**
 * 書く: スキームから化学量論表（LLM を呼ばない）と実験項の文章（LLM は文の組み立てだけ）を作る
 * 文章は下書きとして見せ、人が確かめてコピーする。文書には入れない
 */
export function WriteUpPanel({ store }: { store: EditorStore }) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const sid = activeSchemeId(doc, selection);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const [table, setTable] = useState(kept.table);
  const [notebook, setNotebook] = useState(kept.notebook);
  const [text, setText] = useState(kept.text);
  const [language, setLanguage] = useState(kept.language);
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [consent, setConsent] = useState(false);
  /** 下書き: 印の入った文と、差し込んだ文（手で直した文は out） */
  const [draft, setDraft] = useState(kept.draft);
  const [out, setOut] = useState(kept.out);
  useEffect(() => {
    Object.assign(kept, { table, notebook, text, language, draft, out });
  }, [table, notebook, text, language, draft, out]);
  const [seconds, setSeconds] = useState<number | null>(null);
  // 「書く」から切り替えて欄が消えたら、書いている途中の呼び出しもやめる
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  /** 実験の記録がある段は、記録の量と行を使って書く（記録が無ければ出さない） */
  const [useRuns, setUseRuns] = useState(true);
  const hasRuns = !!sid && runsForScheme(doc, sid).size > 0;
  const withRuns = hasRuns && useRuns;
  const facts = useMemo(() => (sid ? writeFacts(doc, sid, withRuns) : null), [doc, sid, withRuns]);
  /** 下書きの後にスキームの量や条件を変えたか（数字を入れ直すと変わるか） */
  const stale = useMemo(() => {
    if (!draft) return false;
    if (!doc.schemes?.[draft.schemeId]) return true;
    return refillWriteUp(doc, draft.schemeId, draft.checked, draft.instruction, draft.useRuns).text !== draft.checked.text;
  }, [doc, draft]);
  useEffect(() => {
    if (run.state !== 'busy') return;
    const t = setInterval(() => setSeconds(Math.round((Date.now() - run.started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [run]);

  const copy = (value: string, what: string) => {
    navigator.clipboard?.writeText(value).then(
      () => store.set({ message: `${what}をコピーしました` }),
      () => store.set({ message: 'コピーできませんでした' }),
    );
  };

  const send = async () => {
    const llm = llmProvider();
    const d0 = store.get().doc;
    const target = activeSchemeId(d0, store.get().selection);
    if (!llm || !target) return;
    const abort = new AbortController();
    abortRef.current = abort;
    const started = Date.now();
    setRun({ state: 'busy', abort, started });
    setSeconds(0);
    track('llm:write-up');
    const r = await writeUp(llm, { doc: d0, schemeId: target, text, language, thinking: getLlmSettings().thinking, signal: abort.signal, useRuns: withRuns });
    setSeconds(Math.round((Date.now() - started) / 1000));
    if (!r.ok) {
      setRun(r.error.kind === 'aborted' ? { state: 'idle' } : { state: 'error', text: llmErrorText(r.error, getLlmSettings().paidKey) });
      if (r.error.kind !== 'aborted') track(`llm:error-${r.error.kind}`);
      return;
    }
    setRun({ state: 'idle' });
    setDraft({ schemeId: target, instruction: text, checked: r.checked, useRuns: withRuns });
    setOut(r.checked.text);
  };
  const start = () => {
    if (!getLlmSettings().consented) setConsent(true);
    else void send();
  };

  if (!sid) {
    return (
      <p className="muted" data-testid="tts-write-target">
        文章や表にする反応スキームがありません。先にスキームを作ってください。
      </p>
    );
  }

  return (
    <div className="tts-write" data-testid="tts-write">
      <p className="muted" data-testid="tts-write-target">
        選んでいる反応スキームから、化学量論表と実験項の文章を作ります。選んでいなければ、最初のスキームが対象です。分子量・量・当量・収率の数字はアプリが化学量論表から出し、AI には文の組み立てだけを任せます。
      </p>
      <div className="row">
        <button
          type="button"
          data-testid="tts-write-table"
          onClick={() => {
            setTable(schemeStoichTables(store.get().doc, sid));
            track('write:table');
          }}
        >
          化学量論表を作る
        </button>
        <button
          type="button"
          data-testid="tts-write-notebook"
          title="容器に足していくものを縦に並べた、実験ノート用の図。足した順は手で直してください"
          onClick={() => {
            setNotebook(schemeNotebook(store.get().doc, sid));
            track('write:notebook');
          }}
        >
          ノート用の図を作る
        </button>
        <span className="muted">AI は使いません</span>
      </div>
      {table && (
        <div className="tts-draft" data-testid="tts-write-table-box">
          <pre data-testid="tts-write-table-out">{table.markdown}</pre>
          <div className="row">
            <button type="button" data-testid="tts-write-copy-md" onClick={() => copy(table.markdown, 'Markdown の表')}>Markdown をコピー</button>
            <button type="button" data-testid="tts-write-copy-tsv" onClick={() => copy(table.tsv, 'Excel 用の表')}>Excel 用にコピー</button>
            <button type="button" onClick={() => setTable(null)}>閉じる</button>
          </div>
        </div>
      )}
      {notebook !== null && (
        <div className="tts-draft" data-testid="tts-write-notebook-box">
          <pre data-testid="tts-write-notebook-out">{notebook}</pre>
          <p className="muted">足した順は基質、試薬の順で、試薬はスキームに書いた順です。違えば、貼った後に直してください。</p>
          <div className="row">
            <button type="button" data-testid="tts-write-copy-notebook" onClick={() => copy(notebook, 'ノート用の図')}>コピー</button>
            <button type="button" onClick={() => setNotebook(null)}>閉じる</button>
          </div>
        </div>
      )}
      <h3>実験項の文章</h3>
      <textarea
        data-testid="tts-write-text"
        value={text}
        placeholder="指示は話し言葉でも書けます。例: 反応液を重曹水で洗って、硫酸ナトリウムで乾燥。濃縮後、カラム精製。ヘキサク 3 対 1。書かなければ、後処理と精製は [[…]] の書き足す所になります"
        onChange={(e) => setText(e.target.value)}
      />
      {hasRuns && (
        <label className="check" data-testid="tts-write-use-runs-label">
          <input type="checkbox" data-testid="tts-write-use-runs" checked={useRuns} onChange={(e) => setUseRuns(e.target.checked)} />
          実験の記録を使う
        </label>
      )}
      {withRuns && <p className="muted" data-testid="tts-write-runs-note">量・収量・収率を実験の記録の値にし、記録の行から後処理と単離を書きます。記録の行も送ります。時刻とロットは送りません。</p>}
      <div className="row">
        <label className="field">
          <span>言語</span>
          <select data-testid="tts-write-lang" value={language} onChange={(e) => setLanguage(e.target.value as WriteLanguage)}>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        {run.state === 'busy' ? (
          <>
            <span className="muted" data-testid="tts-write-busy">書いています… {seconds ?? 0} 秒</span>
            <button type="button" onClick={() => run.abort.abort()}>やめる</button>
          </>
        ) : (
          <button type="button" className="primary" data-testid="tts-write-run" disabled={!s.apiKey} onClick={start}>
            実験項を書く
          </button>
        )}
        {run.state !== 'busy' && seconds !== null && <span className="muted">{seconds} 秒</span>}
      </div>
      {!s.apiKey && <p className="muted">{`文章を書くには、AI の設定で ${providerLabel(s.provider).product} の API キーを入れてください。`}</p>}
      {s.apiKey && !s.paidKey && <p className="warn" data-testid="tts-write-free-warning">無料のキーでは、送った内容が Google の製品の改善に使われます。秘密の内容は送らないでください。</p>}
      {run.state === 'error' && <p className="warn" data-testid="tts-write-error">{run.text}</p>}
      <details className="tts-preview">
        <summary>送る内容を見る</summary>
        <pre data-testid="tts-write-preview">{facts ? writeUpPrompt(facts, text, language) : ''}</pre>
      </details>
      {draft && (
        <div className="tts-draft" data-testid="tts-write-draft">
          <h3>下書き: 確かめてからコピーしてください</h3>
          {stale && (
            <p className="warn" data-testid="tts-write-stale">
              下書きを作った後に、スキームの量か条件が変わりました。「今のスキームで数字を入れ直す」で、今の値にできます。
            </p>
          )}
          <AiNotice kind="write" />
          {draft.schemeId !== sid && <p className="muted" data-testid="tts-write-other">この下書きは、いま選んでいるのとは別の反応スキームのものです。</p>}
          {draft.checked.issues.length ? (
            <ul className="issues" data-testid="tts-write-issues">
              {draft.checked.issues.map((i, n) => (
                <li key={n}>要確認: {i.message}</li>
              ))}
            </ul>
          ) : (
            <p className="muted" data-testid="tts-write-ok">数字はすべてスキームの値から入れ、段の化合物と試薬はすべて出てきました。文の中身は目で確かめてください。</p>
          )}
          {draft.checked.todos.length > 0 && (
            <ul className="issues" data-testid="tts-write-todos">
              {draft.checked.todos.map((t, n) => (
                <li key={n}>書き足す所: {t}</li>
              ))}
            </ul>
          )}
          {draft.checked.questions.length > 0 && (
            <ul data-testid="tts-write-questions">
              {draft.checked.questions.map((q, n) => (
                <li key={n}>AI からの質問: {q}</li>
              ))}
            </ul>
          )}
          <textarea data-testid="tts-write-out" className="tts-write-out" value={out} onChange={(e) => setOut(e.target.value)} rows={10} />
          <div className="row">
            <button
              type="button"
              data-testid="tts-write-copy"
              onClick={() => {
                copy(out, '実験項の文章');
                track('llm:write-copy');
              }}
            >
              コピー
            </button>
            <button
              type="button"
              data-testid="tts-write-refill"
              title="化学量論表の量を変えたら押す。AI は使わず、手で直した所は消える"
              onClick={() => {
                const d = store.get().doc;
                if (!d.schemes?.[draft.schemeId]) return;
                const checked = refillWriteUp(d, draft.schemeId, draft.checked, draft.instruction, draft.useRuns);
                setDraft({ ...draft, checked });
                setOut(checked.text);
              }}
            >
              今のスキームで数字を入れ直す
            </button>
            <button type="button" data-testid="tts-write-discard" onClick={() => setDraft(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}
      {consent && (
        <WriteUpConsent
          paidKey={s.paidKey}
          withRuns={withRuns}
          onClose={(ok) => {
            setConsent(false);
            if (ok) {
              setLlmSettings({ consented: true });
              void send();
            }
          }}
        />
      )}
    </div>
  );
}

/** 初めて送るときの同意（書くときに送るもの） */
function WriteUpConsent({ paidKey, withRuns, onClose }: { paidKey: boolean; withRuns?: boolean; onClose(ok: boolean): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const ok = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="about" data-testid="llm-consent" onClose={() => onClose(ok.current)}>
      <h2>{providerLabel(getLlmSettings().provider).label}に送ります</h2>
      <ul>
        <li>送るのは、入力した指示の文と、選んでいる反応スキームの化合物の番号・呼び名・分子式・分子量、試薬と条件、化学量論表の量です。構造（SMILES）と、描いた図のほかの部分は送りません。</li>
        {withRuns && <li data-testid="llm-consent-run">実験の記録を使うので、その仕込みの名前と量、操作の名前、記録の行も送ります。記録の行は、したこと・量・内温・測定と観察です。時刻とロットは送りません。</li>}
        <li>送る前に、「送る内容を見る」で中身を確かめられます。</li>
        {!paidKey && <li className="warn">無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。未発表の構造など秘密の内容は送らないでください。</li>}
      </ul>
      <AiNotice kind="general" />
      <form method="dialog" className="row">
        <button type="submit" data-testid="llm-consent-ok" onClick={() => (ok.current = true)}>
          同意して送る
        </button>
        <button type="submit">やめる</button>
      </form>
    </dialog>
  );
}

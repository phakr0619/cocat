import { useEffect, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { useEditor, type EditorStore } from '../editor/store';
import { applyFinish, finishableSchemes, finishChanges, finishKey, finishPrompt, finishSchemes, finishTargets, type FinishChangeGroup, type FinishOp } from '../llm/finish';
import { getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { showFreeKeyNotes } from '../llm/providerLabel';
import { llmErrorText } from '../llm/types';
import { loadMyStyles, type SchemeStyle } from '../scheme/style';
import { AiNotice } from './AiNotice';
import { activeSchemeId } from './SchemePanel';
import { LlmConsent } from './LlmConsent';
import { Questions } from './TextToSchemePanel';

type Run = { state: 'idle' } | { state: 'busy'; abort: AbortController; started: number } | { state: 'error'; text: string };
/** 仕上げの答え: 当てる操作と、スキームごとの差の一覧（確定まで文書は変えない） */
type Proposal = {
  schemeIds: string[];
  text: string;
  ops: FinishOp[];
  groups: FinishChangeGroup[];
  rejected: string[];
  warnings: string[];
  cannot: string[];
  questions: string[];
  myStyles: SchemeStyle[];
  base: string;
};

/** 例の指示（押すと文章に入る） */
const EXAMPLES = ['ACS の書式に揃えて投稿用に', '番号を 1 から振り直して脚注の書式に。当量は equiv で', '条件の書き方を英語の略記に。室温は rt、時間は h'];

/**
 * 仕上げの一括の指示: 文章 → LLM → 操作の並び → スキームごとの差の一覧 → 確定・やめる。
 * 「言葉から作る」の欄の「仕上げ」で出る。直すのは見た目と書き方だけ
 */
export function FinishPanel({ store, onOpenSettings, modelName }: { store: EditorStore; onOpenSettings(): void; modelName: string }) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const [scope, setScope] = useState<'all' | 'active'>('all');
  const [text, setText] = useState('');
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [seconds, setSeconds] = useState<number | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    if (run.state !== 'busy') return;
    const t = setInterval(() => setSeconds(Math.round((Date.now() - run.started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [run]);
  // 「作る」「直す」に切り替えて外れたら、作っている途中の呼び出しをやめる
  const running = run.state === 'busy' ? run.abort : null;
  useEffect(() => () => running?.abort(), [running]);
  const count = finishableSchemes(doc).length;
  const targets = finishTargets(doc, scope, activeSchemeId(doc, selection));

  /** only: 質問に答えて送り直すとき、前と同じ範囲で送る */
  const send = async (input: string, qa?: { question: string; answer: string }[], only?: string[]) => {
    const llm = llmProvider();
    const d0 = store.get().doc;
    const ids = (only ?? finishTargets(d0, scope, activeSchemeId(d0, store.get().selection))).filter((id) => d0.schemes?.[id]);
    if (!llm || !ids.length || !input.trim()) return;
    const abort = new AbortController();
    const started = Date.now();
    setRun({ state: 'busy', abort, started });
    setSeconds(0);
    track('llm:finish');
    const myStyles = loadMyStyles();
    const r = await finishSchemes(llm, { doc: d0, schemeIds: ids, text: input, answers: qa, myStyles, thinking: getLlmSettings().thinking, signal: abort.signal });
    setSeconds(Math.round((Date.now() - started) / 1000));
    setAnswers({});
    if (!r.ok) {
      setRun(r.error.kind === 'aborted' ? { state: 'idle' } : { state: 'error', text: llmErrorText(r.error, getLlmSettings().paidKey) });
      if (r.error.kind !== 'aborted') track(`llm:error-${r.error.kind}`);
      return;
    }
    setRun({ state: 'idle' });
    const after = applyFinish(d0, ids, r.checked.ops, myStyles);
    setProposal({ schemeIds: ids, text: input, groups: finishChanges(d0, after, ids), ...r.checked, myStyles, base: finishKey(d0, ids) });
  };
  const start = () => {
    if (!getLlmSettings().consented) setConsent(true);
    else void send(text);
  };

  return (
    <div className="finish" data-testid="finish">
      <p className="muted">文書のスキームを、投稿や発表の形にまとめて整えます。直すのは書式・番号・試薬と条件の書き方だけで、試薬の足し・外し、収率、構造は変えません。</p>
      <div className="row" role="radiogroup" aria-label="仕上げる範囲">
        <label>
          <input type="radio" name="finish-scope" data-testid="finish-scope-all" checked={scope === 'all'} onChange={() => setScope('all')} /> 文書のすべてのスキーム（{count}）
        </label>
        <label>
          <input type="radio" name="finish-scope" data-testid="finish-scope-active" checked={scope === 'active'} onChange={() => setScope('active')} /> 選んでいるスキームだけ
        </label>
      </div>
      {!targets.length && <p className="muted" data-testid="finish-no-target">仕上げる反応スキームがありません。下書きは、確定してから仕上げます。</p>}
      <textarea data-testid="finish-text" value={text} placeholder="例: ACS の書式に揃えて投稿用に。番号は 1 から振り直して。" onChange={(e) => setText(e.target.value)} />
      <div className="row">
        {EXAMPLES.map((x) => (
          <button key={x} type="button" className="link" data-testid="finish-example" onClick={() => setText(x)}>
            {x}
          </button>
        ))}
      </div>
      <div className="row">
        {run.state === 'busy' ? (
          <>
            <span className="muted" data-testid="finish-busy">作っています… {seconds ?? 0} 秒</span>
            <button type="button" onClick={() => run.abort.abort()}>やめる</button>
          </>
        ) : (
          <button type="button" className="primary" data-testid="finish-run" disabled={!text.trim() || !targets.length} onClick={start}>
            仕上げ方を作る
          </button>
        )}
        {run.state !== 'busy' && seconds !== null && <span className="muted">{seconds} 秒</span>}
        <button type="button" className="link" onClick={onOpenSettings} title="AI のモデルと考える深さを変える">
          {modelName}
        </button>
      </div>
      <p className="muted" data-testid="finish-rules">投稿先の決まりは AI の知識によるものです。最後は投稿規定で確かめてください。</p>
      {showFreeKeyNotes(s) && <p className="warn">無料のキーでは、送った内容が Google の製品の改善に使われます。秘密の内容は送らないでください。</p>}
      {run.state === 'error' && <p className="warn" data-testid="finish-error">{run.text}</p>}
      {text.trim() && targets.length > 0 && (
        <details className="tts-preview">
          <summary>送る内容を見る</summary>
          <pre data-testid="finish-preview">{finishPrompt(doc, targets, text, { myStyles: loadMyStyles() })}</pre>
        </details>
      )}
      {proposal && (
        <div className="tts-draft" data-testid="finish-proposal">
          <h3>仕上げる所: 確定するまで、図は変わりません</h3>
          <AiNotice kind="finish" />
          {proposal.warnings.length > 0 && (
            <ul className="issues" data-testid="finish-warnings">
              {proposal.warnings.map((c, n) => (
                <li key={n}>要確認: {c}</li>
              ))}
            </ul>
          )}
          {proposal.groups.length ? (
            <div data-testid="finish-changes">
              {proposal.groups.map((g) => (
                <div key={g.title} data-testid="finish-group">
                  <h4>{g.title}</h4>
                  <ul>
                    {g.changes.map((c, n) => (
                      <li key={n}>{c}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" data-testid="finish-no-change">変わる所はありませんでした。</p>
          )}
          {proposal.cannot.length > 0 && (
            <ul className="issues" data-testid="finish-cannot">
              {proposal.cannot.map((c, n) => (
                <li key={n}>この道具ではできないこと: {c}</li>
              ))}
            </ul>
          )}
          {proposal.rejected.length > 0 && (
            <ul className="issues" data-testid="finish-rejected">
              {proposal.rejected.map((c, n) => (
                <li key={n}>使えなかった指示: {c}</li>
              ))}
            </ul>
          )}
          {proposal.questions.length > 0 && (
            <Questions questions={proposal.questions} answers={answers} setAnswers={setAnswers} busy={run.state === 'busy'} onRetry={(qa) => void send(proposal.text, qa, proposal.schemeIds)} />
          )}
          <div className="row">
            <button className="primary"
              type="button"
              data-testid="finish-confirm"
              disabled={!proposal.groups.length}
              onClick={() => {
                const d = store.get().doc;
                if (finishKey(d, proposal.schemeIds) !== proposal.base) {
                  store.set({ message: '仕上げ方を作った後にスキームか書式が変わったので、当てませんでした。もう一度作ってください' });
                  setProposal(null);
                  return;
                }
                store.commit(applyFinish(d, proposal.schemeIds, proposal.ops, proposal.myStyles));
                setProposal(null);
                track('llm:finish-confirm');
              }}
            >
              確定
            </button>
            <button
              type="button"
              data-testid="finish-discard"
              onClick={() => {
                setProposal(null);
                track('llm:finish-discard');
              }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
      {consent && (
        <LlmConsent
          paidKey={s.paidKey}
          onClose={(ok) => {
            setConsent(false);
            if (ok) {
              setLlmSettings({ consented: true });
              void send(text);
            }
          }}
        />
      )}
    </div>
  );
}

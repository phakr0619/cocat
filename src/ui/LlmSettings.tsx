import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { forgetLlmKey, getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { GEMINI_MODELS } from '../llm/gemini';
import { providerLabel, showFreeKeyNotes } from '../llm/providerLabel';
import { llmErrorText, type ThinkingLevel } from '../llm/types';

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; missing: string[] } | { state: 'ng'; text: string };

/** AI の設定: 会社・モデル・キー（次に開いたときも使うか・消す）と、データの扱いの説明 */
export function LlmSettings({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const to = providerLabel(s.provider);
  const [key, setKey] = useState(s.apiKey);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => setKey(s.apiKey), [s.apiKey]);

  const test = async () => {
    setLlmSettings({ apiKey: key });
    const p = llmProvider(getLlmSettings());
    if (!p) return setCheck({ state: 'ng', text: 'キーを入れてください' });
    setCheck({ state: 'busy' });
    const r = await p.listModels();
    if (r.ok) {
      const ids = new Set(r.value.map((m) => m.id));
      setCheck({ state: 'ok', missing: GEMINI_MODELS.filter((m) => !ids.has(m.id)).map((m) => m.name) });
      track('llm:test-ok');
    } else {
      setCheck({ state: 'ng', text: llmErrorText(r.error, getLlmSettings().paidKey) });
      track(`llm:error-${r.error.kind}`);
    }
  };

  return (
    <dialog ref={ref} className="about llm-settings" data-testid="llm-settings" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>AI の設定</h2>
      <p>
        {`「言葉から作る」などの機能は、あなたの ${to.product}（${to.company}）の API キーを使い、このブラウザから ${to.product} を直接呼びます。こちらのサーバーは通りません。`}キーは
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>
        で作れます。
      </p>
      <label className="field">
        <span>API キー</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid="llm-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => key.trim() !== s.apiKey && setLlmSettings({ apiKey: key })}
        />
      </label>
      <p className="muted" data-testid="llm-key-session">キーは、このページを開いている間だけ使います。閉じるか読み込み直すと消えます。</p>
      <label className="check">
        <input type="checkbox" data-testid="llm-remember" checked={s.remember} onChange={(e) => setLlmSettings({ apiKey: key, remember: e.target.checked })} />
        次に開いたときも、このキーを使う
      </label>
      {s.remember && (
        <p className="muted" data-testid="llm-key-saved">
          キーは、暗号化せずにこのブラウザに保存されます。ほかの人も使う PC では付けないでください。
        </p>
      )}
      <label className="check">
        <input type="checkbox" data-testid="llm-paid" checked={s.paidKey} onChange={(e) => setLlmSettings({ paidKey: e.target.checked })} />
        請求先を設定した有料のキーを使う
      </label>
      {showFreeKeyNotes(s) && (
        <p className="warn" data-testid="llm-free-warning">
          無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。Gemini API の規約でそう決まっています。未発表の構造など秘密の内容は、請求先を設定したキーで使ってください。
        </p>
      )}
      {showFreeKeyNotes(s) && (
        <p className="muted" data-testid="llm-free-limits">
          無料のキーは遅く、回数も少なめです。下書き 1 回に 1〜3 分かかることがあり、作れる下書きは 1 日に 10〜20 回ほどです。Gemini 3.8 Flash の無料の枠は 1 日 20 回で、日本時間の 16〜17 時ごろに戻ります。速く多く使うには、AI Studio でキーのプロジェクトに請求先を付けます。有料のキーなら数秒で返ります。
        </p>
      )}
      <label className="field">
        <span>モデル</span>
        <select data-testid="llm-model" value={s.model} onChange={(e) => setLlmSettings({ model: e.target.value })}>
          {/* 前に選んだモデルが一覧から外れていても、それも出す */}
          {!GEMINI_MODELS.some((m) => m.id === s.model) && <option value={s.model}>{s.model}</option>}
          {GEMINI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.paidOnly ? ' ・有料のキーだけ' : ''}
            </option>
          ))}
        </select>
      </label>
      {!s.paidKey && GEMINI_MODELS.find((m) => m.id === s.model)?.paidOnly && (
        <p className="warn" data-testid="llm-paid-only">このモデルは、無料のキーでは使えません。</p>
      )}
      <label className="field">
        <span>考える深さ: 浅いほど速く、深いほど正確になりやすい</span>
        <select data-testid="llm-thinking" value={s.thinking} onChange={(e) => setLlmSettings({ thinking: e.target.value as ThinkingLevel })}>
          <option value="low">浅い・速い</option>
          <option value="medium">ふつう・Gemini の既定</option>
          <option value="high">深い・遅い</option>
        </select>
      </label>
      <div className="row">
        <button type="button" data-testid="llm-test" onClick={test} disabled={check.state === 'busy'}>
          つながるか試す
        </button>
        <button type="button" data-testid="llm-forget" onClick={() => { forgetLlmKey(); setCheck({ state: 'idle' }); }} disabled={!s.apiKey && !key}>
          キーを消す
        </button>
      </div>
      <p className="muted" data-testid="llm-check" aria-live="polite">
        {check.state === 'busy' && '確かめています…'}
        {check.state === 'ok' && (check.missing.length ? `つながりました。ただし、このキーでは ${check.missing.join('・')} が一覧にありません` : 'つながりました')}
        {check.state === 'ng' && <span className="warn">{check.text}</span>}
      </p>
      <h3>送るもの・送らないもの</h3>
      <ul>
        <li>送るのは、AI の機能を使うときに入力した文章と添付した画像、今のスキームの化合物の構造・番号・呼び名・条件だけです。初めて使うときに、もう一度確かめます。</li>
        <li>{`キーは ${to.product} の API にだけ送ります。`}文書・プロジェクト・書き出し・使い方の統計には入れません。</li>
        <li>キーは Google AI Studio で、この用途のために新しく作ることをおすすめします。AI Studio で作ったキーは、はじめから Gemini にしか使えません。</li>
      </ul>
      <form method="dialog">
        <button type="submit">閉じる</button>
      </form>
    </dialog>
  );
}

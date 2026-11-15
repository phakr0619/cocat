import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { forgetLlmKey, getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { PROVIDERS, providerInfo, showFreeKeyNotes, type ProviderId } from '../llm/providers';
import { testConnection } from '../llm/testConnection';
import { llmErrorText, type ThinkingLevel } from '../llm/types';

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; missing: string[] } | { state: 'ng'; text: string };

/** AI の設定: 会社・モデル・キー（次に開いたときも使うか・消す）と、データの扱いの説明 */
export function LlmSettings({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const to = providerInfo(s.provider);
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
    const r = await testConnection(p);
    if (r.ok) {
      const ids = r.modelIds && new Set(r.modelIds);
      setCheck({ state: 'ok', missing: ids ? to.models.filter((m) => !ids.has(m.id)).map((m) => m.name) : [] });
      track('llm:test-ok');
    } else {
      setCheck({ state: 'ng', text: llmErrorText(r.error, getLlmSettings()) });
      track(`llm:error-${r.error.kind}`);
    }
  };

  return (
    <dialog ref={ref} className="about llm-settings" data-testid="llm-settings" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>AI の設定</h2>
      <label className="field">
        <span>会社</span>
        <select
          data-testid="llm-provider"
          value={s.provider}
          onChange={(e) => {
            setLlmSettings({ provider: e.target.value as ProviderId });
            setCheck({ state: 'idle' });
          }}
        >
          {Object.values(PROVIDERS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <p>
        {`「言葉から作る」などの機能は、あなたの ${to.product}（${to.company}）の API キーを使い、このブラウザから ${to.product} を直接呼びます。こちらのサーバーは通りません。`}キーは
        <a href={to.keyHelp.url} target="_blank" rel="noreferrer">{to.keyHelp.siteName}</a>
        で作れます。
      </p>
      {to.regionText && (
        <p data-testid="llm-region">
          リージョン: {to.regionText}
        </p>
      )}
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
      {to.hasPaidKeyOption && (
        <label className="check">
          <input type="checkbox" data-testid="llm-paid" checked={s.paidKey} onChange={(e) => setLlmSettings({ paidKey: e.target.checked })} />
          請求先を設定した有料のキーを使う
        </label>
      )}
      {showFreeKeyNotes(s) && (
        <p className="warn" data-testid="llm-free-warning">
          {to.freeKeyWarning.settings}
        </p>
      )}
      {showFreeKeyNotes(s) && (
        <p className="muted" data-testid="llm-free-limits">
          {to.freeKeyWarning.settingsLimits}
        </p>
      )}
      {to.allowCustomModel ? (
        // モデルは使う人が決める。一覧は、Cocat で動作を確かめたモデルの候補として出す
        <>
          <label className="field">
            <span>モデルの ID</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              list="llm-model-list"
              data-testid="llm-model-id"
              value={s.model}
              placeholder={to.defaultModel}
              onChange={(e) => setLlmSettings({ model: e.target.value.trim() })}
              onBlur={() => !s.model && setLlmSettings({ model: to.defaultModel })}
            />
            <datalist id="llm-model-list">
              {to.models.map((m) => (
                <option key={m.id} value={m.id} label={m.name} />
              ))}
            </datalist>
          </label>
          <p className="muted" data-testid="llm-model-note">
            {`候補は、Cocat で動作を確かめたモデルです（${to.models.map((m) => m.name).join('、')}）。ほかのモデルの ID も入れられます。`}
          </p>
        </>
      ) : (
        <label className="field">
          <span>モデル</span>
          <select data-testid="llm-model" value={s.model} onChange={(e) => setLlmSettings({ model: e.target.value })}>
            {/* 前に選んだモデルが一覧から外れていても、それも出す */}
            {!to.models.some((m) => m.id === s.model) && <option value={s.model}>{s.model}</option>}
            {to.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.paidOnly ? ' ・有料のキーだけ' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {to.hasPaidKeyOption && !s.paidKey && to.models.find((m) => m.id === s.model)?.paidOnly && (
        <p className="warn" data-testid="llm-paid-only">このモデルは、無料のキーでは使えません。</p>
      )}
      {to.thinking && (
        <label className="field">
          <span>考える深さ: 浅いほど速く、深いほど正確になりやすい</span>
          <select data-testid="llm-thinking" value={s.thinking} onChange={(e) => setLlmSettings({ thinking: e.target.value as ThinkingLevel })}>
            <option value="low">浅い・速い</option>
            <option value="medium">{to.thinkingMediumLabel}</option>
            <option value="high">深い・遅い</option>
          </select>
        </label>
      )}
      {to.testCostNote && (
        <p className="muted" data-testid="llm-test-note">
          {to.testCostNote}
        </p>
      )}
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
        <li>{to.keyHelp.advice}</li>
      </ul>
      <form method="dialog">
        <button type="submit">閉じる</button>
      </form>
    </dialog>
  );
}

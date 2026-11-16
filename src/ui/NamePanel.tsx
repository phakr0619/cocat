import { useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import type { EditorStore } from '../editor/store';
import { checkCasNumber } from '../chem/casNumber';
import { opsinName } from '../chem/opsin';
import { importText } from '../io/convert';
import { nameToStructure, resolveLocally, type NameSource } from '../llm/nameToStructure';
import { providerInfo } from '../llm/providers';
import { getLlmSettings, llmProvider, llmReady, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { llmErrorText } from '../llm/types';
import type { LibraryCompound } from '../project/model';
import { AiNotice } from './AiNotice';
import { LlmConsent } from './LlmConsent';

type Result = { state: 'idle' } | { state: 'busy'; abort: AbortController; by: 'opsin' | 'llm' } | { state: 'done'; source: NameSource; smiles: string; warnings: string[] } | { state: 'error'; text: string };

const SOURCE_TEXT: Record<NameSource, string> = {
  dictionary: '手元の辞書から置きました',
  library: 'ライブラリの化合物を置きました',
  smiles: 'SMILES として読んで置きました',
  opsin: '名前を OPSIN の規則で読んで置きました',
  llm: '', // AI に書かせた構造。送り先の名前は設定から差し込む（sourceText）
};

const sourceText = (source: NameSource, product: string) => (source === 'llm' ? `${product} に書かせた構造です。名前と合っているか確かめてください` : SOURCE_TEXT[source]);

/**
 * 名前から置く（M5 の最初の段）: 手元の辞書・ライブラリ・SMILES で引き、
 * 無ければ名前だけをこのサイトのサーバーの OPSIN（規則で変換する）に送り、それでも読めなければ（キーがあれば）AI に送り、RDKit で確かめてから置く
 */
export function NamePanel({ store, library, onOpenSettings }: { store: EditorStore; library(): LibraryCompound[]; onOpenSettings(): void }) {
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const [name, setName] = useState('');
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const [consent, setConsent] = useState(false);
  const product = providerInfo(s.provider).product;

  const place = (smiles: string, source: NameSource, warnings: string[] = []) => {
    try {
      const { doc, ids } = importText(store.get().doc, smiles, 'name.smi');
      store.commit(doc, ids);
      setResult({ state: 'done', source, smiles, warnings });
      track(`name:${source}`);
    } catch (e) {
      setResult({ state: 'error', text: String((e as Error).message ?? e) });
    }
  };

  const ask = async (n: string) => {
    const llm = llmProvider();
    if (!llm) return;
    const abort = new AbortController();
    setResult({ state: 'busy', abort, by: 'llm' });
    const r = await nameToStructure(llm, { name: n, thinking: getLlmSettings().thinking, signal: abort.signal });
    if (!r.ok) {
      if (r.error.kind === 'aborted') return setResult({ state: 'idle' });
      track(`name:error-${r.error.kind}`);
      return setResult({ state: 'error', text: r.error.kind === 'unresolved' ? r.error.message : llmErrorText(r.error, getLlmSettings()) });
    }
    place(r.smiles, 'llm', r.warnings);
  };

  /** 規則（OPSIN）で読めなければ、AI に回す */
  const viaRules = async (n: string) => {
    const abort = new AbortController();
    setResult({ state: 'busy', abort, by: 'opsin' });
    const op = await opsinName(n, abort.signal);
    if (abort.signal.aborted) return setResult({ state: 'idle' });
    if (op) return place(op.smiles, 'opsin', op.warning ? [op.warning] : []);
    setResult({ state: 'idle' });
    if (!llmReady()) return setResult({ state: 'error', text: `IUPAC 名などの規則でも、手元の辞書やライブラリでも読めない名前です。慣用名や商品名は、AI の設定で ${product} の API キーを入れると、${product} に名前を送って調べます` });
    if (!getLlmSettings().consented) setConsent(true);
    else void ask(n);
  };

  const go = () => {
    const n = name.trim();
    if (!n) return;
    const hit = resolveLocally(n, library());
    if (hit) return place(hit.smiles, hit.source);
    // CAS 番号は LLM に送らない（番号と構造の対応を当てずっぽうで書きやすい）。外のデータベースを使うまでは形だけ確かめる
    const cas = checkCasNumber(n);
    if (cas)
      return setResult({
        state: 'error',
        text: cas.ok
          ? `CAS 番号 ${cas.cas} の形と検査数字は正しいです。CAS 番号から構造を引く機能は、外のデータベースの利用条件を確かめてから足します。名前か SMILES で入れてください`
          : `CAS 番号の検査数字が合いません。${cas.cas} の最後の数字は ${cas.expected} のはずです。番号を確かめてください`,
      });
    void viaRules(n);
  };

  const busy = result.state === 'busy';
  return (
    <section className="name-panel" data-testid="name-panel">
      <h2>名前から置く</h2>
      <div className="row">
        <input
          data-testid="name-input"
          title="辞書に無い名前は、このサイトのサーバーの OPSIN で構造にします。サーバーは名前を残しません"
          placeholder="例: ethyl acetate、(S)-2-aminopropanoic acid、CCO"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) go();
          }}
        />
        <button type="button" className="primary" data-testid="name-place" disabled={busy || !name.trim()} onClick={go}>
          置く
        </button>
        {result.state === 'busy' && (
          <button type="button" data-testid="name-cancel" onClick={() => result.abort.abort()}>
            やめる
          </button>
        )}
      </div>
      {!llmReady(s) && (
        <p className="muted">
          {`規則で読めない慣用名・商品名は、${product} の API キーがあれば調べます。`}<button type="button" className="link" data-testid="name-open-settings" onClick={onOpenSettings}>AI の設定</button>
        </p>
      )}
      {result.state === 'busy' && <p className="muted" data-testid="name-busy">{result.by === 'opsin' ? '名前を規則で読んでいます…' : `${product} に聞いています…`}</p>}
      {result.state === 'done' && (
        <div data-testid="name-result" className={result.source === 'llm' ? 'warn' : 'muted'}>
          <p>{sourceText(result.source, product)}</p>
          {result.source === 'llm' && <AiNotice kind="name" />}
          {result.warnings.length > 0 && (
            <ul data-testid="name-warnings">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result.state === 'error' && <output className="error" data-testid="name-error">{result.text}</output>}
      {consent && (
        <LlmConsent
          paidKey={s.paidKey}
          onlyName
          onClose={(ok) => {
            setConsent(false);
            if (ok) {
              setLlmSettings({ consented: true });
              void ask(name.trim());
            }
          }}
        />
      )}
    </section>
  );
}

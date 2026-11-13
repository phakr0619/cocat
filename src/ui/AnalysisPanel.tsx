import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { docToSmiles } from '../io/smiles';
import { providerLabel } from '../llm/providerLabel';
import { getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { nameLocally, structureToName } from '../llm/structureToName';
import { llmErrorText } from '../llm/types';
import { AiNotice } from './AiNotice';
import { LlmConsent } from './LlmConsent';
import { analyzeFragment, conventionalFormula, formatAnalysisText, targetFragments, type AnalysisResult } from '../chem/analysis';
import { formatNmrText, predictNmr, type NmrShift } from '../chem/nmr';
import { rectOfPoints } from '../chem/geometry';
import { setText } from '../chem/schemeOps';
import { BOND_LEN } from '../chem/style';
import { useEditor, type EditorStore } from '../editor/store';
import type { Doc } from '../chem/model';

const MAX_SHOWN = 6;

/** 組成式の数字を下付きにする */
function Formula({ text, charge }: { text: string; charge: number }) {
  const parts = text.split(/(\d+)/).filter(Boolean);
  return (
    <span className="formula">
      {parts.map((p, i) => (/^\d+$/.test(p) ? <sub key={i}>{p}</sub> : <span key={i}>{p}</span>))}
      {charge !== 0 && <sup>{Math.abs(charge) > 1 ? Math.abs(charge) : ''}{charge > 0 ? '+' : '−'}</sup>}
    </span>
  );
}

/** 成分の書き方（「C9H13NO·HCl」「(C2H3O2−)2·Ca2+」）。分析の成分（式・電荷・数）から描く */
function SaltFormula({ components }: { components: NonNullable<Extract<AnalysisResult, { formula: string }>['components']> }) {
  return (
    <span className="formula">
      {components.map((c, i) => (
        <span key={i}>
          {i > 0 && '·'}
          {c.count > 1 && '('}
          <Formula text={conventionalFormula(c.formula)} charge={c.charge} />
          {c.count > 1 && (
            <>
              )<sub>{c.count}</sub>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

type NameState =
  | { state: 'idle' }
  | { state: 'confirm' }
  | { state: 'busy'; abort: AbortController }
  | { state: 'done'; name: string; verified: boolean; checkedBy?: 'opsin' | 'llm'; warnings: string[] }
  | { state: 'error'; text: string };

/**
 * 名前（構造 → 名前）。手元の辞書にあればその名前を出す（送らない）。無ければ、押したときだけ
 * 構造（SMILES）を AI（設定の送り先）に送って IUPAC 名を書かせ、名前から構造に戻して同じか確かめる
 */
function NameRow({ store, atomIds }: { store: EditorStore; atomIds: string[] }) {
  const doc = useEditor(store, (s) => s.doc);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const smiles = useMemo(() => {
    try {
      return docToSmiles(doc, atomIds).smiles ?? '';
    } catch {
      return '';
    }
  }, [doc, atomIds]);
  const local = useMemo(() => (smiles ? nameLocally(smiles) : []), [smiles]);
  const [st, setSt] = useState<NameState>({ state: 'idle' });
  const [consent, setConsent] = useState(false);
  const product = providerLabel(s.provider).product;
  // 構造が変わったら、前の答えは捨てる
  useEffect(() => setSt({ state: 'idle' }), [smiles]);
  if (!smiles) return null;
  if (local.length) {
    return (
      <>
        <dt>名前</dt>
        <dd data-testid="struct-name">
          <button type="button" className="value" onClick={() => copy(local[0])}>{local[0]}</button>
          <small className="muted">手元の辞書</small>
        </dd>
      </>
    );
  }
  const run = async () => {
    const llm = llmProvider();
    if (!llm) return;
    const abort = new AbortController();
    setSt({ state: 'busy', abort });
    track('llm:struct-name');
    const r = await structureToName(llm, { smiles, thinking: getLlmSettings().thinking, signal: abort.signal });
    if (!r.ok) {
      if (r.error.kind === 'aborted') return setSt({ state: 'idle' });
      return setSt({ state: 'error', text: llmErrorText(r.error, getLlmSettings().paidKey) });
    }
    setSt({ state: 'done', name: r.name, verified: r.verified, checkedBy: r.checkedBy, warnings: r.warnings });
  };
  return (
    <>
      <dt>名前</dt>
      <dd className="struct-name" data-testid="struct-name">
        {st.state === 'idle' && (
          <button type="button" className="paste" disabled={!s.apiKey} title={s.apiKey ? `構造（SMILES）を ${product} に送って、IUPAC 名を調べる` : `AI の設定で ${product} の API キーを入れると使えます`} onClick={() => setSt({ state: 'confirm' })} data-testid="struct-name-ask">
            AI で名前を調べる
          </button>
        )}
        {st.state === 'confirm' && (
          <span className="confirm">
            {`この分子の構造（SMILES）を ${product} に送ります`}。返った名前は、確かめるためにこのサイトのサーバーの OPSIN にも送ります。未発表の構造なら送らないでください。
            <button
              type="button"
              className="primary"
              data-testid="struct-name-send"
              onClick={() => {
                if (!getLlmSettings().consented) setConsent(true);
                else void run();
              }}
            >
              送る
            </button>
            <button type="button" onClick={() => setSt({ state: 'idle' })}>やめる</button>
          </span>
        )}
        {st.state === 'busy' && (
          <span className="muted">
            名前を調べて、構造に戻して確かめています…
            <button type="button" onClick={() => st.abort.abort()}>やめる</button>
          </span>
        )}
        {st.state === 'done' && (
          <span>
            <button type="button" className="value" onClick={() => copy(st.name)} data-testid="struct-name-value">{st.name}</button>
            <span
              className={`chip ${st.verified ? 'ok' : 'warn'}`}
              data-testid="struct-name-check"
              title={st.checkedBy === 'opsin' ? '名前を OPSIN の規則で構造に戻し、元の構造と比べました' : st.checkedBy === 'llm' ? '規則では読めない名前だったので、AI で構造に戻して元の構造と比べました' : undefined}
            >
              {st.verified ? (st.checkedBy === 'opsin' ? '確かめ済み（規則）' : '確かめ済み（AI）') : '要確認'}
            </span>
            {st.warnings.map((w, i) => (
              <small key={i} className="warn">{w}</small>
            ))}
            <AiNotice kind="struct-name" checked={st.checkedBy} />
          </span>
        )}
        {st.state === 'error' && <output className="error">{st.text}</output>}
        {consent && (
          <LlmConsent
            paidKey={s.paidKey}
            onClose={(ok) => {
              setConsent(false);
              if (ok) {
                setLlmSettings({ consented: true });
                void run();
              } else setSt({ state: 'idle' });
            }}
          />
        )}
      </dd>
    </>
  );
}

const SUB: Record<string, string> = { '2': '₂', '3': '₃', '4': '₄' };
const sub = (t: string) => t.replace(/(?<=[A-Z)])([234])/g, (d) => SUB[d]);

/** NMR の予測の表（¹H か ¹³C）。行を指すと、その原子をキャンバスで緑に示す。クリックで固定 */
function NmrTable({ title, rows, unit, digits, testid, onMark, pinned, setPinned }: {
  title: string;
  rows: NmrShift[];
  unit: 'H' | 'C';
  digits: number;
  testid: string;
  onMark(ids: string[]): void;
  pinned: NmrShift | null;
  setPinned(r: NmrShift | null): void;
}) {
  if (!rows.length) return null;
  return (
    <table className="nmr-table" data-testid={testid}>
      <caption>{title}</caption>
      <thead>
        <tr><th>δ (ppm)</th><th>数</th><th>種類</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={i}
            data-testid="nmr-row"
            className={`${pinned === r ? 'pinned' : ''} ${r.shift === null ? 'none' : ''}`}
            title={r.reason ? `予測できない: ${r.reason}` : `${r.method}${r.low ? '。込み合った形・環の中などで、加成則が当てになりにくい' : ''}`}
            onMouseEnter={() => onMark(r.atomIds)}
            onMouseLeave={() => onMark(pinned?.atomIds ?? [])}
            onClick={() => {
              const next = pinned === r ? null : r;
              setPinned(next);
              onMark(next?.atomIds ?? []);
            }}
          >
            <td className="shift">
              {r.shift === null ? '—' : r.shift.toFixed(digits)}
              {r.low && <span className="low" aria-label="当てになりにくい">△</span>}
            </td>
            <td>{r.count}{unit}</td>
            <td>
              {sub(r.label)}
              {r.reason && <small className="reason">予測できない: {r.reason}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** NMR の予測（教科書の加成則による目安）。開いたときだけ計算する */
function NmrSection({ doc, atomIds, setMarks }: { doc: Doc; atomIds: string[]; setMarks(ids: string[]): void }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState<NmrShift | null>(null);
  const p = useMemo(() => {
    if (!open) return null;
    try {
      return predictNmr(doc, atomIds);
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
  }, [open, doc, atomIds]);
  // 構造が変わったら、固定した行と印を外す
  useEffect(() => {
    setPinned(null);
    setMarks([]);
  }, [p, setMarks]);
  useEffect(() => () => setMarks([]), [setMarks]);
  const mark = (ids: string[]) => setMarks(ids.filter((id) => doc.atoms[id]));
  return (
    <details className="nmr" data-testid="nmr" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>NMR の予測の目安（加成則）</summary>
      {p && 'error' in p && <output className="error">{p.error}</output>}
      {p && !('error' in p) && (
        <>
          <p className="nmr-note" data-testid="nmr-note">
            教科書の加成則で出した目安です。加成則は、基本の値に置換基の寄与を足す表です。実測とは ¹³C で数 ppm、¹H で 0.1〜0.5 ppm ほど違うことがあり、溶媒によっても変わります。
            表で読めない原子には、推し量った値を出さずに「—」を出します。△ は、加成則が当てになりにくい形です。行を指すと原子をキャンバスで示し、クリックするとその表示を固定します。
          </p>
          <NmrTable title="¹H" rows={p.h1} unit="H" digits={2} testid="nmr-h1" onMark={mark} pinned={pinned} setPinned={setPinned} />
          <NmrTable title="¹³C" rows={p.c13} unit="C" digits={1} testid="nmr-c13" onMark={mark} pinned={pinned} setPinned={setPinned} />
          <button type="button" className="paste" data-testid="nmr-copy" onClick={() => copy(formatNmrText(p))} title="論文の書き方で、δ の値の大きい順にコピーする">
            値をコピー
          </button>
        </>
      )}
    </details>
  );
}

const noMarks = () => {};

export function AnalysisPanel({ store, showStereo, setShowStereo, setMarks = noMarks }: {
  store: EditorStore;
  showStereo: boolean;
  setShowStereo(v: boolean): void;
  setMarks?(ids: string[]): void;
}) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const results: AnalysisResult[] = useMemo(() => {
    try {
      return targetFragments(doc, selection)
        .filter((f) => f.length > 0)
        .slice(0, MAX_SHOWN)
        .map((f) => analyzeFragment(doc, f));
    } catch (e) {
      return [{ atomIds: [], error: String((e as Error).message ?? e) }];
    }
  }, [doc, selection]);

  const pasteToCanvas = (r: AnalysisResult) => {
    if ('error' in r) return;
    const d = store.get().doc;
    const box = rectOfPoints(r.atomIds.map((id) => d.atoms[id]))!;
    store.commit(setText(d, null, { x: box.x1, y: box.y2 + BOND_LEN * 1.6 }, formatAnalysisText(r)));
  };

  return (
    <section className="analysis" data-testid="analysis">
      <h2>
        {selection.size ? '選んだ分子の分析' : '分析'}
        <label className="toggle">
          <input type="checkbox" checked={showStereo} onChange={(e) => setShowStereo(e.target.checked)} data-testid="show-stereo" /> R/S・E/Z を表示
        </label>
      </h2>
      {results.length === 0 && <p className="muted">分子を描くと、組成式や分子量がここに出ます。</p>}
      {results.map((r, i) =>
        'error' in r ? (
          <output key={i} className="error">{r.error}</output>
        ) : (
          <div className="card" key={i} data-testid="analysis-card">
            <dl>
              <dt>組成式</dt>
              <dd>
                <button type="button" className="value" title="クリックでコピー" onClick={() => copy(r.formula)}>
                  <Formula text={r.formula} charge={r.charge} />
                </button>
              </dd>
              {r.saltFormula && (
                <>
                  <dt>成分</dt>
                  <dd>
                    <button type="button" className="value" data-testid="salt-formula" title="塩などの成分。クリックでコピー" onClick={() => copy(r.saltFormula!)}>
                      <SaltFormula components={r.components!} />
                    </button>
                  </dd>
                </>
              )}
              <dt>分子量</dt>
              <dd><button type="button" className="value" data-testid="mw" onClick={() => copy(r.mw.toFixed(2))}>{r.mw.toFixed(2)}</button></dd>
              <dt>精密質量</dt>
              <dd><button type="button" className="value" onClick={() => copy(r.exactMass.toFixed(4))}>{r.exactMass.toFixed(4)}</button></dd>
              <dt>m/z</dt>
              <dd>
                {r.mz.map((z) => (
                  <button type="button" className="value" key={z.label} onClick={() => copy(z.value.toFixed(4))}>
                    {z.value.toFixed(4)} <small>{z.label}</small>
                  </button>
                ))}
              </dd>
              {r.isotopes && r.isotopes.length > 1 && (
                <>
                  <dt>同位体</dt>
                  <dd>
                    <button
                      type="button"
                      className="value"
                      data-testid="isotopes"
                      title="質量分析で見える山の高さで、いちばん高い山を 100 にしている。クリックでコピー"
                      onClick={() => copy(r.isotopes!.map((p) => `${p.mass.toFixed(4)} (${p.rel.toFixed(1)})`).join(', '))}
                    >
                      {r.isotopes.slice(0, 6).map((p) => `${p.offset ? `M+${p.offset}` : 'M'} ${p.rel.toFixed(p.rel >= 10 ? 0 : 1)}`).join(' · ')}
                    </button>
                  </dd>
                </>
              )}
              {r.ea.length > 0 && (
                <>
                  <dt>元素分析</dt>
                  <dd>
                    <button type="button" className="value" onClick={() => copy(r.ea.map((e) => `${e.element}, ${e.pct.toFixed(2)}`).join('; '))}>
                      {r.ea.map((e) => `${e.element} ${e.pct.toFixed(2)}`).join(', ')}
                    </button>
                  </dd>
                </>
              )}
              <dt>物性</dt>
              <dd className="props">
                logP {r.logP.toFixed(2)} · TPSA {r.tpsa.toFixed(1)} · HBD {r.hbd} · HBA {r.hba} · 回転 {r.rotatable}
                <span className={`chip ${r.lipinskiViolations ? 'warn' : 'ok'}`}>Lipinski {r.lipinskiViolations ? `違反 ${r.lipinskiViolations}` : '適合'}</span>
              </dd>
              {r.stereo.length > 0 && (
                <>
                  <dt>立体中心</dt>
                  <dd>{r.stereo.map((s) => s.label).join(', ')}</dd>
                </>
              )}
              <NameRow store={store} atomIds={r.atomIds} />
              {r.bondStereo.length > 0 && (
                <>
                  <dt>二重結合</dt>
                  <dd data-testid="bond-stereo">{r.bondStereo.map((s) => s.label).join(', ')}</dd>
                </>
              )}
            </dl>
            {r.warnings.length > 0 && (
              <ul className="warnings" data-testid="warnings">
                {r.warnings.map((w, j) => (
                  <li key={j}>
                    <button type="button" onClick={() => w.atomIds.length && store.set({ selection: new Set(w.atomIds), tool: 'select' })} disabled={!w.atomIds.length}>
                      ⚠ {w.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <NmrSection doc={doc} atomIds={r.atomIds} setMarks={setMarks} />
            <button type="button" className="paste" onClick={() => pasteToCanvas(r)}>キャンバスに貼る</button>
          </div>
        ),
      )}
    </section>
  );
}

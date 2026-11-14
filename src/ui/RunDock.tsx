// 下の表の欄: 実験の記録の仕込み・操作と記録・収支を、キャンバスの下の広い表で入れる。
// 図の箱を選ぶと、その操作の行を同じ色で示す
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { applyRunDraft, runPrompt, textToRun, type RunDraft } from '../llm/textToRun';
import { providerLabel } from '../llm/providerLabel';
import { getLlmSettings, llmProvider, setLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { llmErrorText } from '../llm/types';
import { AiNotice } from './AiNotice';
import { track } from '../analytics';
import { useEditor, type EditorStore } from '../editor/store';
import { printPage } from '../io/print';
import { formatPct, runBalance } from '../process/balance';
import { runBoxes, runTargetOf } from '../process/layout';
import { formatAmount, formatGrams, OP_KINDS, parseAmount, type Amount, type Material, type OpKind, type ProcessRun } from '../process/model';
import {
  addEvent, addMaterial, addOperation, addOutput, dissolveRun, materialName, moveOperation, removeEvent, removeMaterial, removeOperation, removeOutput, removeRun, runLabel,
  setRunFlow, setRunInfo, setRunProduct, updateEvent, updateMaterial, updateOperation, updateOutput,
} from '../process/ops';
import { materialDerived, runEventsCsv, runReportHtml, runTables, runToTableRow, runTsv } from '../process/report';
import { download } from './IoPanel';

type Tab = 'materials' | 'log' | 'balance' | 'memo';
const HEIGHT_KEY = 'ai-chem-editor:dock-height';
const NOTICE_KEY = 'ai-chem-editor:run-notice';

/** 確定（Enter かフォーカスが外れたとき）で値を渡すセル。Enter は onEnter（次の行へ進むなど）も呼ぶ */
function Cell({ value, onCommit, testId, placeholder, label, className, onEnter, list }: { value: string; onCommit(v: string): void; testId?: string; placeholder?: string; label: string; className?: string; onEnter?(): void; list?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`dock-cell${className ? ` ${className}` : ''}`}
      value={v}
      aria-label={label}
      data-testid={testId}
      placeholder={placeholder}
      list={list}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (v !== value) onCommit(v);
          onEnter?.();
        }
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}

const numOrUndef = (v: string): number | undefined => (v.trim() === '' || !isFinite(Number(v)) ? undefined : Number(v));
const pad = (n: number) => String(n).padStart(2, '0');
const now = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function RunDock({ store, runId, onClose }: { store: EditorStore; runId: string; onClose(): void }) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const run = doc.runs?.[runId];
  const [tab, setTab] = useState<Tab>('log');
  const [height, setHeight] = useState(() => {
    try {
      return Math.max(160, Math.min(600, Number(localStorage.getItem(HEIGHT_KEY)) || 290));
    } catch {
      return 290;
    }
  });
  const [notice, setNotice] = useState(() => {
    try {
      return localStorage.getItem(NOTICE_KEY) !== 'seen';
    } catch {
      return true;
    }
  });
  const llm = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const [quick, setQuick] = useState('');
  const quickRef = useRef<HTMLInputElement>(null);
  const [quickOp, setQuickOp] = useState<string | null>(null);
  // キャンバスで選んだ箱の操作
  const selectedOp = (() => {
    for (const id of selection) {
      const t = runTargetOf(doc, id);
      if (t?.runId === runId && t.opId) return t.opId;
    }
    return null;
  })();
  useEffect(() => {
    if (selectedOp) setQuickOp(selectedOp);
  }, [selectedOp]);
  if (!run) return null;
  const bal = runBalance(run);
  const say = (message: string) => store.set({ message });
  const commit = (d: typeof doc) => store.commit(d);
  /** 量のセル: 「10 g」「100 mL」の形で入れる。空なら消す。読めなければ知らせて元に戻す */
  const amountOf = (v: string, set: (a: Amount | undefined) => void) => {
    if (!v.trim()) return set(undefined);
    const a = parseAmount(v);
    if (a) set(a);
    else say(`「${v}」を量として読めません。「10 g」「100 mL」のように、数と単位（mg・g・kg・µL・mL・L）で入れます`);
  };
  const opOf = quickOp && run.operations.some((o) => o.id === quickOp) ? quickOp : (run.events.at(-1)?.opId ?? run.operations[0]?.id);
  const selectOp = (opId: string) => {
    const i = run.operations.findIndex((o) => o.id === opId);
    const box = runBoxes(store.get().doc, runId)[i];
    setQuickOp(opId);
    if (box) store.set({ selection: new Set([box.id]), tool: 'select' });
  };
  /** 記録を足す。はじめが「10:32」のような時刻なら、その時刻の記録にする。無ければ今の時刻 */
  const addQuick = () => {
    const t = quick.trim();
    if (!t || !opOf) return;
    const m = t.match(/^(\d{1,2}[:：]\d{2})\s+(.*)$/);
    commit(addEvent(store.get().doc, runId, { opId: opOf, time: m ? m[1].replace('：', ':') : now(), action: m ? m[2] : t }));
    setQuick('');
    track('run:event', { once: true });
    quickRef.current?.focus();
  };
  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev: PointerEvent) => setHeight(Math.max(160, Math.min(window.innerHeight - 200, h0 + (y0 - ev.clientY))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round((document.querySelector('.dock') as HTMLElement | null)?.offsetHeight ?? h0)));
      } catch {
        // 置けなくても、開いている間は変えた高さのまま
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };
  const tables = runTables(doc, run, bal);
  const opSelect = (value: string | undefined, onChange: (v: string) => void, label: string, testId?: string) => (
    <select className="dock-cell" aria-label={label} data-testid={testId} value={value && run.operations.some((o) => o.id === value) ? value : run.operations[0]?.id} onChange={(e) => onChange(e.target.value)}>
      {run.operations.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );
  return (
    <section className="dock" data-testid="run-dock" style={{ height }} aria-label="実験の記録">
      <div className="dock-resize" onPointerDown={startResize} role="separator" aria-orientation="horizontal" aria-label="表の欄の高さを変える" />
      <div className="dock-head">
        <div className="dock-tabs" role="tablist">
          {([['materials', '仕込み'], ['log', '操作と記録'], ['balance', '収支'], ...(llm.apiKey ? ([['memo', '✦ メモから作る']] as const) : [])] as const).map(([id, name]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} data-testid={`run-tab-${id}`} onClick={() => setTab(id)}>
              {name}
            </button>
          ))}
        </div>
        <Cell label="題" placeholder="題" className="w-title" testId="run-title" value={run.title ?? ''} onCommit={(v) => commit(setRunInfo(store.get().doc, runId, { title: v }))} />
        <Cell label="ノート番号" placeholder="ノート番号" className="w-note" testId="run-notebook" value={run.notebook ?? ''} onCommit={(v) => commit(setRunInfo(store.get().doc, runId, { notebook: v }))} />
        <input type="date" className="dock-cell w-date" aria-label="行った日" data-testid="run-date" value={run.date ?? ''} onChange={(e) => commit(setRunInfo(store.get().doc, runId, { date: e.target.value }))} />
        <span className="spacer" />
        <FlowFormat run={run} set={(patch, ev) => (commit(setRunFlow(store.get().doc, runId, patch)), ev && track(ev, { once: true }))} />
        <button type="button" className="dock-close" data-testid="run-dock-close" title="表の欄を畳む" aria-label="表の欄を畳む" onClick={onClose}>
          ▾
        </button>
      </div>
      {notice && (
        <p className="dock-notice" data-testid="run-notice">
          実験の記録は、このブラウザの中だけに保存します。署名や変更の履歴は残らないので、正式な記録は実験ノートに残してください。
          <button
            type="button"
            className="link"
            onClick={() => {
              setNotice(false);
              try {
                localStorage.setItem(NOTICE_KEY, 'seen');
              } catch {
                // 置けなくても、開いている間は出さない
              }
            }}
          >
            分かりました
          </button>
        </p>
      )}
      <div className="dock-body">
        {tab === 'materials' && (
          <div className="dock-scroll">
            <table className="dock-table" data-testid="run-materials">
              <thead>
                <tr>
                  <th>役割</th>
                  <th>名前</th>
                  <th className="r">分子量</th>
                  <th className="r">当量</th>
                  <th className="r">量</th>
                  <th className="r">密度 (g/mL)</th>
                  <th className="r">mmol</th>
                  <th className="r">溶媒量 (mL/g)</th>
                  <th className="r">含量 (wt%)</th>
                  <th>ロット</th>
                  <th>入れる操作</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {run.materials.map((m) => {
                  const d = materialDerived(run, m);
                  const set = (patch: Partial<Material>) => commit(updateMaterial(store.get().doc, runId, m.id, patch));
                  return (
                    <tr key={m.id} data-testid="run-material" className={(m.opId ?? run.operations[0]?.id) === selectedOp ? 'h' : ''}>
                      <td>
                        <select className="dock-cell" aria-label="役割" value={m.role} onChange={(e) => set({ role: e.target.value as Material['role'] })}>
                          <option value="substrate">基質</option>
                          <option value="reagent">試薬</option>
                          <option value="solvent">溶媒</option>
                          <option value="water">水・水溶液</option>
                          <option value="other">その他</option>
                        </select>
                      </td>
                      <td>
                        {m.compoundId && doc.compounds?.[m.compoundId] ? <span className="dock-fixed" title="スキームの化合物。番号と呼び名はスキームで直す">{materialName(doc, m)}</span> : <Cell label="名前" testId="material-name" value={m.name} onCommit={(v) => set({ name: v })} />}
                      </td>
                      <td><Cell label="分子量" className="r w-num" value={m.mw === undefined ? '' : String(m.mw)} onCommit={(v) => set({ mw: numOrUndef(v) })} /></td>
                      <td><Cell label="当量" className="r w-num" value={m.equiv === undefined ? '' : String(m.equiv)} onCommit={(v) => set({ equiv: numOrUndef(v) })} /></td>
                      <td><Cell label="量" className="r w-amt" testId="material-amount" placeholder="10 g" value={formatAmount(m.amount)} onCommit={(v) => amountOf(v, (amount) => set({ amount }))} /></td>
                      <td><Cell label="密度" className="r w-num" testId="material-density" value={m.density === undefined ? '' : String(m.density)} onCommit={(v) => set({ density: numOrUndef(v) })} /></td>
                      <td className="r calc">{d.mmol === undefined ? '' : d.mmol.toFixed(2)}</td>
                      <td className="r calc">{d.volPerG === undefined ? '' : d.volPerG.toFixed(1)}</td>
                      <td><Cell label="含量" className="r w-num" testId="material-assay" value={m.assay === undefined ? '' : String(m.assay)} onCommit={(v) => set({ assay: numOrUndef(v) })} /></td>
                      <td><Cell label="ロット" className="w-lot" value={m.lot ?? ''} onCommit={(v) => set({ lot: v })} /></td>
                      <td>{opSelect(m.opId, (v) => set({ opId: v === run.operations[0]?.id ? undefined : v }), '入れる操作', 'material-op')}</td>
                      <td>
                        <button type="button" className="dock-x" aria-label={`${materialName(doc, m) || '行'} を消す`} title="この行を消す" onClick={() => commit(removeMaterial(store.get().doc, runId, m.id))}>✕</button>
                      </td>
                    </tr>
                  );
                })}
                <tr className="product">
                  <td>生成物</td>
                  <td>
                    {run.product.compoundId && doc.compounds?.[run.product.compoundId] ? <span className="dock-fixed">{materialName(doc, { id: '', role: 'other', name: run.product.name, compoundId: run.product.compoundId })}</span> : <Cell label="生成物の名前" value={run.product.name} onCommit={(v) => commit(setRunProduct(store.get().doc, runId, { name: v || '生成物' }))} />}
                  </td>
                  <td><Cell label="生成物の分子量" className="r w-num" testId="product-mw" value={run.product.mw === undefined ? '' : String(+run.product.mw.toFixed(2))} onCommit={(v) => commit(setRunProduct(store.get().doc, runId, { mw: numOrUndef(v) }))} /></td>
                  <td />
                  <td className="r calc" title="得た重さは「操作と記録」の最後の操作に入れる">{formatGrams(bal.productG)}</td>
                  <td />
                  <td />
                  <td />
                  <td><Cell label="生成物の含量" className="r w-num" testId="product-assay" value={run.product.assay === undefined ? '' : String(run.product.assay)} onCommit={(v) => commit(setRunProduct(store.get().doc, runId, { assay: numOrUndef(v) }))} /></td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
            <button type="button" className="dock-add" data-testid="material-add" onClick={() => commit(addMaterial(store.get().doc, runId, selectedOp && selectedOp !== run.operations[0]?.id ? { opId: selectedOp } : {}))}>
              ＋ 行を足す
            </button>
          </div>
        )}
        {tab === 'log' && (
          <div className="dock-split">
            <div className="dock-scroll dock-ops" data-testid="run-ops">
              {run.operations.map((op, i) => {
                const b = bal.ops[i];
                const last = i === run.operations.length - 1;
                return (
                  <div key={op.id} className={`dock-op${op.id === selectedOp ? ' h' : ''}`} data-testid="run-op" onPointerDown={(e) => (e.target as HTMLElement).closest('.dock-op-head') && !(e.target as HTMLElement).closest('input,select,button') && selectOp(op.id)}>
                    <div className="dock-op-head">
                      <span className="dock-op-n">{i + 1}</span>
                      <Cell label="操作の名前" testId="op-name" className="w-opname" value={op.name} onCommit={(v) => commit(updateOperation(store.get().doc, runId, op.id, { name: v || OP_KINDS.find((k) => k.kind === op.kind)!.name }))} />
                      <select className="dock-cell" aria-label="操作の種類" data-testid="op-kind" value={op.kind} onChange={(e) => commit(updateOperation(store.get().doc, runId, op.id, { kind: e.target.value as OpKind }))}>
                        {OP_KINDS.map((k) => (
                          <option key={k.kind} value={k.kind}>{k.name}</option>
                        ))}
                      </select>
                      <button type="button" className="dock-x" title="前へ動かす" aria-label={`${op.name} を前へ動かす`} disabled={i === 0} onClick={() => commit(moveOperation(store.get().doc, runId, op.id, -1))}>↑</button>
                      <button type="button" className="dock-x" title="後ろへ動かす" aria-label={`${op.name} を後ろへ動かす`} disabled={last} onClick={() => commit(moveOperation(store.get().doc, runId, op.id, 1))}>↓</button>
                      <button type="button" className="dock-x" title="この操作を消す" aria-label={`${op.name} を消す`} data-testid="op-remove" disabled={run.operations.length <= 1} onClick={() => commit(removeOperation(store.get().doc, runId, op.id))}>✕</button>
                    </div>
                    {op.outputs.map((o) => (
                      <div className="dock-out" key={o.id} data-testid="run-output">
                        <span className="dock-out-label">出る物</span>
                        <Cell label="出る物の名前" testId="output-name" placeholder="水層・母液など" value={o.name} onCommit={(v) => commit(updateOutput(store.get().doc, runId, op.id, o.id, { name: v }))} />
                        <Cell label="出る物の重さ" className="r w-amt" testId="output-amount" placeholder={b.derivedOutputId === o.id ? `差から ${formatGrams(b.derivedOutputG)}` : '重さ'} value={formatAmount(o.amount)} onCommit={(v) => amountOf(v, (amount) => commit(updateOutput(store.get().doc, runId, op.id, o.id, { amount })))} />
                        <Cell label="生成物の含量 (wt%)" className="r w-num" testId="output-assay" placeholder="含量 wt%" value={o.productAssay === undefined ? '' : String(o.productAssay)} onCommit={(v) => commit(updateOutput(store.get().doc, runId, op.id, o.id, { productAssay: numOrUndef(v) }))} />
                        <button type="button" className="dock-x" aria-label={`${o.name || '出る物'} を消す`} title="消す" onClick={() => commit(removeOutput(store.get().doc, runId, op.id, o.id))}>✕</button>
                      </div>
                    ))}
                    <div className="dock-out">
                      <span className="dock-out-label">{last ? '得た重さ' : '次へ進む重さ'}</span>
                      <Cell label={last ? '得た重さ' : '次へ進む重さ'} className="r w-amt" testId="op-carry" placeholder={b.carryDerived && b.carryG !== undefined ? `差から ${formatGrams(b.carryG)}` : '重さ'} value={formatAmount(op.carry)} onCommit={(v) => amountOf(v, (carry) => commit(updateOperation(store.get().doc, runId, op.id, { carry })))} />
                      <span className="dock-closure" data-testid="op-closure">{b.closure !== undefined ? `収支 ${formatPct(b.closure)}` : (b.why ?? '')}</span>
                      <button type="button" className="link" data-testid="output-add" onClick={() => commit(addOutput(store.get().doc, runId, op.id))}>＋ 出る物</button>
                    </div>
                  </div>
                );
              })}
              <div className="dock-op-add">
                <select className="dock-cell" aria-label="足す操作の種類" data-testid="op-add" value="" onChange={(e) => e.target.value && (commit(addOperation(store.get().doc, runId, e.target.value as OpKind, selectedOp ?? undefined)), track('run:add-op', { once: true }))}>
                  <option value="">＋ 操作を足す…</option>
                  {OP_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>{k.name}</option>
                  ))}
                </select>
                <span className="muted">{selectedOp ? '選んでいる操作の後ろに入ります' : 'いちばん後ろに入ります'}</span>
              </div>
            </div>
            <div className="dock-scroll dock-log">
              <table className="dock-table" data-testid="run-events">
                <thead>
                  <tr>
                    <th className="w-time">時刻</th>
                    <th>操作</th>
                    <th className="grow">したこと</th>
                    <th className="r">量</th>
                    <th>内温</th>
                    <th className="grow">測定・観察</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {run.events.map((e) => {
                    const set = (patch: Parameters<typeof updateEvent>[3]) => commit(updateEvent(store.get().doc, runId, e.id, patch));
                    return (
                      <tr key={e.id} data-testid="run-event" className={e.opId === selectedOp ? 'h' : ''}>
                        <td><Cell label="時刻" className="w-time" testId="event-time" value={e.time ?? ''} onCommit={(v) => set({ time: v })} /></td>
                        <td>{opSelect(e.opId, (v) => set({ opId: v }), '操作', 'event-op')}</td>
                        <td><Cell label="したこと" testId="event-action" value={e.action} onCommit={(v) => set({ action: v })} /></td>
                        <td><Cell label="量" className="r w-amt" testId="event-amount" value={e.amount ?? ''} onCommit={(v) => set({ amount: v })} /></td>
                        <td><Cell label="内温" className="w-temp" testId="event-temp" value={e.temp ?? ''} onCommit={(v) => set({ temp: v })} /></td>
                        <td><Cell label="測定・観察" testId="event-note" value={e.note ?? ''} onCommit={(v) => set({ note: v })} onEnter={() => quickRef.current?.focus()} /></td>
                        <td>
                          <button type="button" className="dock-x" aria-label="この記録を消す" title="この記録を消す" onClick={() => commit(removeEvent(store.get().doc, runId, e.id))}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="dock-quick">
                {opSelect(opOf, setQuickOp, '記録を足す操作', 'quick-op')}
                <input
                  ref={quickRef}
                  className="dock-cell"
                  data-testid="quick-event"
                  aria-label="記録を足す"
                  placeholder="したことを入れて Enter。「10:32 TFA を入れる」のように時刻から打つと、その時刻の記録になります"
                  value={quick}
                  onChange={(e) => setQuick(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addQuick()}
                />
                <button type="button" data-testid="quick-add" disabled={!quick.trim()} onClick={addQuick}>足す</button>
                <button type="button" title="操作と記録の表を CSV で保存する" onClick={() => download(`${runLabel(run)}.csv`, `﻿${runEventsCsv(store.get().doc, run)}`, 'text/csv')}>CSV</button>
              </div>
            </div>
          </div>
        )}
        {tab === 'memo' && <MemoToRun store={store} runId={runId} onDone={() => setTab('log')} />}
        {tab === 'balance' && (
          <div className="dock-scroll">
            <table className="dock-table plain" data-testid="run-balance">
              <thead>
                <tr>
                  {tables.balance.head.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tables.balance.rows.map((r, i) => (
                  <tr key={i} className={run.operations[i].id === selectedOp ? 'h' : ''}>
                    {r.map((c, j) => (
                      <td key={j}>{c}</td>
                    ))}
                  </tr>
                ))}
                <tr className="product">
                  <td>全体</td>
                  <td>{formatGrams(bal.totalInG)}</td>
                  <td colSpan={2}>{bal.totalOutG === undefined ? '' : `外へ出た物と得た物の合計 ${formatGrams(bal.totalOutG)}`}</td>
                  <td>{formatPct(bal.closure)}</td>
                </tr>
              </tbody>
            </table>
            <div className="row">
              <button type="button" data-testid="run-dissolve" title="記録のデータを消して、フロー図をただの図として残す" onClick={() => (store.commit(dissolveRun(store.get().doc, runId), new Set()), onClose())}>フロー図だけを残す</button>
              <button type="button" className="danger" data-testid="run-remove" title="この記録とフロー図を消す。元に戻すで戻せる" onClick={() => (store.commit(removeRun(store.get().doc, runId), new Set()), onClose())}>記録を消す</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** 右の欄: 実験の記録の結果・生成物の行方・確かめてほしい所 */
export function RunSummary({ store, runId, onOpenTable }: { store: EditorStore; runId: string; onOpenTable(): void }) {
  const doc = useEditor(store, (s) => s.doc);
  const run = doc.runs?.[runId];
  if (!run) return <p className="muted">実験の記録がありません。</p>;
  const say = (message: string) => store.set({ message });
  const copyTsv = () =>
    navigator.clipboard?.writeText(runTsv(store.get().doc, run)).then(
      () => say('仕込み・操作と記録・収支の表をコピーしました。Excel に貼れます'),
      () => say('コピーできませんでした'),
    );
  const toTable = () => {
    const r = runToTableRow(store.get().doc, runId);
    if (!r) return;
    store.commit(r.doc, new Set());
    say('検討表に、この記録の行を入れました。ほかの記録も入れると、回ごとに比べられます');
    track('run:to-table');
    onOpenTable();
  };
  const bal = runBalance(run);
  const t = runTables(doc, run, bal);
  const select = (opId?: string) => {
    const i = run.operations.findIndex((o) => o.id === opId);
    const box = runBoxes(doc, runId)[i];
    if (box) store.set({ selection: new Set([box.id]), tool: 'select' });
  };
  return (
    <section className="run-summary" data-testid="run-summary">
      <div className="card">
        <h2>{runLabel(run)}</h2>
        <dl className="kv" data-testid="run-results">
          {t.results.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {!t.results.length && <p className="muted">仕込みの量と、最後の操作の「得た重さ」を入れると、収率と PMI が出ます。</p>}
      </div>
      {bal.fate.length > 0 && (
        <div className="card">
          <h2>生成物の行方</h2>
          <dl className="kv" data-testid="run-fate">
            {bal.fate.map((f) => (
              <div key={f.name}>
                <dt>{f.name}</dt>
                <dd>{formatPct(f.pct)}</dd>
              </div>
            ))}
            <div>
              <dt>分からない分</dt>
              <dd>{formatPct(bal.fateUnknown)}</dd>
            </div>
          </dl>
          <p className="muted">理論収量に対する割合です。外へ出た物に生成物の含量を入れると出ます。</p>
        </div>
      )}
      <div className="card">
        <h2>確かめてほしい所{bal.warnings.length ? ` ${bal.warnings.length}` : ''}</h2>
        {bal.warnings.length ? (
          <ul className="run-warnings" data-testid="run-warnings">
            {bal.warnings.map((w, i) => (
              <li key={i}>
                <button type="button" className="link" onClick={() => select(w.opId)}>{w.text}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" data-testid="run-warnings-none">ありません。</p>
        )}
      </div>
      <div className="card">
        <h2>この記録から</h2>
        <div className="row">
        <button type="button" data-testid="run-pdf" title="反応式・仕込み・フロー図・記録・結果を A4 の 1 枚にまとめて印刷する。印刷の画面で「PDF に保存」を選ぶと PDF になる" onClick={() => (printPage(runReportHtml(store.get().doc, runId)), track('run:pdf'))}>
            PDF・印刷
          </button>
          <button type="button" data-testid="run-copy" title="仕込み・操作と記録・収支の表を、Excel に貼れる形でコピーする" onClick={copyTsv}>
            表をコピー
          </button>
          <button type="button" data-testid="run-to-table" title="この 1 回ぶんを、回ごとに比べる検討表の 1 行にする" onClick={toTable}>
            検討表の行にする
          </button>
        </div>
      </div>
      <p className="muted">量と記録は、キャンバスの下の表で入れます。フロー図の箱を選ぶと、その操作の行が青くなります。</p>
    </section>
  );
}

type MemoState = { state: 'idle' } | { state: 'busy'; abort: AbortController } | { state: 'error'; text: string };

/** メモから作る: 実験のメモの文章から、操作・外へ出た物・重さ・記録の下書きを AI で作る。確かめて「記録に入れる」を押すまで、記録は変わらない */
function MemoToRun({ store, runId, onDone }: { store: EditorStore; runId: string; onDone(): void }) {
  const doc = useEditor(store, (s) => s.doc);
  const s = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const run = doc.runs?.[runId];
  const [memo, setMemo] = useState('');
  const [state, setState] = useState<MemoState>({ state: 'idle' });
  const [draft, setDraft] = useState<RunDraft | null>(null);
  const [consent, setConsent] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  if (!run) return null;
  const send = async () => {
    const p = llmProvider();
    if (!p || !memo.trim()) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ state: 'busy', abort });
    setDraft(null);
    track('llm:run-memo');
    const r = await textToRun(p, { doc: store.get().doc, runId, memo, thinking: getLlmSettings().thinking, signal: abort.signal });
    if (!r.ok) {
      setState(r.error.kind === 'aborted' ? { state: 'idle' } : { state: 'error', text: llmErrorText(r.error, getLlmSettings().paidKey) });
      if (r.error.kind !== 'aborted') track(`llm:error-${r.error.kind}`);
      return;
    }
    setState({ state: 'idle' });
    setDraft(r.draft);
  };
  const start = () => {
    if (!getLlmSettings().consented) setConsent(true);
    else void send();
  };
  const apply = () => {
    if (!draft) return;
    store.commit(applyRunDraft(store.get().doc, runId, draft), new Set());
    store.set({ message: '下書きを記録に入れました。元に戻すと前の記録に戻ります' });
    track('run:memo-apply');
    setDraft(null);
    setMemo('');
    onDone();
  };
  const replaces = run.events.length > 0 || run.operations.some((o) => o.carry || o.outputs.some((x) => x.amount));
  return (
    <div className="dock-split dock-memo" data-testid="run-memo">
      <div className="dock-scroll dock-memo-in">
        <textarea
          data-testid="run-memo-text"
          aria-label="実験のメモ"
          placeholder={'実験のメモを貼ります。例:\n9:20 氷冷して EDC·HCl 12.2 g を入れた。内温 2 → 6 °C。\n12:41 1 M HCl 50 g で洗った。有機層 152.0 g、水層 61 g。'}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
        <div className="row">
          {state.state === 'busy' ? (
            <>
              <span className="muted" data-testid="run-memo-busy">作っています…</span>
              <button type="button" onClick={() => state.abort.abort()}>やめる</button>
            </>
          ) : (
            <button type="button" className="primary" data-testid="run-memo-run" disabled={!memo.trim()} onClick={start}>
              下書きを作る
            </button>
          )}
        </div>
        {!s.paidKey && providerLabel(s.provider).freeKeyUsedForTraining && <p className="warn" data-testid="run-memo-free-warning">無料のキーでは、送った内容が Google の製品の改善に使われます。秘密の内容は送らないでください。</p>}
        {state.state === 'error' && <p className="warn" data-testid="run-memo-error">{state.text}</p>}
        <details className="tts-preview">
          <summary>送る内容を見る</summary>
          <pre data-testid="run-memo-preview">{runPrompt(doc, run, memo)}</pre>
        </details>
      </div>
      <div className="dock-scroll dock-memo-out">
        {!draft && <p className="muted">メモから、操作・外へ出た物・重さ・記録の下書きを作ります。量・温度・時刻は、メモに書いてある数字だけを入れます。</p>}
        {draft && (
          <div data-testid="run-memo-draft">
            <AiNotice kind="run" />
            {draft.issues.length > 0 && (
              <ul className="run-warnings" data-testid="run-memo-issues">
                {draft.issues.map((i, n) => (
                  <li key={n}>要確認: {i.message}</li>
                ))}
              </ul>
            )}
            {draft.questions.length > 0 && (
              <ul data-testid="run-memo-questions">
                {draft.questions.map((q, n) => (
                  <li key={n}>{q}</li>
                ))}
              </ul>
            )}
            <ol className="memo-ops" data-testid="run-memo-ops">
              {draft.operations.map((op, i) => (
                <li key={i}>
                  <b>{op.name}</b>
                  <span className="muted">
                    {[
                      ...draft.materials.filter((m) => m.operation === i + 1).map((m) => `入れる: ${m.name}${m.amount ? ` ${formatAmount(m.amount)}` : ''}`),
                      ...op.outputs.map((o) => `出る: ${o.name}${o.amount ? ` ${formatAmount(o.amount)}` : ''}`),
                      op.carry ? `${i === draft.operations.length - 1 ? '得た重さ' : '次へ'} ${formatAmount(op.carry)}` : '',
                    ]
                      .filter(Boolean)
                      .join('、')}
                  </span>
                  <ul>
                    {draft.events.filter((e) => e.operation === i + 1).map((e, k) => (
                      <li key={k}>{[e.time, e.action, e.amount, e.temp, e.note].filter(Boolean).join('　')}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            {replaces && <p className="warn" data-testid="run-memo-replaces">今の操作と記録は、この下書きの物に置き換わります。仕込みの行は残ります。</p>}
            <div className="row">
              <button type="button" className="primary" data-testid="run-memo-apply" onClick={apply}>記録に入れる</button>
              <button type="button" data-testid="run-memo-discard" onClick={() => setDraft(null)}>やめる</button>
            </div>
          </div>
        )}
      </div>
      {consent && (
        <MemoConsent
          paidKey={s.paidKey}
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

/** 初めて送るときの同意（メモから作るときに送るもの） */
function MemoConsent({ paidKey, onClose }: { paidKey: boolean; onClose(ok: boolean): void }) {
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
        <li>送るのは、入力したメモと、今の仕込みの名前・量・役割、生成物の名前です。構造（SMILES）、ロット、描いた図は送りません。</li>
        <li>送る前に、「送る内容を見る」で中身を確かめられます。</li>
        {!paidKey && <li className="warn">無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。未発表の内容など秘密の内容は送らないでください。</li>}
      </ul>
      <AiNotice kind="run" />
      <form method="dialog" className="row">
        <button type="submit" data-testid="llm-consent-ok" onClick={() => (ok.current = true)}>
          同意して送る
        </button>
        <button type="submit">やめる</button>
      </form>
    </dialog>
  );
}

/** フロー図の書式（向き・重さ・生成物の重さ・太さ）。下の表の欄の上の段に、畳んで置く */
function FlowFormat({ run, set }: { run: ProcessRun; set(patch: Partial<ProcessRun['flow']>, event?: string): void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const f = run.flow;
  // 上の段は横へ送れる（overflow）ので、開いた欄は画面に固定して、段に切られないようにする
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  return (
    <details
      className="dock-fmt"
      ref={ref}
      onToggle={(e) => {
        const r = (e.currentTarget as HTMLDetailsElement).querySelector('summary')!.getBoundingClientRect();
        setAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
      }}
    >
      <summary data-testid="run-format">フロー図: {f.direction === 'vertical' ? '縦' : '横'}</summary>
      <div className="dock-fmt-pop" style={at ?? undefined}>
        <label className="dock-opt">
          向き
          <select data-testid="run-direction" aria-label="フロー図の向き" value={f.direction} onChange={(e) => set({ direction: e.target.value as ProcessRun['flow']['direction'] }, `run:flow-${e.target.value}`)}>
            <option value="horizontal">横に並べる</option>
            <option value="vertical">縦に並べる</option>
          </select>
        </label>
        <label className="dock-opt">
          <input type="checkbox" data-testid="run-show-mass" checked={f.showMass} onChange={(e) => set({ showMass: e.target.checked })} />
          重さを出す
        </label>
        <label className="dock-opt">
          <input type="checkbox" data-testid="run-show-product" checked={!!f.showProduct} disabled={!f.showMass} onChange={(e) => set({ showProduct: e.target.checked }, 'run:flow-product')} />
          外へ出る物の中の生成物の重さと、含量も出す
        </label>
        <label className="dock-opt">
          <input type="checkbox" data-testid="run-width-by-mass" checked={!!f.widthByMass} onChange={(e) => set({ widthByMass: e.target.checked }, 'run:flow-width')} />
          操作の間の矢印を、重さに合わせた太さにする
        </label>
      </div>
    </details>
  );
}

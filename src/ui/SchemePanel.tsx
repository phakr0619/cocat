import { useEffect, useState } from 'react';
import { track } from '../analytics';
import type { Doc } from '../chem/model';
import { useEditor, type EditorStore } from '../editor/store';
import { schemeCompounds, type Step } from '../scheme/model';
import {
  addStepWithProduct, addSubstrate, applyStyle, dissolveScheme, duplicateScheme, freeFragments, numberCompounds, parseReagents, removeStep,
  isPlaceholder, pinScheme, replaceCompound, schemeFromDrawing, setSchemeStyle, startScheme, unpinScheme, updateCompound, updateStep,
} from '../scheme/ops';
import { STYLE_PRESETS, deleteMyStyle, getStyle, loadMyStyles, type SchemeStyle } from '../scheme/style';
import { StyleEditor } from './StyleEditor';
import { NewSchemeForm } from './NewSchemeForm';
import { StoichTable } from './StoichTable';
import { schemeTargetOf } from '../scheme/pick';
import { PopupMenu } from './Menu';
import { Thumb } from './LibraryPanel';

/** 選択に含まれるスキームの id（無ければ文書の最初のスキーム） */
export function activeSchemeId(doc: Doc, sel: Set<string>): string | null {
  for (const id of sel) {
    const ref = doc.atoms[id]?.ref?.split(':')[0] ?? doc.arrows[id]?.ref ?? doc.texts[id]?.ref ?? doc.pluses[id]?.ref;
    if (ref && doc.schemes?.[ref]) return ref;
  }
  return Object.keys(doc.schemes ?? {})[0] ?? null;
}

/** 確定（Enter かフォーカスが外れたとき）で値を渡す入力欄 */
export function Field({ label, value, onCommit, testId, width }: { label: string; value: string; onCommit(v: string): void; testId?: string; width?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field" style={width ? { gridColumn: width } : undefined}>
      <span>{label}</span>
      <input
        value={v}
        data-testid={testId}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onCommit(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export const reagentsToText = (st: Step) => st.reagents.map((r) => (r.equiv !== undefined ? `${r.text} (${r.equiv} equiv)` : r.text)).join(', ');

/** 試薬の欄の文字を試薬の並びにする。化学量論表で入れた分子量・密度は、同じ名前の試薬なら引き継ぐ */
export function reagentsFromText(st: Step, v: string) {
  const old = new Map(st.reagents.map((r) => [r.text, r]));
  return parseReagents(v).map((r) => ({ ...r, mw: old.get(r.text)?.mw, density: old.get(r.text)?.density }));
}
/** 収率の欄の文字。数字なら数、「quant.」などは文字のまま */
export const parseYield = (v: string): number | string | undefined => (v === '' ? undefined : /^\d+(\.\d+)?%?$/.test(v.trim()) ? parseFloat(v) : v);
/** 段を 1 行にまとめた文字（「TFA / CH2Cl2, 0 °C, 1 h」） */
export function stepSummary(st: Step): string {
  const cond = [st.solvent, st.temp, st.time].filter(Boolean).join(', ');
  return [st.reagents.map((r) => r.text).join(', '), cond].filter(Boolean).join(' / ');
}

export function SchemePanel({
  store,
  newScheme = false,
  onAi,
  onNewRun,
  stoichHost,
}: {
  /** 化学量論表を出す所（キャンバスの下の欄） */
  stoichHost?: HTMLElement | null;
  /** この段を行った 1 回ぶんの、実験の記録を作る */
  onNewRun?(from: { schemeId: string; stepIndex: number }): void;
  store: EditorStore;
  /** 新しいスキームを始める（今あるスキームは出さない） */
  newScheme?: boolean;
  /** AI で直す・書く・仕上げを開く（キーがあるときだけ渡す） */
  onAi?(mode: 'create' | 'edit' | 'write' | 'finish'): void;
}) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const sid = newScheme ? null : activeSchemeId(doc, selection);
  const scheme = sid ? doc.schemes![sid] : null;
  const selected = freeFragments(doc, selection);
  const oneSelected = selection.size > 0 && selected.length === 1 ? selected[0] : null;
  const say = (message: string) => store.set({ message });
  const [myStyles, setMyStyles] = useState<SchemeStyle[]>(() => loadMyStyles());
  /** 開け閉めした段（段の id → 開いているか）。押していない段は、2 段までなら開き、3 段からはキャンバスで選んだ段だけ開く */
  const [stepOpen, setStepOpen] = useState<Record<string, boolean>>({});
  const [compoundOpen, setCompoundOpen] = useState<Record<string, boolean>>({});
  const compoundIds = scheme ? [...new Set(scheme.steps.flatMap((s) => [...s.from, ...s.to]))] : [];
  /** キャンバスで選んでいる化合物（その分子の原子を選んでいるとき） */
  const activeCompound = (() => {
    if (!sid) return null;
    for (const id of selection) {
      const ref = doc.atoms[id]?.ref;
      if (ref?.startsWith(`${sid}:`)) return ref.split(':')[1];
    }
    return null;
  })();
  /** 固定・複製・やめるのメニューを開く所 */
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  /** キャンバスで選んでいる段（矢印か条件の文字を選んでいるとき） */
  const activeStep = (() => {
    if (!sid) return -1;
    for (const id of selection) {
      if (!doc.arrows[id] && !doc.texts[id]) continue;
      const t = schemeTargetOf(doc, id);
      if (t?.kind === 'step' && t.schemeId === sid) return t.stepIndex;
    }
    return -1;
  })();
  const docStyles = Object.values(doc.styles ?? {});
  const pin = scheme?.pinned;
  // 固定した図の化合物量論表と番号は、固定したときの写しで見せる
  const view = scheme && pin ? { ...doc, compounds: schemeCompounds(doc, scheme) } : doc;
  const chooseStyle = (id: string) => {
    if (!sid) return;
    const mine = myStyles.find((x) => x.id === id);
    store.commit(mine ? applyStyle(store.get().doc, sid, mine) : setSchemeStyle(store.get().doc, sid, id));
    track(mine ? 'scheme:style-mine' : `scheme:style-${id.startsWith('custom-') ? 'custom' : id}`);
  };

  const fromDrawing = () => {
    const r = schemeFromDrawing(store.get().doc);
    if (r) {
      store.commit(r.doc, new Set());
      track('scheme:from-drawing');
    } else say('矢印のある反応式が見つかりません。分子と反応矢印を描いてから使ってください');
  };

  return (
    <section className="scheme-panel" data-testid="scheme-panel" data-scheme-ui>
      {!scheme && (
        <>
          <p className="muted">キャンバスに分子と矢印を描いて、スキームにします。スキームにすると、条件・番号・書式をここで直せます。</p>
          <div className="choices">
            <div className="choice">
              <button type="button" className="primary" onClick={fromDrawing}>描いた反応式をスキームにする</button>
              <small>分子・矢印・条件の文字を描いてから</small>
            </div>
            <div className="choice">
              <button type="button" disabled={!oneSelected} onClick={() => oneSelected && (store.commit(startScheme(store.get().doc, oneSelected).doc, new Set()), track('scheme:start'))}>
                選んだ分子からスキームを始める
              </button>
              <small>分子を 1 つ選んでから。段はこの欄で足します</small>
            </div>
          </div>
          <NewSchemeForm store={store} />
          {onAi && (
            <p className="muted">
              文章や論文の図からも作れます。<button type="button" className="link" data-testid="scheme-open-ai" onClick={() => onAi('create')}>AI で作る</button>
            </p>
          )}
        </>
      )}
      {scheme && sid && (
        <>
          {pin && (
            <div className="pinned" data-testid="scheme-pinned">
              <p>
                固定中です。{new Date(pin.at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })} に固定しました。化合物の番号・構造や書式を直しても、この図は変わりません。直すときは固定を外してください。
              </p>
              <button type="button" data-testid="unpin-scheme" title="今の化合物と書式で描き直す" onClick={() => (store.commit(unpinScheme(store.get().doc, sid)), track('scheme:unpin'))}>
                固定を外して描き直す
              </button>
            </div>
          )}
          <fieldset className="plain" disabled={!!pin}>
          <div className="row">
            <label className="field">
              <span>書式</span>
              <select data-testid="scheme-style" value={scheme.styleId} onChange={(e) => chooseStyle(e.target.value)}>
                <optgroup label="プリセット">
                  {STYLE_PRESETS.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </optgroup>
                {docStyles.length > 0 && (
                  <optgroup label="この文書の書式">
                    {docStyles.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </optgroup>
                )}
                {myStyles.filter((m) => !doc.styles?.[m.id]).length > 0 && (
                  <optgroup label="自分のテンプレート">
                    {myStyles.filter((m) => !doc.styles?.[m.id]).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            {myStyles.some((m) => m.id === scheme.styleId) && (
              <button type="button" onClick={() => setMyStyles(deleteMyStyle(scheme.styleId))} title="このブラウザの自分のテンプレートから消す。文書の書式は残る">
                テンプレートを消す
              </button>
            )}
          </div>
          <StyleEditor store={store} schemeId={sid} style={pin?.style ?? getStyle(scheme.styleId, doc.styles)} onSaved={setMyStyles} />
          {scheme.steps.map((st, i) => (
            <details
              className={`step${activeStep === i ? ' active' : ''}`}
              key={st.id}
              data-testid="scheme-step"
              open={stepOpen[st.id] ?? (scheme.steps.length === 1 || activeStep === i)}
              onToggle={(e) => {
                const open = (e.currentTarget as HTMLDetailsElement).open;
                if (open !== (stepOpen[st.id] ?? (scheme.steps.length === 1 || activeStep === i))) setStepOpen((m) => ({ ...m, [st.id]: open }));
              }}
            >
              <summary data-testid="step-summary">
                <b>段 {i + 1}</b>
                <span className="step-sum">{stepSummary(st)}</span>
                <span className="step-yield">{st.yield === undefined ? '' : typeof st.yield === 'number' ? `${st.yield}%` : st.yield}</span>
              </summary>
              <div className="step-head">
                <button type="button" disabled={!oneSelected} title="選んだ分子を、この段の基質に足す。カップリングの相手など" onClick={() => oneSelected && store.commit(addSubstrate(store.get().doc, sid, i, oneSelected), new Set())}>
                  ＋基質
                </button>
                <button type="button" onClick={() => store.commit(removeStep(store.get().doc, sid, i), new Set())}>段を消す</button>
              </div>
              <div className="grid">
                <Field
                  label="試薬（当量は括弧で）"
                  width="1 / 3"
                  testId="step-reagents"
                  value={reagentsToText(st)}
                  onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { reagents: reagentsFromText(st, v) }))}
                />
                <Field label="溶媒" testId="step-solvent" value={st.solvent ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { solvent: v || undefined }))} />
                <Field label="温度" testId="step-temp" value={st.temp ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { temp: v || undefined }))} />
                <Field label="時間" testId="step-time" value={st.time ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { time: v || undefined }))} />
                <Field
                  label="収率（%）"
                  testId="step-yield"
                  value={st.yield === undefined ? '' : String(st.yield)}
                  onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { yield: parseYield(v) }))}
                />
                <Field label="ノート番号" testId="step-notebook" value={st.notebook ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { notebook: v || undefined }))} />
              </div>
              <StoichTable store={store} doc={view} schemeId={sid} index={i} step={st} host={stoichHost} />
              {onNewRun && !pin && (
                <button type="button" className="link step-run" data-testid="step-new-run" title="この段を行った 1 回ぶんの記録を作る。仕込み・操作の流れと重さ・操作ごとの記録を入れると、フロー図と収支を描く" onClick={() => onNewRun({ schemeId: sid, stepIndex: i })}>
                  ＋ 実験の記録を作る
                </button>
              )}
            </details>
          ))}
          <div className="row">
            <button type="button" data-testid="add-step" disabled={!oneSelected} onClick={() => oneSelected && store.commit(addStepWithProduct(store.get().doc, sid, oneSelected), new Set())}>
              選んだ分子を生成物にして段を足す
            </button>
          </div>
          <h3>化合物</h3>
          <div className="compounds">
            {compoundIds.map((cid) => {
              const c = view.compounds![cid];
              return (
                <details
                  className={`compound${activeCompound === cid ? ' active' : ''}`}
                  key={cid}
                  data-testid="scheme-compound"
                  open={compoundOpen[cid] ?? (activeCompound === cid || isPlaceholder(c.structure))}
                  onToggle={(e) => {
                    const open = (e.currentTarget as HTMLDetailsElement).open;
                    if (open !== (compoundOpen[cid] ?? (activeCompound === cid || isPlaceholder(c.structure)))) setCompoundOpen((m) => ({ ...m, [cid]: open }));
                  }}
                >
                  <summary data-testid="compound-summary">
                    <Thumb c={c} />
                    <b>{c.number?.trim() || '番号なし'}</b>
                    <span className="step-sum">{c.nickname ?? ''}</span>
                  </summary>
                  <div className="grid compound">
                  <Field label="番号" testId="compound-number" value={c.number ?? ''} onCommit={(v) => store.commit(updateCompound(store.get().doc, cid, { number: v || undefined }))} />
                  <Field label="呼び名" width="3 / 4" testId="compound-nickname" value={c.nickname ?? ''} onCommit={(v) => store.commit(updateCompound(store.get().doc, cid, { nickname: v || undefined }))} />
                  <div className="compound-replace">
                    {isPlaceholder(c.structure) && <span className="muted" data-testid="compound-placeholder">枠です。キャンバスに分子を描いて選び、「選んだ分子にする」を押します</span>}
                    <button
                      type="button"
                      data-testid="compound-replace"
                      disabled={!oneSelected || !!pin}
                      title="キャンバスで選んだ分子を、この化合物の構造にする"
                      onClick={() => oneSelected && (store.commit(replaceCompound(store.get().doc, cid, oneSelected), new Set()), track('scheme:replace-compound'))}
                    >
                      選んだ分子にする
                    </button>
                  </div>
                  </div>
                </details>
              );
            })}
          </div>
          <div className="row">
            <button type="button" onClick={() => (store.commit(numberCompounds(store.get().doc, sid)), track('scheme:number'))} title="スキームに出てくる順に 1, 2, 3… を振る">番号を振る</button>
          </div>
          </fieldset>
          <div className="row">
            <button type="button" data-testid="scheme-more" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.left, y: r.bottom + 4 }); }}>
              ほかの操作 ▾
            </button>
          </div>
          {more && (
            <PopupMenu
              at={more}
              label="スキームの操作"
              testId="scheme-more-menu"
              onClose={() => setMore(null)}
              items={[
                ...(pin ? [] : [{ label: '固定する', testId: 'pin-scheme', title: '今の形で図を固定する。ほかのスキームと共有する化合物の番号・構造や書式を後で直しても、この図は変わらない', onClick: () => (store.commit(pinScheme(store.get().doc, sid)), track('scheme:pin')) }]),
                { label: 'スキームを複製', testId: 'duplicate-scheme', title: '同じ化合物で、条件だけ変えた反応を作る。化合物は共有するので、番号や構造を直すと両方が変わる', onClick: () => (store.commit(duplicateScheme(store.get().doc, sid).doc, new Set()), track('scheme:duplicate')) },
                { label: 'スキームをやめる', testId: 'dissolve-scheme', title: 'スキームのデータを消して、ただの図に戻す', onClick: () => store.commit(dissolveScheme(store.get().doc, sid)) },
              ]}
            />
          )}
          <p className="muted">{pin ? '固定した図の分子をキャンバスで直しても、固定した形に戻ります。' : '分子をキャンバスで直すと、化合物のデータも直り、描き直されます。'}</p>
          {onAi && (
            <div className="scheme-ai" data-testid="scheme-ai">
              <h3>AI で</h3>
              <div className="row">
                <button type="button" data-testid="scheme-ai-edit" onClick={() => onAi('edit')}>言葉で直す</button>
                <button type="button" data-testid="scheme-ai-write" onClick={() => onAi('write')}>実験項を書く</button>
                <button type="button" data-testid="scheme-ai-finish" onClick={() => onAi('finish')}>投稿の形に整える</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

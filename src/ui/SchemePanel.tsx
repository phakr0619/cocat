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

const reagentsToText = (st: Step) => st.reagents.map((r) => (r.equiv !== undefined ? `${r.text} (${r.equiv} equiv)` : r.text)).join(', ');

export function SchemePanel({
  store,
  newScheme = false,
  onAi,
}: {
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
    <section className="scheme-panel" data-testid="scheme-panel">
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
            <div className="step" key={st.id} data-testid="scheme-step">
              <div className="step-head">
                <b>段 {i + 1}</b>
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
                  onCommit={(v) => {
                    // 化学量論表で入れた分子量・密度は、同じ名前の試薬なら引き継ぐ
                    const old = new Map(st.reagents.map((r) => [r.text, r]));
                    const reagents = parseReagents(v).map((r) => ({ ...r, mw: old.get(r.text)?.mw, density: old.get(r.text)?.density }));
                    store.commit(updateStep(store.get().doc, sid, i, { reagents }));
                  }}
                />
                <Field label="溶媒" testId="step-solvent" value={st.solvent ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { solvent: v || undefined }))} />
                <Field label="温度" testId="step-temp" value={st.temp ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { temp: v || undefined }))} />
                <Field label="時間" testId="step-time" value={st.time ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { time: v || undefined }))} />
                <Field
                  label="収率（%）"
                  testId="step-yield"
                  value={st.yield === undefined ? '' : String(st.yield)}
                  onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { yield: v === '' ? undefined : /^\d+(\.\d+)?%?$/.test(v.trim()) ? parseFloat(v) : v }))}
                />
                <Field label="ノート番号" testId="step-notebook" value={st.notebook ?? ''} onCommit={(v) => store.commit(updateStep(store.get().doc, sid, i, { notebook: v || undefined }))} />
              </div>
              <StoichTable store={store} doc={view} schemeId={sid} index={i} step={st} />
            </div>
          ))}
          <div className="row">
            <button type="button" data-testid="add-step" disabled={!oneSelected} onClick={() => oneSelected && store.commit(addStepWithProduct(store.get().doc, sid, oneSelected), new Set())}>
              選んだ分子を生成物にして段を足す
            </button>
          </div>
          <h3>化合物</h3>
          <div className="compounds">
            {[...new Set(scheme.steps.flatMap((s) => [...s.from, ...s.to]))].map((cid) => {
              const c = view.compounds![cid];
              return (
                <div className="grid compound" key={cid} data-testid="scheme-compound">
                  <Thumb c={c} />
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
              );
            })}
          </div>
          <div className="row">
            <button type="button" onClick={() => (store.commit(numberCompounds(store.get().doc, sid)), track('scheme:number'))} title="スキームに出てくる順に 1, 2, 3… を振る">番号を振る</button>
          </div>
          </fieldset>
          <div className="row">
            {!pin && (
              <button
                type="button"
                data-testid="pin-scheme"
                onClick={() => (store.commit(pinScheme(store.get().doc, sid)), track('scheme:pin'))}
                title="今の形で図を固定する。ほかのスキームと共有する化合物の番号・構造や書式を後で直しても、この図は変わらない"
              >
                固定する
              </button>
            )}
            <button
              type="button"
              data-testid="duplicate-scheme"
              onClick={() => (store.commit(duplicateScheme(store.get().doc, sid).doc, new Set()), track('scheme:duplicate'))}
              title="同じ化合物で、条件だけ変えた反応を作る。化合物は共有するので、番号や構造を直すと両方が変わる"
            >
              スキームを複製
            </button>
            <button type="button" onClick={() => store.commit(dissolveScheme(store.get().doc, sid))} title="スキームのデータを消して、ただの図に戻す">スキームをやめる</button>
          </div>
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

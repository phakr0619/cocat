// 名前や SMILES と空の枠からスキームを作る。AI は使わない。
// 名前は手元の辞書・SMILES・このサイトの OPSIN の順に構造にし、空の欄と読めなかった名前は枠（仮の化合物）にする
import { useState } from 'react';
import { track } from '../analytics';
import { opsinName } from '../chem/opsin';
import type { EditorStore } from '../editor/store';
import { resolveLocally } from '../llm/nameToStructure';
import { checkPlan, confirmDraft, draftScheme, existingCompounds, type Plan, type PlanCompound } from '../llm/textToScheme';
import { parseReagents } from '../scheme/ops';
import { belowDrawing } from '../table/ops';

interface StepInput {
  /** 1 段目だけ使う（2 段目からは前の段の生成物が基質） */
  substrates: [string, string];
  reagents: string;
  solvent: string;
  temp: string;
  time: string;
  yield: string;
  product: string;
}

const emptyStep = (): StepInput => ({ substrates: ['', ''], reagents: '', solvent: '', temp: '', time: '', yield: '', product: '' });

/** 入れた文字から構造の SMILES を引く。読めなければ null。SMILES で入れたときは isSmiles（名前ではないので、呼び名にしない） */
export async function resolveName(text: string): Promise<{ smiles: string; isSmiles: boolean } | null> {
  const local = resolveLocally(text);
  if (local) return { smiles: local.smiles, isSmiles: local.source === 'smiles' };
  const op = await opsinName(text).catch(() => null);
  return op ? { smiles: op.smiles, isSmiles: false } : null;
}

export function NewSchemeForm({ store }: { store: EditorStore }) {
  const [steps, setSteps] = useState<StepInput[]>([emptyStep()]);
  const [busy, setBusy] = useState(false);
  const setStep = (i: number, patch: Partial<StepInput>) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const create = async () => {
    setBusy(true);
    const compounds: PlanCompound[] = [];
    const unread: string[] = [];
    /** 化合物を 1 つ足して ref を返す。空なら枠（label の名前） */
    const add = async (text: string, label: string): Promise<string> => {
      const ref = `c${compounds.length + 1}`;
      const t = text.trim();
      if (!t) {
        compounds.push({ ref, name: label });
        return ref;
      }
      const r = await resolveName(t);
      if (!r) unread.push(t);
      compounds.push({ ref, ...(r?.isSmiles ? {} : { name: t }), smiles: r?.smiles ?? null });
      return ref;
    };
    const plan: Plan = { compounds, steps: [] };
    let prev: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const from = i === 0 ? [await add(s.substrates[0], '基質 1'), ...(s.substrates[1].trim() ? [await add(s.substrates[1], '基質 2')] : [])] : prev;
      const to = [await add(s.product, `生成物 ${i + 1}`)];
      const y = s.yield.trim();
      plan.steps.push({
        from,
        to,
        reagents: parseReagents(s.reagents),
        ...(s.solvent.trim() ? { solvent: s.solvent.trim() } : {}),
        ...(s.temp.trim() ? { temp: s.temp.trim() } : {}),
        ...(s.time.trim() ? { time: s.time.trim() } : {}),
        ...(y ? { yield: /^\d+(\.\d+)?$/.test(y) ? Number(y) : y } : {}),
      });
      prev = to;
    }
    const d = store.get().doc;
    const checked = checkPlan(plan, existingCompounds(d));
    const made = draftScheme(d, checked, { text: '', model: '', origin: belowDrawing(d) });
    store.commit(confirmDraft(made.doc, made.schemeId), new Set());
    track('scheme:new-from-names');
    setBusy(false);
    setSteps([emptyStep()]);
    if (unread.length) store.set({ message: `構造にできなかった名前: ${unread.join('、')}。枠にしたので、分子を描いて選び、化合物の「選んだ分子にする」を押してください` });
  };

  return (
    <details className="new-scheme-form" data-testid="new-scheme-form">
      <summary>名前や SMILES から作る</summary>
      <p className="muted">空の欄と読めなかった名前は、枠にします。枠は、あとで描いた分子で埋められます。</p>
      {steps.map((s, i) => (
        <fieldset key={i} className="new-scheme-step" data-testid="new-scheme-step">
          <legend>{`段 ${i + 1}`}</legend>
          {i === 0 && (
            <div className="grid">
              {[0, 1].map((k) => (
                <label key={k} className="field">
                  <span>{k === 0 ? '基質' : '基質 2（あれば）'}</span>
                  <input
                    data-testid={`new-scheme-substrate-${k + 1}`}
                    placeholder="名前か SMILES"
                    value={s.substrates[k]}
                    onChange={(e) => setStep(i, { substrates: (k === 0 ? [e.target.value, s.substrates[1]] : [s.substrates[0], e.target.value]) as [string, string] })}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="grid">
            <label className="field" style={{ gridColumn: '1 / 3' }}>
              <span>試薬</span>
              <input data-testid="new-scheme-reagents" placeholder="HATU (1.2 equiv), DIPEA" value={s.reagents} onChange={(e) => setStep(i, { reagents: e.target.value })} />
            </label>
            <label className="field">
              <span>溶媒</span>
              <input data-testid="new-scheme-solvent" value={s.solvent} onChange={(e) => setStep(i, { solvent: e.target.value })} />
            </label>
            <label className="field">
              <span>温度</span>
              <input data-testid="new-scheme-temp" value={s.temp} onChange={(e) => setStep(i, { temp: e.target.value })} />
            </label>
            <label className="field">
              <span>時間</span>
              <input data-testid="new-scheme-time" value={s.time} onChange={(e) => setStep(i, { time: e.target.value })} />
            </label>
            <label className="field">
              <span>収率 %</span>
              <input data-testid="new-scheme-yield" value={s.yield} onChange={(e) => setStep(i, { yield: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>生成物</span>
            <input data-testid="new-scheme-product" placeholder="名前か SMILES" value={s.product} onChange={(e) => setStep(i, { product: e.target.value })} />
          </label>
          {i > 0 && i === steps.length - 1 && (
            <button type="button" className="link" data-testid="new-scheme-remove-step" onClick={() => setSteps((ss) => ss.slice(0, -1))}>
              この段を消す
            </button>
          )}
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="primary" data-testid="new-scheme-create" disabled={busy} onClick={() => void create()}>
          {busy ? '構造を引いています…' : 'スキームにする'}
        </button>
        <button type="button" data-testid="new-scheme-add-step" disabled={busy} onClick={() => setSteps((ss) => [...ss, emptyStep()])}>
          ＋ 段を足す
        </button>
      </div>
    </details>
  );
}

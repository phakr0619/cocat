import { beforeAll, describe, expect, it } from 'vitest';
import { checkPlan, type Plan, type TextToSchemeResult } from '../../src/llm/textToScheme';
import { loadRDKit } from '../rdkit';
import { CASES, existingFor, keyOfSmiles, planFromExpect, scoreCase, stopReason, summarize } from './score';

beforeAll(loadRDKit);

const run = (id: string, plan: Plan): TextToSchemeResult => {
  const c = CASES.find((x) => x.id === id)!;
  return { ok: true, checked: checkPlan(plan, existingFor(c)) };
};

describe('評価の件', () => {
  it('26 件あり、正解の SMILES はすべて読める', () => {
    expect(CASES).toHaveLength(26);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(26);
    for (const c of CASES) {
      if (c.expect.kind !== 'scheme') continue;
      for (const st of c.expect.steps) for (const s of [...st.from, ...st.to]) expect(keyOfSmiles(s), `${c.id}: ${s}`).not.toBeNull();
    }
  });
});

describe('採点', () => {
  it('正解をそのまま答えにすれば、どの件も正しく、条件もすべて当たる', () => {
    const scores = CASES.map((c) => scoreCase(c, { ok: true, checked: checkPlan(planFromExpect(c), existingFor(c)) }));
    // 聞き返す件・要確認にする件は、正解の答えの形が無いので除く
    const scheme = scores.filter((_, i) => CASES[i].expect.kind === 'scheme');
    expect(scheme.map((s) => [s.id, s.outcome, s.notes])).toEqual(scheme.map((s) => [s.id, 'correct', []]));
    expect(scheme.every((s) => s.conditions.hit === s.conditions.total)).toBe(true);
  });

  it('立体を間違えて、要確認も無ければ「黙って間違えた」', () => {
    const plan = planFromExpect(CASES.find((c) => c.id === 'mitsunobu')!);
    const wrong: Plan = { ...plan, compounds: plan.compounds.map((c) => (c.smiles === 'C[C@H](OC(=O)c1ccc([N+](=O)[O-])cc1)c1ccccc1' ? { ...c, smiles: 'C[C@@H](OC(=O)c1ccc([N+](=O)[O-])cc1)c1ccccc1' } : c)) };
    const s = scoreCase(CASES.find((c) => c.id === 'mitsunobu')!, run('mitsunobu', wrong));
    expect(s.outcome).toBe('silent-wrong');
    // 自信なしと答えていれば「要確認で止まった」
    const unsure: Plan = { ...wrong, compounds: wrong.compounds.map((c) => ({ ...c, confidence: 'low' as const })) };
    expect(scoreCase(CASES.find((c) => c.id === 'mitsunobu')!, run('mitsunobu', unsure)).outcome).toBe('flagged');
  });

  it('番号で指した今の化合物は、existing でも同じ構造でも正しい', () => {
    const c = CASES.find((x) => x.id === 'existing-number')!;
    const plan = planFromExpect(c);
    expect(plan.compounds[0]).toEqual({ ref: 'A', existing: 'c5' });
    expect(scoreCase(c, run(c.id, plan)).outcome).toBe('correct');
  });

  it('全合成の名前だけなら聞き返すのが正しく、経路を作れば黙って間違えた', () => {
    const c = CASES.find((x) => x.id === 'ask-total-synthesis')!;
    expect(scoreCase(c, run(c.id, { compounds: [], steps: [], questions: ['手順を書いてください'] })).outcome).toBe('correct');
    const invented: Plan = { compounds: [{ ref: 'A', smiles: 'CCO' }, { ref: 'B', smiles: 'CC=O' }], steps: [{ from: ['A'], to: ['B'], reagents: [{ text: 'PCC' }] }], questions: [] };
    expect(scoreCase(c, run(c.id, invented)).outcome).toBe('silent-wrong');
  });

  it('コード名の化合物は、要確認にすれば正しく、構造を作れば黙って間違えた', () => {
    const c = CASES.find((x) => x.id === 'flag-code-names')!;
    const missing: Plan = { compounds: [{ ref: 'A', name: 'ABC-123' }, { ref: 'B', name: 'ABC-124' }], steps: [{ from: ['A'], to: ['B'], reagents: [{ text: 'TFA' }] }] };
    expect(scoreCase(c, run(c.id, missing)).outcome).toBe('correct');
    const invented: Plan = { compounds: [{ ref: 'A', smiles: 'CC(C)(C)OC(=O)NCCO' }, { ref: 'B', smiles: 'NCCO' }], steps: [{ from: ['A'], to: ['B'], reagents: [{ text: 'TFA' }] }] };
    expect(scoreCase(c, run(c.id, invented)).outcome).toBe('silent-wrong');
  });

  it('上限（quota）とキー違いの失敗では残りを止め、ほかの失敗（時間切れ・混雑・形の崩れ）では続ける', () => {
    const fail = (kind: 'quota' | 'auth' | 'timeout' | 'server' | 'rate' | 'invalid-output'): TextToSchemeResult => ({ ok: false, error: { kind, message: '' } });
    expect(stopReason(fail('quota'))).toContain('上限');
    expect(stopReason(fail('auth'))).toContain('キー');
    for (const k of ['timeout', 'server', 'rate', 'invalid-output'] as const) expect(stopReason(fail(k))).toBeNull();
    expect(stopReason(run('amide-hatu', planFromExpect(CASES[0])))).toBeNull();
  });

  it('まとめ: 8 割以上が正しく、黙って間違えたものが無ければ合格。料金と秒数も出す', () => {
    const ok = Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, outcome: i < 8 ? ('correct' as const) : ('flagged' as const), conditions: { hit: 1, total: 2 }, notes: [] }));
    const s = summarize(ok, [{ seconds: 2, usage: { input: 1e6, output: 1e6 } }, { seconds: 4 }], 'gemini-3.8-flash');
    expect(s).toMatchObject({ total: 10, correct: 8, flagged: 2, silentWrong: 0, conditionRate: 0.5, pass: true, seconds: { mean: 3, max: 4 }, usd: 4.5, tokens: { input: 1e6, output: 1e6, thinking: 0 } });
    // 考えた分は output に入っているので、料金は output の値段で 1 回だけ数える
    expect(summarize(ok, [{ seconds: 1, usage: { input: 0, output: 1e6, thinking: 8e5 } }], 'gemini-3.8-flash')).toMatchObject({ usd: 3.75, tokens: { thinking: 8e5 } });
    expect(summarize([...ok.slice(0, 9), { ...ok[0], outcome: 'silent-wrong' }]).pass).toBe(false);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { checkFinish, checkFinishShape } from '../../src/llm/finish';
import { loadRDKit } from '../rdkit';
import { FINISH_CASES, finishBase, opsFromExpect, scoreFinish, type FinishEvalCase } from './finish-score';
import { keyOfSmiles } from './score';

beforeAll(loadRDKit);

const byId = (id: string) => FINISH_CASES.find((c) => c.id === id)!;
/** 決まった答えで採点する（finishSchemes の確かめを通す） */
function scoreWith(c: FinishEvalCase, raw: unknown) {
  const base = finishBase(c);
  const shape = checkFinishShape(raw);
  if ('error' in shape) throw new Error(shape.error);
  return scoreFinish(c, base, { ok: true, checked: checkFinish(base.doc, base.targets, shape.value) });
}

describe('仕上げの評価の件', () => {
  it('10 件あり、id は重ならず、SMILES は読める', () => {
    expect(FINISH_CASES).toHaveLength(10);
    expect(new Set(FINISH_CASES.map((c) => c.id)).size).toBe(10);
    const b = finishBase(FINISH_CASES[0]);
    for (const id of Object.values(b.ids)) expect(b.doc.compounds![id]).toBeDefined();
    expect(keyOfSmiles('N[C@@H](C)C(=O)NCC(=O)OC')).not.toBeNull();
  });

  it('直す前の文書は 2 つのスキームで、7 を共有し、上が lab・下が acs の書式', () => {
    const b = finishBase(FINISH_CASES[0]);
    expect(b.schemeIds).toHaveLength(2);
    const [s1, s2] = b.schemeIds.map((id) => b.doc.schemes![id]);
    expect([s1.styleId, s2.styleId]).toEqual(['lab', 'acs']);
    expect(Object.keys(b.ids)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(s1.steps[1].to).toEqual([b.ids.D]);
    expect(s2.steps[0].from).toContain(b.ids.D);
    expect(b.doc.compounds![b.ids.D].number).toBe('7');
    expect(finishBase(byId('scope-active')).targets).toEqual([b.schemeIds[0]]);
  });
});

describe('仕上げの採点', () => {
  it('正解をそのまま答えにすれば、どの件も正しい', () => {
    const got = FINISH_CASES.map((c) => {
      const s = scoreWith(c, opsFromExpect(c, finishBase(c)));
      return [c.id, s.outcome, s.outcome === 'correct' ? [] : s.notes];
    });
    expect(got).toEqual(FINISH_CASES.map((c) => [c.id, 'correct', []]));
  });

  it('頼んでいない所を変えたら、黙って間違えた', () => {
    const c = byId('rename-reagent');
    const s = scoreWith(c, { ops: [{ op: 'rename_reagent', scheme: 1, step: 1, reagent: 'TEA', text: 'Et3N' }, { op: 'set_style', style: 'acs' }] });
    expect(s.outcome).toBe('silent-wrong');
    expect(s.notes.join(' ')).toContain('スキーム 1の書式');
  });

  it('中身の変更を書き方の直しとしてやったら黙って間違え、できないと言えば正しい', () => {
    const c = byId('content-change');
    expect(scoreWith(c, { ops: [{ op: 'set_style', style: 'acs' }, { op: 'rename_reagent', scheme: 1, step: 2, reagent: 'TFA', text: 'HCl' }] }).outcome).toBe('silent-wrong');
    expect(scoreWith(c, { ops: [{ op: 'set_style', style: 'acs' }], cannot: ['TFA を HCl に替えるのは仕上げではできません'] }).outcome).toBe('correct');
    // 「直す」の操作を返したときは、使えなかった指示として知らせるので、それでも正しい
    expect(scoreWith(c, { ops: [{ op: 'set_style', style: 'acs' }, { op: 'replace_reagent', step: 2, reagent: 'TFA', text: 'HCl' }] }).outcome).toBe('correct');
  });

  it('できないことを、何も言わずに何もしなければ黙って間違え、変えずに聞き返せば正しい', () => {
    const c = byId('cannot-font');
    expect(scoreWith(c, { ops: [{ op: 'set_style', style: 'lab' }] }).outcome).toBe('silent-wrong');
    expect(scoreWith(c, { ops: [], questions: ['フォントはどれにしますか？'] }).outcome).toBe('correct');
  });

  it('試薬の書き方を直しても当量は残り、正しい', () => {
    const c = byId('rename-reagent');
    const base = finishBase(c);
    const s = scoreFinish(c, base, { ok: true, checked: { ops: [{ op: 'rename_reagent', schemeId: base.targets[0], step: 0, index: 1, text: 'Et3N' }], rejected: [], warnings: [], cannot: [], questions: [] } });
    expect(s.outcome).toBe('correct');
  });
});

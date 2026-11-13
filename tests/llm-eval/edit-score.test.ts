import { beforeAll, describe, expect, it } from 'vitest';
import { checkEdit, checkEditShape, textEdit } from '../../src/llm/textEdit';
import { cipOf } from '../../src/llm/textToScheme';
import type { LlmProvider } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { EDIT_CASES, editBase, opsFromExpect, scoreEdit, type EditEvalCase } from './edit-score';
import { keyOfSmiles } from './score';

beforeAll(loadRDKit);

const byId = (id: string) => EDIT_CASES.find((c) => c.id === id)!;
/** 決まった答えで採点する（textEdit の確かめを通す） */
function scoreWith(c: EditEvalCase, raw: unknown) {
  const base = editBase(c);
  const shape = checkEditShape(raw);
  if ('error' in shape) throw new Error(shape.error);
  const checked = checkEdit(base.doc, base.schemeId, shape.value, { text: c.text, selected: base.selected });
  return scoreEdit(c, base, { ok: true, checked });
}

describe('編集の評価の件', () => {
  it('14 件あり、id は重ならず、正解の SMILES は読めて L 体（S）になっている', () => {
    expect(EDIT_CASES).toHaveLength(14);
    expect(new Set(EDIT_CASES.map((c) => c.id)).size).toBe(14);
    for (const c of EDIT_CASES) {
      if (c.expect.kind !== 'edit') continue;
      for (const w of Object.values(c.expect.compounds ?? {})) {
        if (!w.smiles) continue;
        expect(keyOfSmiles(w.smiles), `${c.id}: ${w.smiles}`).not.toBeNull();
        expect(cipOf(w.smiles), `${c.id}: ${w.smiles}`).toEqual({ R: 0, S: 1 });
      }
    }
  });

  it('直す前の文書は、どの件も同じ 2 段のスキームで、ref が化合物に結び付く', () => {
    const b = editBase(EDIT_CASES[0]);
    expect(b.doc.schemes![b.schemeId].steps).toHaveLength(2);
    expect(Object.keys(b.ids)).toEqual(['A', 'B', 'C', 'D']);
    expect(b.doc.compounds![b.ids.C].number).toBe('5');
    expect(editBase(byId('structure-selected')).selected).toEqual([b.ids.A]);
  });
});

describe('編集の採点', () => {
  it('正解をそのまま答えにすれば、どの件も正しい', () => {
    const got = EDIT_CASES.map((c) => {
      const s = scoreWith(c, opsFromExpect(c, editBase(c)));
      return [c.id, s.outcome, s.outcome === 'correct' ? [] : s.notes];
    });
    expect(got).toEqual(EDIT_CASES.map((c) => [c.id, 'correct', []]));
  });

  it('頼んでいない所を変えたら、知らせが無ければ黙って間違えた', () => {
    const c = byId('replace-reagent');
    const s = scoreWith(c, {
      ops: [
        { op: 'replace_reagent', step: 2, reagent: 'TFA', text: 'HCl' },
        { op: 'set_condition', step: 1, field: 'temp', value: '0 °C' },
      ],
    });
    expect(s.outcome).toBe('silent-wrong');
    expect(s.notes).toContain('1 段目の temp が変わった: 0 °C');
  });

  it('当量を落としたら間違い。whole_scheme を頼まれていないのに true にしても間違い', () => {
    expect(scoreWith(byId('replace-keep-equiv'), { ops: [{ op: 'replace_reagent', step: 1, reagent: 'DIPEA', text: 'Et3N' }] }).notes).toContain('1 段目の Et3N の当量: なし（正解 3）');
    const named = byId('structure-named');
    const s = scoreWith(named, { ...opsFromExpect(named, editBase(named)), whole_scheme: true });
    expect(s.outcome).not.toBe('correct');
    expect(s.notes).toContain('whole_scheme: true（正解 false）');
  });

  it('指していない化合物まで書き換えようとしても、確かめが外して知らせれば止まった扱い', () => {
    const c = byId('ask-structure-scope');
    const b = editBase(c);
    const s = scoreWith(c, { ops: [{ op: 'replace_structure', compound: b.ids.C, smiles: 'O=C(OCc1ccccc1)N[C@@H](C)C(=O)NCC(=O)OC', from_group: 'Boc', to_group: 'Cbz' }] });
    expect(s.outcome).toBe('flagged');
    expect(s.notes[0]).toMatch(/^使えなかった: replace_structure: 5 は指示でも選択でも指していない/);
  });

  it('聞き返す件で、黙って直したら黙って間違えた。聞き返せば正しい', () => {
    const c = byId('ask-missing-step');
    expect(scoreWith(c, { ops: [{ op: 'set_condition', step: 2, field: 'temp', value: '80 °C' }] }).outcome).toBe('silent-wrong');
    expect(scoreWith(c, { ops: [], questions: ['このスキームは 2 段です。どの段ですか？'] }).outcome).toBe('correct');
    // 無い段を指した操作は確かめが外し、使えなかった指示として見せる
    expect(scoreWith(c, { ops: [{ op: 'set_condition', step: 3, field: 'temp', value: '80 °C' }] }).outcome).toBe('flagged');
  });

  it('呼び出しの失敗は error', async () => {
    const c = EDIT_CASES[0];
    const b = editBase(c);
    const llm: LlmProvider = { id: 'gemini', generateJson: async () => ({ ok: false, error: { kind: 'timeout', message: 't' } }), listModels: async () => ({ ok: true, value: [] }) };
    const r = await textEdit(llm, { doc: b.doc, schemeId: b.schemeId, text: c.text });
    expect(scoreEdit(c, b, r).outcome).toBe('error');
  });
});

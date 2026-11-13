import { beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyDoc, type Doc } from '../src/chem/model';
import { applyEdit, checkEdit, checkEditShape, EDIT_SCHEMA, EDIT_SYSTEM_PROMPT, editChanges, editPrompt, textEdit } from '../src/llm/textEdit';
import { checkPlan, confirmDraft, draftScheme, type Plan } from '../src/llm/textToScheme';
import type { LlmProvider } from '../src/llm/types';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

// 縮合 → Boc の除去 の 2 段
const plan: Plan = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC' },
    { ref: 'C', name: '5', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC' },
    { ref: 'D', name: '7', smiles: 'N[C@@H](C)C(=O)NCC(=O)OC' },
  ],
  steps: [
    { from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 },
    { from: ['C'], to: ['D'], reagents: [{ text: 'TFA' }], solvent: 'CH2Cl2', temp: 'rt', time: '1 h' },
  ],
};

function schemeDoc(): { doc: Doc; sid: string; ids: Record<string, string> } {
  const r = draftScheme(emptyDoc(), checkPlan(plan, []), { text: 'x', model: 'm', origin: { x: 0, y: 0 } });
  const doc = confirmDraft(r.doc, r.schemeId);
  const s = doc.schemes![r.schemeId];
  const [a, b] = s.steps[0].from;
  const ids = { A: a, B: b, C: s.steps[0].to[0], D: s.steps[1].to[0] };
  return { doc, sid: r.schemeId, ids };
}

describe('送る内容', () => {
  it('化合物・段・書式の一覧と指示を送る', () => {
    const { doc, sid, ids } = schemeDoc();
    const p = editPrompt(doc, sid, '2 段目の TFA を HCl に', { answers: [{ question: '濃度は？', answer: '4 M' }], selected: [ids.D, 'c999'] });
    expect(p).toContain(`key=${ids.C}; number=5;`);
    expect(p).toContain('step 2: from=' + ids.C);
    expect(p).toContain('reagents=HATU (1.2 equiv) | DIPEA (3 equiv)');
    expect(p).toContain('id=acs; name=ACS（条件を矢印の上下） (current)');
    expect(p).toContain('INSTRUCTION:\n2 段目の TFA を HCl に');
    expect(p).toContain('A: 4 M');
    expect(p).toContain(`SELECTED: ${ids.D}
`);
  });

  it('応答の形と指示がある', () => {
    expect(EDIT_SCHEMA.required).toEqual(['ops']);
    expect(EDIT_SYSTEM_PROMPT).toContain('Operations (use only these)');
    expect(EDIT_SYSTEM_PROMPT).toContain('replace_structure');
  });
});

describe('形と指す先の確かめ', () => {
  it('形が崩れていれば理由を返す', () => {
    expect(checkEditShape('x')).toHaveProperty('error');
    expect(checkEditShape({ ops: [] })).toHaveProperty('error');
    expect(checkEditShape({ ops: [], questions: ['どの段ですか？'] })).toEqual({ value: { ops: [], questions: ['どの段ですか？'], wholeScheme: false } });
    expect(checkEditShape({ ops: [{ op: 'renumber' }], whole_scheme: true })).toMatchObject({ value: { wholeScheme: true } });
    // 構造の書き換えで SMILES を書き忘れた（2026-10-25、本物の Gemini で）。直させる
    expect(checkEditShape({ ops: [{ op: 'replace_structure', compound: 'c4', from_group: 'Boc', to_group: 'Cbz' }] })).toEqual({ error: 'replace_structure needs smiles (the whole new structure)' });
  });

  it('収率の「92%」は数にする（書式で「92%%」にならないように）', () => {
    const { doc, sid } = schemeDoc();
    const ops = checkEdit(doc, sid, { ops: [{ op: 'set_condition', step: 1, field: 'yield', value: '92%' }, { op: 'set_condition', step: 2, field: 'yield', value: 'quant.' }], questions: [] }).ops;
    const s = applyEdit(doc, sid, ops).schemes![sid];
    expect([s.steps[0].yield, s.steps[1].yield]).toEqual([92, 'quant.']);
  });

  it('知らない操作・無い段・無い試薬・無い化合物・無い書式は、理由を付けて外す', () => {
    const { doc, sid, ids } = schemeDoc();
    const r = checkEdit(doc, sid, {
      ops: [
        { op: 'replace_reagent', step: 2, reagent: 'tfa', text: 'HCl (4 M in dioxane)' },
        { op: 'replace_reagent', step: 1, reagent: 'DIPEA (3 equiv)', text: 'Et3N', equiv: 3 },
        { op: 'replace_reagent', step: 3, reagent: 'TFA', text: 'HCl' },
        { op: 'remove_reagent', step: 1, reagent: 'EDC' },
        { op: 'set_compound', compound: 'c999', number: '1' },
        { op: 'set_style', style: 'nature' },
        { op: 'replace_group', compound: ids.C, from: 'Boc', to: 'Cbz' },
        { op: 'set_condition', step: 1, field: 'yield', value: '92' },
        { op: 'set_condition', step: 1, field: 'notebook', value: 'x' },
      ],
      questions: [],
    });
    expect(r.ops).toEqual([
      { op: 'replace_reagent', step: 1, index: 0, to: { text: 'HCl (4 M in dioxane)' } },
      { op: 'replace_reagent', step: 0, index: 1, to: { text: 'Et3N', equiv: 3 } },
      { op: 'set_condition', step: 0, field: 'yield', value: '92' },
    ]);
    expect(r.rejected).toEqual([
      'replace_reagent: 3 段目がありません（このスキームは 2 段）',
      'remove_reagent: 1 段目に試薬「EDC」がありません',
      'set_compound: 化合物「c999」がこのスキームにありません',
      'set_style: 書式「nature」がありません',
      '知らない操作「replace_group」は使えません',
      'set_condition: 項目「notebook」は直せません',
    ]);
  });
});

describe('当てると差の一覧', () => {
  it('同じ段の試薬を続けて消す・替えるとき、位置は前の操作の後の並びで決める', () => {
    const { doc, sid } = schemeDoc();
    const checked = checkEdit(doc, sid, {
      ops: [
        { op: 'remove_reagent', step: 1, reagent: 'HATU' },
        { op: 'replace_reagent', step: 1, reagent: 'DIPEA', text: 'Et3N', equiv: 3 },
        { op: 'add_reagent', step: 1, text: 'EDC' },
        { op: 'remove_reagent', step: 1, reagent: 'EDC' },
      ],
      questions: [],
    });
    expect(checked.rejected).toEqual([]);
    expect(applyEdit(doc, sid, checked.ops).schemes![sid].steps[0].reagents).toEqual([{ text: 'Et3N', equiv: 3 }]);
  });

  it('試薬・条件・番号・呼び名・書式を M2 の関数で直し、前と後の差を出す。元の文書は変えない', () => {
    const { doc, sid, ids } = schemeDoc();
    const checked = checkEdit(doc, sid, {
      ops: [
        { op: 'replace_reagent', step: 2, reagent: 'TFA', text: 'HCl (4 M in dioxane)' },
        { op: 'add_reagent', step: 1, text: 'HOAt', equiv: 0.1 },
        { op: 'set_condition', step: 2, field: 'solvent', value: '' },
        { op: 'set_condition', step: 2, field: 'yield', value: '90' },
        { op: 'renumber', start: 1 },
        { op: 'set_compound', compound: ids.D, nickname: 'ジペプチド' },
        { op: 'set_style', style: 'footnote' },
      ],
      questions: [],
    });
    expect(checked.rejected).toEqual([]);
    const after = applyEdit(doc, sid, checked.ops);
    const s = after.schemes![sid];
    expect(s.steps[1]).toMatchObject({ reagents: [{ text: 'HCl (4 M in dioxane)' }], yield: 90 });
    expect(s.steps[1].solvent).toBeUndefined();
    expect(s.steps[0].reagents.at(-1)).toEqual({ text: 'HOAt', equiv: 0.1 });
    expect(s.styleId).toBe('footnote');
    expect([ids.A, ids.B, ids.C, ids.D].map((id) => after.compounds![id].number)).toEqual(['1', '2', '3', '4']);
    // 図も描き直している
    expect(Object.values(after.texts).some((t) => t.text.includes('HCl'))).toBe(true);
    // 元の文書はそのまま
    expect(doc.schemes![sid].steps[1].reagents).toEqual([{ text: 'TFA' }]);

    expect(editChanges(doc, after, sid)).toEqual([
      '書式: ACS（条件を矢印の上下） → 脚注（Reagents and conditions）',
      '1 段目の試薬: HATU (1.2 equiv), DIPEA (3 equiv) → HATU (1.2 equiv), DIPEA (3 equiv), HOAt (0.1 equiv)',
      '2 段目の試薬: TFA → HCl (4 M in dioxane)',
      '2 段目の溶媒: CH2Cl2 → （なし）',
      '2 段目の収率: （なし） → 90',
      '7 の呼び名: （なし） → ジペプチド',
      '化合物番号: （なし） → 1, （なし） → 2, 5 → 3, 7 → 4',
    ]);
    expect(editChanges(doc, doc, sid)).toEqual([]);
  });
});

describe('LLM に送って確かめる', () => {
  const fake = (...answers: unknown[]): LlmProvider & { users: string[] } => {
    const users: string[] = [];
    return {
      id: 'gemini',
      users,
      generateJson: vi.fn(async ({ user }: { user: string }) => {
        users.push(user);
        return { ok: true as const, value: answers.shift() as never, usage: { input: 10, output: 5 } };
      }),
      listModels: vi.fn(),
    };
  };

  it('形が崩れていたら1回だけ直させ、指す先を確かめた操作を返す', async () => {
    const { doc, sid } = schemeDoc();
    const llm = fake({ nope: 1 }, { ops: [{ op: 'renumber' }], questions: [] });
    const r = await textEdit(llm, { doc, schemeId: sid, text: '番号を振り直して' });
    expect(r).toMatchObject({ ok: true, checked: { ops: [{ op: 'renumber', start: 1, prefix: '' }], rejected: [] }, usage: { input: 20, output: 10 } });
    expect(llm.users[1]).toContain('Your previous answer could not be used (ops must be an array)');
  });

  it('2回とも崩れていれば invalid-output の失敗', async () => {
    const { doc, sid } = schemeDoc();
    expect(await textEdit(fake('a', 'b'), { doc, schemeId: sid, text: 'x' })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
  });
});

describe('構造の書き換え（段2）', () => {
  const CBZ = 'O=C(OCc1ccccc1)N[C@@H](C)C(=O)NCC(=O)OC';
  const op = (smiles: string, extra: Record<string, unknown> = {}) => ({ op: 'replace_structure', smiles, from_group: 'Boc', to_group: 'Cbz', ...extra });

  it('指示で番号を書いた化合物は、分子式の差と立体が合えばそのまま書き換え、差の一覧に分子式を出す', () => {
    const { doc, sid, ids } = schemeDoc();
    const r = checkEdit(doc, sid, { ops: [op(CBZ, { compound: ids.C })], questions: [] }, { text: '5 の Boc を Cbz に' });
    expect(r.rejected).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ops).toHaveLength(1);
    const after = applyEdit(doc, sid, r.ops);
    expect(after.compounds![ids.C].number).toBe('5');
    expect(editChanges(doc, after, sid)).toEqual([expect.stringMatching(/^5 の構造: C11H20N2O5 → C14H18N2O5（.+）$/)]);
    // 同じ化合物を使う図も描き直している
    expect(after.atoms).not.toEqual(doc.atoms);
  });

  it('指示でも選択でも指していない化合物は書き換えない。選んでいるか、スキーム全体と頼まれたときは書き換える', () => {
    const { doc, sid, ids } = schemeDoc();
    const raw = { ops: [op(CBZ, { compound: ids.C })], questions: [] };
    // 「15」の中の「5」は指したことにしない
    expect(checkEdit(doc, sid, raw, { text: '15 の Boc を Cbz に' }).rejected).toEqual([
      'replace_structure: 5 は指示でも選択でも指していないので、構造を書き換えません（スキーム全体なら、そう書いてください）',
    ]);
    expect(checkEdit(doc, sid, raw, { text: 'Boc を Cbz に', selected: [ids.C] }).ops).toHaveLength(1);
    const whole = checkEdit(doc, sid, { ...raw, wholeScheme: true }, { text: 'スキーム全体で Boc を Cbz に' });
    expect(whole).toMatchObject({ wholeScheme: true, rejected: [] });
    expect(whole.ops).toHaveLength(1);
  });

  it('分子式の差が合わない・立体が消えた・表に無い基・入れ替えが分からないときは要確認（当てはする）。読めない SMILES は外す', () => {
    const { doc, sid, ids } = schemeDoc();
    const check = (o: Record<string, unknown>) => checkEdit(doc, sid, { ops: [{ compound: ids.C, ...o }], questions: [] }, { text: '5' });
    const fmoc = check(op('O=C(OCC1c2ccccc2-c2ccccc12)N[C@@H](C)C(=O)NCC(=O)OC'));
    expect(fmoc.ops).toHaveLength(1);
    expect(fmoc.warnings).toEqual([expect.stringMatching(/^5: 分子式の差（.+）が Boc → Cbz（\+C3 −H2）と合いません。構造を確かめてください$/)]);
    expect(check(op('O=C(OCc1ccccc1)NC(C)C(=O)NCC(=O)OC')).warnings).toEqual(['5: 立体の決まった不斉中心の数が 1 → 0 に変わりました。立体を確かめてください']);
    expect(check(op(CBZ, { to_group: 'Teoc' })).warnings[0]).toMatch(/Boc → Teoc は略号の表に無い/);
    expect(check({ op: 'replace_structure', smiles: CBZ }).warnings[0]).toMatch(/どの基を入れ替えたかが分からない/);
    expect(check(op('C1CC'))).toMatchObject({ ops: [], rejected: ['replace_structure: 5 の新しい構造（SMILES）が読めません'] });
  });

  it('指示には、構造の書き換えの範囲の決まりがある', () => {
    expect(EDIT_SYSTEM_PROMPT).toContain('change only the compounds the instruction names');
    expect(EDIT_SYSTEM_PROMPT).toContain('whole_scheme');
    expect(EDIT_SCHEMA.properties).toHaveProperty('whole_scheme');
  });
});

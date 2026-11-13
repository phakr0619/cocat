import { beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { canonical, documentSmiles } from '../src/io/smiles';
import {
  checkPlan, checkShape, cipOf, fixStereo, statedCip, confirmDraft, discardDraft, draftScheme, existingCompounds, formulaElements, PLAN_SCHEMA, SYSTEM_PROMPT, textToScheme, userPrompt, type Plan,
} from '../src/llm/textToScheme';
import type { LlmProvider } from '../src/llm/types';
import { startScheme } from '../src/scheme/ops';
import { addSmiles } from '../src/io/smiles';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const amide: Plan = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 }],
  questions: [],
};

describe('形の確かめ', () => {
  it('知らない ref・空の段・不正な値を落とし、使える形にする', () => {
    const r = checkShape({
      compounds: [{ ref: 'A', smiles: 'C' }, { ref: 'A', smiles: 'CC' }, { name: 'no ref' }, { ref: 'B', smiles: '', confidence: 'maybe' }],
      steps: [{ from: ['A', 'Z'], to: ['B'], reagents: [{ text: 'TFA', equiv: -1 }, { equiv: 2 }], yield: 140 }, { from: [], to: [] }, 'x'],
      questions: ['?', 3],
    });
    expect(r).toEqual({
      plan: {
        compounds: [{ ref: 'A', name: undefined, smiles: 'C', existing: null, confidence: undefined }, { ref: 'B', name: undefined, smiles: null, existing: null, confidence: undefined }],
        steps: [{ from: ['A'], to: ['B'], reagents: [{ text: 'TFA', equiv: null, smiles: null }], solvent: null, temp: null, time: null, yield: null }],
        questions: ['?'],
      },
    });
    expect(checkShape({ compounds: [], steps: [] })).toHaveProperty('error');
    // 描ける手順が無くても、聞き返しがあれば使える（文章に手順が無いとき）
    expect(checkShape({ compounds: [], steps: [], questions: ['どの経路ですか？'] })).toEqual({ plan: { compounds: [], steps: [], questions: ['どの経路ですか？'] } });
    expect(checkShape('x')).toHaveProperty('error');
  });

  it('応答の形（JSON Schema）と指示がある', () => {
    expect(PLAN_SCHEMA.required).toEqual(['compounds', 'steps']);
    expect(SYSTEM_PROMPT).toContain('Never invent a structure');
    expect(SYSTEM_PROMPT).toContain('do not guess a route from memory');
    // Boc-Ala-OH の立体が抜けた（2026-10-24、本物の Gemini で）。三文字のアミノ酸は断りが無ければ L 体
    expect(SYSTEM_PROMPT).toMatch(/Three-letter amino acid codes .* mean the L form unless D-, DL- or rac-/);
    // 3 段の 2 段目で、ボロン酸を基質でなく試薬に書いた（2026-10-24、本物の Gemini で）
    expect(SYSTEM_PROMPT).toMatch(/"from" holds every compound whose atoms end up in the product, including coupling partners/);
  });
});

describe('構造と元素のつじつま', () => {
  it('読める構造は描け、問題が無ければ要確認は無い。数字だけの名前は化合物番号、それ以外は呼び名にする', () => {
    const c = checkPlan(amide, []);
    expect(c.issues).toEqual([]);
    expect(c.compounds.A).toMatchObject({ known: true, nickname: 'Boc-Ala-OH' });
    expect(c.compounds.C).toMatchObject({ known: true, number: '3' });
  });

  it('読めない SMILES・構造の無い化合物は、名前の代わりの印にして要確認にする', () => {
    const c = checkPlan(
      { ...amide, compounds: [{ ...amide.compounds[0], smiles: 'C1CC' }, { ref: 'B', name: 'ABC-123' }, amide.compounds[2]] },
      [],
    );
    expect(c.issues.map((i) => [i.kind, i.ref])).toEqual([
      ['structure', 'A'],
      ['missing', 'B'],
    ]);
    expect(Object.values(c.compounds.B.structure.atoms)[0]).toMatchObject({ element: '*', abbr: 'ABC-123' });
  });

  it('生成物に、基質と試薬のどこにも無い元素があれば知らせる（化学式の試薬は中身を数える）', () => {
    const plan = (reagent: string): Plan => ({
      compounds: [
        { ref: 'A', smiles: 'Oc1ccccc1' },
        { ref: 'B', name: 'aryl fluoride', smiles: 'Fc1ccccc1' },
      ],
      steps: [{ from: ['A'], to: ['B'], reagents: [{ text: reagent }] }],
    });
    expect(checkPlan(plan('Selectfluor'), []).issues.map((i) => i.kind)).toEqual(['elements']);
    expect(checkPlan(plan('Selectfluor'), []).issues[0].message).toContain('F が基質と、中身の分かる試薬にありません');
    expect(checkPlan(plan('KF'), []).issues).toEqual([]);
    expect(formulaElements('NaBH4')).toEqual(new Set(['Na', 'B']));
    expect(formulaElements('HATU')).toBeNull();
    expect(formulaElements('Pd(PPh3)4')).toEqual(new Set(['Pd', 'P', 'C']));
    expect(formulaElements('NaOAc')).toEqual(new Set(['Na', 'O', 'C']));
  });

  it('生成物か基質の無い段は知らせ、自信の無い構造も知らせる', () => {
    const c = checkPlan({ compounds: [{ ref: 'A', smiles: 'CCO', confidence: 'low' }], steps: [{ from: ['A'], to: [] }] }, []);
    expect(c.issues.map((i) => i.kind)).toEqual(['confidence', 'step']);
  });
});

describe('名前の (R)/(S) と構造の立体', () => {
  it('名前から R と S の数を読む（位置の番号付きも、書いていなければ null）', () => {
    expect(statedCip('(R)-1-フェニルエタノール')).toEqual({ R: 1, S: 0 });
    expect(statedCip('(1R,2S)-2-amino-1-phenylpropan-1-ol')).toEqual({ R: 1, S: 1 });
    expect(statedCip('(2S,3S)-tartaric acid dimethyl ester')).toEqual({ R: 0, S: 2 });
    expect(statedCip('L-フェニルアラニン')).toBeNull();
    expect(statedCip('(±)-ibuprofen')).toBeNull();
    expect(statedCip('Pd(PPh3)4')).toBeNull();
  });

  it('構造の CIP を数える（決まっていない中心は数えない）', () => {
    expect(cipOf('C[C@@H](O)c1ccccc1')).toEqual({ R: 1, S: 0 });
    expect(cipOf('C[C@H](O)c1ccccc1')).toEqual({ R: 0, S: 1 });
    expect(cipOf('CC(O)c1ccccc1')).toEqual({ R: 0, S: 0 });
  });

  const mitsunobu = (alcohol: string) =>
    checkPlan(
      {
        compounds: [
          { ref: 'A', name: '(R)-1-フェニルエタノール', smiles: alcohol },
          { ref: 'B', name: '4-ニトロ安息香酸', smiles: 'OC(=O)c1ccc([N+](=O)[O-])cc1' },
          { ref: 'C', smiles: 'C[C@H](OC(=O)c1ccc([N+](=O)[O-])cc1)c1ccccc1' },
        ],
        steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'PPh3' }, { text: 'DIAD' }] }],
      },
      [],
    ).issues;

  it('名前は (R) なのに構造が (S)・立体なしなら要確認にする（光延の基質を逆の鏡像で描いた）', () => {
    expect(mitsunobu('C[C@@H](O)c1ccccc1')).toEqual([]);
    const wrong = mitsunobu('C[C@H](O)c1ccccc1');
    expect(wrong).toMatchObject([{ kind: 'stereo', ref: 'A' }]);
    expect(wrong[0].message).toContain('名前の立体（R）と、構造の立体（S）が合いません');
    expect(mitsunobu('CC(O)c1ccccc1')).toMatchObject([{ kind: 'stereo', ref: 'A' }]);
  });

  it('名前に書いていない不斉中心は問わない', () => {
    const c = checkPlan({ compounds: [{ ref: 'A', name: '(S)-isomer', smiles: 'C[C@H](O)[C@@H](C)c1ccccc1' }], steps: [] }, []);
    expect(c.issues.filter((i) => i.kind === 'stereo')).toEqual([]);
  });
});

describe('画像から読んだ立体', () => {
  it('画像からなら、立体の決まった不斉中心のある化合物はいつも要確認。立体の無い化合物と、文章からのときは出さない', () => {
    const fromImage = checkPlan(amide, [], { fromImage: true });
    expect(fromImage.issues).toEqual([
      { kind: 'stereo', ref: 'A', message: expect.stringContaining('画像から読んだ立体（S）') },
      { kind: 'stereo', ref: 'C', message: expect.stringContaining('元の画像と見比べて') },
    ]);
    expect(checkPlan(amide, []).issues).toEqual([]);
  });

  it('画像の立体（cip）と SMILES が食い違えば、不斉中心が 1 つなら SMILES を cip に合わせて直す', () => {
    // 生成物 C を R で書いたが、cip は S（L-Ala）
    const plan: Plan = { ...amide, compounds: [amide.compounds[0], amide.compounds[1], { ...amide.compounds[2], smiles: 'CC(C)(C)OC(=O)N[C@H](C)C(=O)NCC(=O)OC', cip: 'S' }] };
    const c = checkPlan(plan, [], { fromImage: true });
    expect(c.issues.find((i) => i.ref === 'C')).toEqual({ kind: 'stereo', ref: 'C', message: expect.stringContaining('SMILES を画像の立体（S）に直しました') });
    const st = c.compounds.C.structure;
    expect(cipOf(documentSmiles({ ...emptyDoc(), atoms: st.atoms, bonds: st.bonds, groups: st.groups }).smiles ?? '')).toEqual({ R: 0, S: 1 });
    // 文章からのときは cip を使わない
    expect(checkPlan(plan, []).issues).toEqual([]);
  });

  it('cip と SMILES が合っていれば、いつもの「画像から読んだ立体」の知らせだけ。2 つ以上の不斉中心は直さずに知らせる', () => {
    expect(fixStereo('C[C@@H](O)c1ccccc1', 'R')).toBeNull();
    expect(fixStereo('C[C@@H](O)c1ccccc1', 'S')).toEqual({ smiles: 'C[C@H](O)c1ccccc1', message: expect.stringContaining('直しました') });
    expect(fixStereo('C[C@@H](O)[C@@H](C)O', 'S,S')).toEqual({ smiles: 'C[C@@H](O)[C@@H](C)O', message: expect.stringContaining('食い違います') });
    expect(checkShape({ compounds: [{ ref: 'A', smiles: 'C', cip: 's, r' }, { ref: 'B', smiles: 'C', cip: 'unknown' }], steps: [{ from: ['A'], to: ['B'] }] })).toMatchObject({
      plan: { compounds: [{ ref: 'A', cip: 'S, R' }, { ref: 'B' }] },
    });
  });

  it('名前の立体と合わないときは、その知らせだけを出す（二重には出さない）', () => {
    const plan: Plan = { ...amide, compounds: [{ ...amide.compounds[0], name: '(R)-Boc-Ala-OH' }, amide.compounds[1], amide.compounds[2]] };
    const issues = checkPlan(plan, [], { fromImage: true }).issues.filter((i) => i.ref === 'A');
    expect(issues).toEqual([{ kind: 'stereo', ref: 'A', message: expect.stringContaining('名前の立体') }]);
  });
});

describe('今のスキーム・ライブラリとのつながり', () => {
  /** Boc-Ala-OH を化合物 12 として持つスキーム */
  function docWithScheme() {
    const r = addSmiles(emptyDoc(), 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', { x: 100, y: 100 });
    const s = startScheme(r.doc, r.atomIds);
    const cid = s.doc.schemes![s.schemeId].steps[0].from[0];
    s.doc.compounds![cid].number = '12';
    return { doc: s.doc, cid };
  }

  it('今のスキームの化合物を一覧にして送り、同じ構造は同じ化合物として使う（番号を引き継ぐ）', () => {
    const { doc, cid } = docWithScheme();
    const ex = existingCompounds(doc, [
      { id: 'L1', structure: { atoms: {}, bonds: {}, groups: {} }, smiles: 'NCC(=O)OC', inchikey: 'X', formula: '', mw: 0, nickname: 'グリシン', createdAt: '', updatedAt: '' },
      { id: 'L2', structure: { atoms: {}, bonds: {}, groups: {} }, smiles: 'C', inchikey: 'Y', formula: '', mw: 0, createdAt: '', updatedAt: '' },
    ]);
    expect(ex.map((e) => [e.key, e.number, e.nickname])).toEqual([
      [cid, '12', undefined],
      ['lib:L1', undefined, 'グリシン'],
    ]);
    const prompt = userPrompt('12 を HATU で縮合', ex, [{ question: '溶媒は？', answer: 'DMF' }]);
    expect(prompt).toContain(`key=${cid}; number=12`);
    expect(prompt).toContain('A: DMF');

    // existing で指したもの・同じ構造のもの、どちらも元の化合物を使う
    const byExisting = checkPlan({ ...amide, compounds: [{ ref: 'A', existing: cid }, ...amide.compounds.slice(1)] }, ex);
    expect(byExisting.compounds.A.reuse).toBe(cid);
    const bySame = checkPlan(amide, ex);
    expect(bySame.compounds.A).toMatchObject({ reuse: cid, number: '12' });

    // 下書きにすると、元の化合物を共有する。やめても元の化合物は残る
    const d = draftScheme(doc, bySame, { text: 't', model: 'm', origin: { x: 0, y: 300 } });
    expect(d.doc.schemes![d.schemeId].steps[0].from[0]).toBe(cid);
    const back = discardDraft(d.doc, d.schemeId);
    expect(back.compounds![cid]).toBeDefined();
    expect(Object.keys(back.schemes!)).toEqual(Object.keys(doc.schemes!));
    expect(Object.keys(back.compounds!)).toEqual(Object.keys(doc.compounds!));
  });
});

describe('下書き', () => {
  it('スキームにして描き、確定すると下書きの印が外れる。反応 SMILES は文章の通り', () => {
    const c = checkPlan(amide, []);
    const r = draftScheme(emptyDoc(), c, { text: 'Boc-Ala-OH と H-Gly-OMe を HATU で', model: 'gemini-x', origin: { x: 40, y: 40 } });
    const s = r.doc.schemes![r.schemeId];
    expect(s.draft).toMatchObject({ text: 'Boc-Ala-OH と H-Gly-OMe を HATU で', model: 'gemini-x', issues: [] });
    expect(s.steps[0]).toMatchObject({ reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 });
    const smiles = documentSmiles(r.doc).smiles ?? '';
    expect(smiles.split('>>').map((x) => x.split('.').map((y) => canonical(y)).sort())).toEqual([
      [canonical('CC(C)(C)OC(=O)N[C@@H](C)C(=O)O'), canonical('NCC(=O)OC')].sort(),
      [canonical('CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC')],
    ]);
    expect(Object.values(r.doc.texts).map((t) => t.text)).toEqual(expect.arrayContaining(['3', 'DMF, rt, 2 h']));
    const ok = confirmDraft(r.doc, r.schemeId);
    expect(ok.schemes![r.schemeId].draft).toBeUndefined();
    expect(discardDraft(r.doc, r.schemeId)).toMatchObject({ atoms: {}, arrows: {}, texts: {}, compounds: {}, schemes: {} });
  });

  it('画像から作った下書きには、画像のファイル名だけを残す', () => {
    const r = draftScheme(emptyDoc(), checkPlan(amide, []), { text: '', model: 'm', origin: { x: 0, y: 0 }, image: 'scheme.png' });
    expect(r.doc.schemes![r.schemeId].draft).toMatchObject({ text: '', image: 'scheme.png' });
    expect(JSON.stringify(r.doc)).not.toContain('base64');
  });

  it('要確認は、スキームの化合物 id で指す', () => {
    const c = checkPlan({ ...amide, compounds: [amide.compounds[0], { ref: 'B', name: 'ABC-123' }, amide.compounds[2]] }, []);
    const r = draftScheme(emptyDoc(), c, { text: '', model: '', origin: { x: 0, y: 0 } });
    const s = r.doc.schemes![r.schemeId];
    expect(s.draft!.issues).toEqual([{ kind: 'missing', message: expect.stringContaining('ABC-123'), compoundId: s.steps[0].from[1] }]);
  });
});

describe('まとめて呼ぶ', () => {
  const fake = (...answers: unknown[]): LlmProvider & { calls: string[] } => {
    const calls: string[] = [];
    return {
      id: 'gemini',
      calls,
      generateJson: vi.fn(async ({ user }: { user: string }) => {
        calls.push(user);
        const a = answers.shift();
        return a instanceof Error ? { ok: false as const, error: { kind: 'auth' as const, message: a.message } } : { ok: true as const, value: a as never };
      }),
      listModels: vi.fn(),
    };
  };

  it('形が崩れていたら、理由を付けて1回だけ直させる', async () => {
    const llm = fake({ compounds: [], steps: [] }, amide);
    const r = await textToScheme(llm, { text: 'x', existing: [] });
    expect(r.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]).toContain('Your previous answer could not be used (no usable steps');
  });

  it('画像は、直させる呼び出しにも同じものを送る。本文には画像の説明を入れ、文章が無ければ (none)', async () => {
    const images: unknown[] = [];
    const answers = [{ compounds: [], steps: [] }, amide];
    const llm: LlmProvider = {
      id: 'gemini',
      generateJson: vi.fn(async (req: { user: string; images?: unknown }) => {
        images.push(req.images);
        return { ok: true as const, value: answers.shift() as never };
      }),
      listModels: vi.fn(),
    };
    const img = [{ mimeType: 'image/png', data: 'AAAA' }];
    expect(await textToScheme(llm, { text: '', existing: [], image: { summary: 'IMAGE: s.png', images: img } })).toMatchObject({ ok: true });
    expect(images).toEqual([img, img]);
    const prompt = userPrompt('', [], undefined, 'IMAGE: s.png');
    expect(prompt).toContain('IMAGE: s.png\n\nTEXT:\n(none)');
    expect(SYSTEM_PROMPT).toContain('When an IMAGE is attached');
  });

  it('2回とも崩れていれば失敗。キーの誤りなどはそのまま返す', async () => {
    expect(await textToScheme(fake('a', 'b'), { text: 'x', existing: [] })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    const llm = fake(new Error('bad key'));
    expect(await textToScheme(llm, { text: 'x', existing: [] })).toMatchObject({ ok: false, error: { kind: 'auth' } });
    expect(llm.calls).toHaveLength(1);
  });

  it('使ったトークンは、直させた呼び出しも足す（崩れた答えも請求されるので）', async () => {
    const answers = [
      { ok: true as const, value: { compounds: [], steps: [] }, usage: { input: 100, output: 30, thinking: 20 } },
      { ok: true as const, value: amide, usage: { input: 120, output: 50, thinking: 25 } },
    ];
    const llm: LlmProvider = { id: 'gemini', generateJson: vi.fn(async () => answers.shift() as never), listModels: vi.fn() };
    expect(await textToScheme(llm, { text: 'x', existing: [] })).toMatchObject({ ok: true, usage: { input: 220, output: 80, thinking: 45 } });

    const bad = [
      { ok: false as const, error: { kind: 'invalid-output' as const, message: 'JSON でない' }, usage: { input: 100, output: 10, thinking: 5 } },
      { ok: false as const, error: { kind: 'invalid-output' as const, message: 'JSON でない' }, usage: { input: 100, output: 10, thinking: 5 } },
    ];
    const llm2: LlmProvider = { id: 'gemini', generateJson: vi.fn(async () => bad.shift() as never), listModels: vi.fn() };
    expect(await textToScheme(llm2, { text: 'x', existing: [] })).toMatchObject({ ok: false, usage: { input: 200, output: 20, thinking: 10 } });
  });
});

// ② 文字 → 事実の答えの確かめと、図との突き合わせ
import { beforeAll, describe, expect, it } from 'vitest';
import { reconcile, sameCompound, sameValue, tempOf, timeOf, yieldOf, type NameToSmiles } from '../src/llm/reconcile';
import { figureLabel } from '../src/llm/pdfText';
import { checkFacts, factsPrompt, looseText, quoteFound, textFacts, type Facts } from '../src/llm/textFacts';
import { applyNameStructure, checkPlan, draftScheme, type Plan } from '../src/llm/textToScheme';
import { figureLabels, guessSiIndex, partKey, withoutParts } from '../src/llm/paperFacts';
import { emptyDoc } from '../src/chem/model';
import { canonical, documentSmiles } from '../src/io/smiles';
import { loadRDKit } from './rdkit';
import { replayLlm } from './llm-eval/replay';
import { hasOpsinJar, javaOpsin } from './javaOpsin';

beforeAll(loadRDKit);

const SENT = `[SI p.4 — compound (R)-4]
(R)-Hex-5-en-2-ol ((R)-4) (CAS 17397-29-4) [1,2] To a 500 mL Schlenk flask was added CuI (0.98 g, 5.17 mmol) at room temperature. The flask was cooled to −30 °C, and then allylmagnesium bromide (3, 77.5 mL) was added. After 6 h at −30 °C the alcohol (R)-4 was obtained (3.6 g, 70% yield).`;

describe('②の答えの確かめ', () => {
  it('抜き書きと名前が送った文字にあるものだけ残し、一覧に無い番号・作った名前は捨てる', () => {
    const raw = {
      compounds: [
        { label: '(R)-4', names: ['(R)-Hex-5-en-2-ol'], page: 'SI p.4', quote: '(R)-Hex-5-en-2-ol ((R)-4) (CAS 17397-29-4)' },
        { label: '(R)-4', names: ['(R)-hexenol made up'], page: 'SI p.4', quote: 'was added CuI (0.98 g, 5.17 mmol)' },
        { label: '9', names: ['Something'], page: 'SI p.4', quote: 'was added CuI (0.98 g, 5.17 mmol)' },
        { label: '3', names: [], page: 'SI p.4', quote: 'allylmagnesium bromide (3, 77.5 mL)' },
      ],
      steps: [
        { to: ['(R)-4'], from: ['2', '3'], reagents: [{ text: 'CuI', equiv: 0.1 }], temp: '−30 °C', time: '6 h', yield: 70, page: 'SI p.4', quote: 'After 6 h at −30 °C the alcohol (R)-4 was obtained (3.6 g, 70% yield)' },
        { to: ['(R)-4'], from: ['2'], yield: 99, page: 'SI p.4', quote: 'this sentence is not in the text at all' },
      ],
    };
    const c = checkFacts(raw, SENT, ['2', '3', '(R)-4']);
    expect('value' in c).toBe(true);
    if (!('value' in c)) return;
    expect(c.value.compounds).toEqual([{ label: '(R)-4', names: ['(R)-Hex-5-en-2-ol'], page: 'SI p.4', quote: '(R)-Hex-5-en-2-ol ((R)-4) (CAS 17397-29-4)' }]);
    expect(c.value.steps).toHaveLength(1);
    expect(c.value.steps[0]).toMatchObject({ temp: '−30 °C', time: '6 h', yield: 70, reagents: [{ text: 'CuI', equiv: 0.1 }] });
    // 捨てたのは、作った名前・一覧に無い番号・送った文字に無い抜き書きの 3 つ（名前の無い化合物は、捨てたのではなく書いていないだけ）
    expect(c.dropped).toBe(3);
    expect(checkFacts({ steps: [] }, SENT, [])).toHaveProperty('error');
  });

  it('抜き書きの比べ方は、空白・ダッシュ・上付きの印の違いを問わない。短すぎる抜き書きは出所にしない', () => {
    expect(looseText('a – b^3  C')).toBe('a-b3c');
    expect(quoteFound('cooled to -30 °C, and then', SENT)).toBe(true);
    expect(quoteFound('CuI', SENT)).toBe(false);
  });

  it('送る文には、図の番号と段の一覧と、集めた文字が入る。②を呼ぶと、形を確かめた答えを返す', async () => {
    const prompt = factsPrompt({ compounds: ['2', '3', '(R)-4'], steps: [{ from: ['2', '3'], to: ['(R)-4'] }] }, SENT);
    expect(prompt).toContain('Compounds in the figure: 2, 3, (R)-4');
    expect(prompt).toContain('1. 2 + 3 → (R)-4');
    const r = await textFacts(replayLlm([{ compounds: [], steps: [{ to: ['(R)-4'], from: ['2', '3'], yield: 70, page: 'SI p.4', quote: 'the alcohol (R)-4 was obtained (3.6 g, 70% yield)' }] }]), {
      figure: { compounds: ['2', '3', '(R)-4'], steps: [{ from: ['2', '3'], to: ['(R)-4'] }] },
      text: SENT,
    });
    expect(r.ok && r.facts.steps[0].yield).toBe(70);
  });
});

describe('値のならし', () => {
  it('温度・時間・収率', () => {
    expect(tempOf('rt')).toEqual({ lo: 20, hi: 25 });
    expect(tempOf('−78 °C to rt')).toEqual({ lo: -78, hi: 25 });
    expect(tempOf('reflux')).toBe('reflux');
    expect(timeOf('30 min')).toEqual({ lo: 0.5, hi: 0.5 });
    expect(timeOf('overnight')).toEqual({ lo: 8, hi: 24 });
    expect(yieldOf('quant.')).toBe(100);
    expect(sameValue('temp', 'rt', '23 °C')).toBe(true);
    expect(sameValue('temp', '0 °C', 'rt')).toBe(false);
    expect(sameValue('time', '2 h', '120 min')).toBe(true);
    expect(sameValue('time', '12 h', 'overnight')).toBe(true);
    expect(sameValue('yield', 85, '85%')).toBe(true);
    expect(sameValue('yield', 85, 82)).toBe(false);
    expect(sameValue('temp', 'heat', '80 °C')).toBeNull();
    expect(sameCompound('(R)-4', '4')).toBe(true);
    expect(sameCompound('(R)-4', '(S)-4')).toBe(false);
  });

  it('温度の範囲（頭の数に °C が無くても、ダッシュでも）と、還流は数の温度と比べないこと。図の呼び名から番号を取ること', () => {
    expect(tempOf('0–60 °C')).toEqual({ lo: 0, hi: 60 });
    expect(tempOf('−70 °C to rt')).toEqual({ lo: -70, hi: 25 });
    expect(tempOf('-78 to -40 °C')).toEqual({ lo: -78, hi: -40 });
    expect(sameValue('temp', '65 °C', 'reflux')).toBeNull();
    expect(sameValue('temp', 'reflux', 'reflux')).toBe(true);
    expect(figureLabel('(±)-simonsol C (5)')).toBe('5');
    expect(figureLabel('saframycin A (1)')).toBe('1');
    expect(figureLabel('(R)-4')).toBe('(R)-4');
    expect(figureLabel('PhCHO')).toBe('PhCHO');
  });
});

/** 図から読んだ答え（①）: 2 + 3 → 4、収率 85%、温度なし */
const plan = (smiles4: string | null): Plan => ({
  compounds: [
    { ref: 'A', name: '2', smiles: 'C[C@@H]1CO1' },
    { ref: 'B', name: '3', smiles: 'C=CC[Mg]Br' },
    { ref: 'C', name: '4', ...(smiles4 ? { smiles: smiles4 } : {}) },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [], yield: 85 }],
});

const facts: Facts = {
  compounds: [{ label: '4', names: ['(R)-Hex-5-en-2-ol'], page: 'SI p.4', quote: '(R)-Hex-5-en-2-ol ((R)-4)' }],
  steps: [{ to: ['4'], from: ['2', '3'], reagents: [{ text: 'CuI', equiv: 0.1 }], solvent: 'Et2O', temp: '−30 °C', time: '6 h', yield: 70, page: 'SI p.4', quote: 'x' }],
};

/** 名前 → SMILES の偽物（OPSIN の代わり） */
const fakeOpsin: NameToSmiles = async (n) => (n === '(R)-Hex-5-en-2-ol' ? 'C[C@@H](O)CCC=C' : null);

describe('図との突き合わせ', () => {
  it('図に無い条件は文字から補って出所を残し、食い違う収率は図の値のまま要確認にする。名前の構造が図と同じなら一致と記録する', async () => {
    const checked = checkPlan(plan('C[C@@H](O)CCC=C'), [], { fromImage: true });
    const r = await reconcile(checked, facts, fakeOpsin);
    const st = r.checked.steps[0];
    expect(st).toMatchObject({ reagents: [{ text: 'CuI', equiv: 0.1 }], solvent: 'Et2O', temp: '−30 °C', time: '6 h', yield: 85 });
    expect(r.notes.textSources.map((s) => s.field).sort()).toEqual(['reagents', 'solvent', 'temp', 'time']);
    expect(r.notes.textSources[0].where).toBe('SI p.4');
    const text = r.checked.issues.filter((i) => i.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0].message).toContain('1 段目の収率: 図は 85%、SI p.4 は 70%。図の値のままにしています');
    expect(r.notes.nameChecks).toEqual([{ ref: 'C', name: '(R)-Hex-5-en-2-ol', result: 'match', where: 'SI p.4', smiles: 'C[C@@H](O)CCC=C' }]);
    // 元の答えは変えない
    expect(checked.steps[0].solvent).toBeUndefined();
  });

  it('文字の段の基質が図の段の基質と合わなければ（段の分け方が違えば）、条件を補わずに知らせる', async () => {
    const merged: Facts = { compounds: [], steps: [{ ...facts.steps[0], from: ['9'] }] };
    const r = await reconcile(checkPlan(plan('C[C@@H](O)CCC=C'), [], {}), merged, null);
    expect(r.notes.textSources).toEqual([]);
    expect(r.checked.steps[0].solvent).toBeUndefined();
    const text = r.checked.issues.filter((i) => i.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0].message).toContain('SI p.4 では、この生成物を 9 から作っています。図では 2、3 からです');
    // 基質が書いていなければ、今までどおり補う
    const noFrom = await reconcile(checkPlan(plan('C[C@@H](O)CCC=C'), [], {}), { compounds: [], steps: [{ ...facts.steps[0], from: [] }] }, null);
    expect(noFrom.notes.textSources.length).toBeGreaterThan(0);
  });

  it('名前の構造と図の構造が違えば要確認（立体だけ違うなら立体の要確認）。図の構造が無ければ名前の構造を入れる。読めない名前は記録だけ', async () => {
    const wrong = await reconcile(checkPlan(plan('CC(O)CCCC=C'), [], {}), facts, fakeOpsin);
    expect(wrong.notes.nameChecks[0].result).toBe('mismatch');
    expect(wrong.checked.issues.some((i) => i.kind === 'name' && i.ref === 'C' && i.message.includes('図から読んだ構造が違います'))).toBe(true);

    const stereo = await reconcile(checkPlan(plan('C[C@H](O)CCC=C'), [], {}), facts, fakeOpsin);
    expect(stereo.notes.nameChecks[0].result).toBe('stereo');

    const missing = checkPlan(plan(null), [], {});
    expect(missing.issues.some((i) => i.kind === 'missing' && i.ref === 'C')).toBe(true);
    const filled = await reconcile(missing, facts, fakeOpsin);
    expect(filled.notes.nameChecks[0].result).toBe('filled');
    expect(filled.checked.compounds.C.known).toBe(true);
    expect(filled.checked.issues.some((i) => i.kind === 'missing' && i.ref === 'C')).toBe(false);

    // 画像から読んだ立体の要確認は、名前で確かめたら一つにまとめる（一致なら消え、違えば名前の要確認だけ残る）
    const withStereo = checkPlan(plan('C[C@@H](O)CCC=C'), [], {});
    withStereo.issues.push({ kind: 'stereo', ref: 'C', message: '立体を確かめてください' });
    expect((await reconcile(withStereo, facts, fakeOpsin)).checked.issues.some((i) => i.kind === 'stereo')).toBe(false);
    const withStereo2 = checkPlan(plan('C[C@H](O)CCC=C'), [], {});
    withStereo2.issues.push({ kind: 'stereo', ref: 'C', message: '立体を確かめてください' });
    const merged = (await reconcile(withStereo2, facts, fakeOpsin)).checked.issues.filter((i) => i.ref === 'C');
    expect(merged.map((i) => i.kind)).toEqual(['name']);

    const unread = await reconcile(checkPlan(plan('C[C@@H](O)CCC=C'), [], {}), facts, async () => null);
    expect(unread.notes.nameChecks[0].result).toBe('unread');
    const noOpsin = await reconcile(checkPlan(plan('C[C@@H](O)CCC=C'), [], {}), facts, null);
    expect(noOpsin.notes.nameChecks[0].result).toBe('unread');
  });

  it.skipIf(!hasOpsinJar())('本物の OPSIN（手元の jar）で、実際の論文（BJOC 2025, 21, 38）の SI の系統名を構造にできる', async () => {
    const names = ['(R)-Hex-5-en-2-ol', 'Diethyl (S)-2-(hex-5-en-2-yl)malonate', '(4R,8R)-4,8-Dimethyldecanal', '(5R,9R)-5,9-Dimethylundec-1-ene'];
    const ans = await javaOpsin(names);
    expect(ans?.every((a) => a.status !== 'FAILURE' && a.smiles)).toBe(true);
  });
});

describe('画面の部品', () => {
  it('番号も呼び名も無い図の化合物は、文字で探す番号に入れず、数だけ返す', () => {
    const checked = checkPlan({ compounds: [{ ref: 'A', smiles: 'CCO' }, { ref: 'B', name: '2', smiles: 'CC=O' }], steps: [{ from: ['A'], to: ['B'], reagents: [] }] }, [], {});
    expect(figureLabels(checked)).toEqual({ all: ['2'], products: ['2'], steps: [{ from: [], to: ['2'] }], unlabeled: 1 });
  });

  it('2 本の PDF のどちらが SI か: ファイル名で、無ければページの少ないほう', () => {
    expect(guessSiIndex([{ name: 'jo5c01234_si_001.pdf', numPages: 80 }, { name: 'jo5c01234.pdf', numPages: 9 }])).toBe(0);
    expect(guessSiIndex([{ name: 'paper.pdf', numPages: 9 }, { name: 'Supporting Information.pdf', numPages: 120 }])).toBe(1);
    expect(guessSiIndex([{ name: 'paper.pdf', numPages: 9 }, { name: 'paper-ESI.pdf', numPages: 30 }])).toBe(1);
    // 「simonsol」の「si」のように、語の一部は SI とみなさない
    expect(guessSiIndex([{ name: 'simonsol.pdf', numPages: 9 }, { name: 'extra.pdf', numPages: 40 }])).toBe(0);
    expect(guessSiIndex([{ name: 'a.pdf', numPages: 40 }, { name: 'b.pdf', numPages: 9 }])).toBe(1);
  });

  it('外したまとまりを除き、文字数を数え直す', () => {
    const parts = [
      { source: 'SI', page: 4, why: 'compound' as const, label: '4', text: 'abc' },
      { source: '本文', page: 2, why: 'figure-page' as const, text: 'defgh' },
    ];
    const c = withoutParts({ parts, missing: [], dropped: [], chars: 8 }, new Set([partKey(parts[0])]));
    expect(c.parts).toEqual([parts[1]]);
    expect(c.chars).toBe(5);
  });

  it('「名前の構造にする」: 下書きの化合物の構造を名前の構造に替え、名前の要確認を消す', async () => {
    const r = await reconcile(checkPlan(plan('CC(O)CCCC=C'), [], {}), facts, fakeOpsin);
    const { doc, schemeId } = draftScheme(emptyDoc(), r.checked, { text: '', model: 'm', origin: { x: 0, y: 0 }, notes: r.notes });
    const cid = doc.schemes![schemeId].draft!.nameChecks![0].compoundId;
    expect(doc.schemes![schemeId].draft!.issues.some((i) => i.kind === 'name' && i.compoundId === cid)).toBe(true);
    const out = applyNameStructure(doc, schemeId, cid);
    const st = out.compounds![cid].structure;
    expect(canonical(documentSmiles({ ...emptyDoc(), atoms: st.atoms, bonds: st.bonds, groups: st.groups }).smiles ?? '')).toBe(canonical('C[C@@H](O)CCC=C'));
    expect(out.schemes![schemeId].draft!.issues.some((i) => i.kind === 'name' && i.compoundId === cid)).toBe(false);
    expect(out.schemes![schemeId].draft!.nameChecks![0].result).toBe('replaced');
    // 名前の構造が無い化合物では何もしない
    expect(applyNameStructure(doc, schemeId, 'nope')).toBe(doc);
  });
});

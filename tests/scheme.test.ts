import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc, type Doc } from '../src/chem/model';
import { analyzeScheme } from '../src/chem/reaction';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { importText } from '../src/io/convert';
import { parseDocFile, serializeDoc } from '../src/io/docfile';
import { canonical, documentSmiles } from '../src/io/smiles';
import { renderScheme } from '../src/scheme/layout';
import {
  addStepWithProduct, addSubstrate, dissolveScheme, duplicateScheme, editSchemeStyle, freeFragments, numberCompounds, parseConditionText, parseReagents, removeStep,
  pinScheme, schemeFromDrawing, setSchemeStyle, startScheme, unpinScheme, updateCompound, updateStep,
} from '../src/scheme/ops';
import { footnoteText, getStyle, yieldText } from '../src/scheme/style';
import { syncSchemes } from '../src/scheme/sync';
import { loadRDKit } from './rdkit';
import { reactionDoc } from './samples';

beforeAll(loadRDKit);

/** 分子を3つ置いた文書（左から Boc-Ala-OH・H-Gly-OMe・生成物） */
function threeMolecules(): Doc {
  let d = importText(emptyDoc(), 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O').doc;
  d = importText(d, 'NCC(=O)OC').doc;
  d = importText(d, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC').doc;
  return d;
}

function buildCoupling() {
  const d0 = threeMolecules();
  const [boc, gly, prod] = freeFragments(d0, new Set());
  let { doc, schemeId } = startScheme(d0, boc);
  doc = addSubstrate(doc, schemeId, 0, gly);
  doc = addStepWithProduct(doc, schemeId, prod);
  doc = updateStep(doc, schemeId, 0, { reagents: [{ text: 'EDC·HCl', equiv: 1.2 }, { text: 'HOBt', equiv: 1.2 }], solvent: 'CH2Cl2', temp: 'rt', time: '12 h', yield: 85 });
  return { doc, schemeId };
}

const texts = (d: Doc) => Object.values(d.texts).map((t) => t.text);

describe('スキームのデータと自動レイアウト', () => {
  it('分子を選んで段を組み立てると、反応式が描かれ反応 SMILES になる', () => {
    const { doc } = buildCoupling();
    expect(Object.keys(doc.arrows)).toHaveLength(1);
    expect(Object.keys(doc.pluses)).toHaveLength(1);
    // 試薬は矢印の上で、幅の上限（120pt）を超えるところで折り返す
    expect(texts(doc)).toEqual(expect.arrayContaining(['EDC·HCl 1.2 equiv', 'HOBt 1.2 equiv', 'CH2Cl2, rt, 12 h', '85%']));
    const [reac, , prod] = documentSmiles(doc).smiles!.split('>');
    expect(reac.split('.').sort()).toEqual([canonical('CC(C)(C)OC(=O)N[C@@H](C)C(=O)O'), canonical('NCC(=O)OC')].sort());
    expect(prod).toBe(canonical('CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC'));
    // 分子は矢印の左右、文字は矢印の上下に並ぶ
    const [st] = analyzeScheme(doc);
    expect(st.reactants).toHaveLength(2);
    expect(st.products).toHaveLength(1);
    expect(st.above.length + st.below.length).toBe(4);
  });

  it('書式を切り替えると、同じデータから違う見た目になる', () => {
    let { doc, schemeId } = buildCoupling();
    doc = updateCompound(doc, Object.keys(doc.compounds!)[2], { nickname: 'ジペプチド' });
    doc = setSchemeStyle(doc, schemeId, 'lab');
    expect(texts(doc)).toEqual(expect.arrayContaining(['EDC·HCl (1.2 eq.)', 'HOBt (1.2 eq.)', 'ジペプチド (85%)']));
    doc = setSchemeStyle(doc, schemeId, 'footnote');
    expect(texts(doc).join(' ')).toContain('Reagents and conditions: (a) EDC·HCl 1.2 equiv, HOBt 1.2 equiv, CH2Cl2, rt, 12 h, 85%.');
    expect(texts(doc)).toContain('a');
  });

  it('化合物番号を振ると、分子の下に太字で出る', () => {
    let { doc, schemeId } = buildCoupling();
    doc = numberCompounds(doc, schemeId);
    const labels = Object.values(doc.texts).filter((t) => t.bold).map((t) => t.text).sort();
    expect(labels).toEqual(['1', '2', '3']);
  });

  it('多段のスキームは、幅を超えると折り返す', () => {
    let d = importText(emptyDoc(), 'CCCCCCCCCCO').doc;
    for (const s of ['CCCCCCCCCC=O', 'CCCCCCCCCC(=O)O', 'CCCCCCCCCC(=O)OC', 'CCCCCCCCCC(=O)N']) d = importText(d, s).doc;
    const frags = freeFragments(d, new Set());
    let { doc, schemeId } = startScheme(d, frags[0]);
    for (const f of frags.slice(1)) doc = addStepWithProduct(doc, schemeId, f);
    const ys = [...new Set(Object.values(doc.arrows).map((r) => Math.round(r.y1)))];
    expect(Object.keys(doc.arrows)).toHaveLength(4);
    expect(ys.length).toBeGreaterThan(1);
    // 折り返しても反応 SMILES は4段
    expect(documentSmiles(doc).smiles!.split('\n')).toHaveLength(4);
  });

  it('描いた反応式（分子・矢印・文字）をスキームのデータにできる', () => {
    const r = schemeFromDrawing(reactionDoc())!;
    const s = r.doc.schemes![r.schemeId];
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].from).toHaveLength(2);
    expect(s.steps[0].to).toHaveLength(1);
    expect(s.steps[0].reagents.map((x) => x.text)).toEqual(['EDC', 'HOBt']);
    expect(s.steps[0].solvent).toBe('DMF');
    expect(s.steps[0].temp).toBe('rt');
  });

  it('条件の文字を振り分ける', () => {
    expect(parseConditionText(['TFA (10 equiv), CH2Cl2', '0 °C, 2 h, 95%'])).toEqual({
      reagents: [{ text: 'TFA', equiv: 10 }],
      solvent: 'CH2Cl2',
      temp: '0 °C',
      time: '2 h',
      yield: 95,
    });
  });

  it('段を消すと、前後の段がつながる', () => {
    let d = importText(emptyDoc(), 'CO').doc;
    for (const s of ['C=O', 'OC=O']) d = importText(d, s).doc;
    const f = freeFragments(d, new Set());
    let { doc, schemeId } = startScheme(d, f[0]);
    doc = addStepWithProduct(doc, schemeId, f[1]);
    doc = addStepWithProduct(doc, schemeId, f[2]);
    doc = removeStep(doc, schemeId, 0);
    expect(doc.schemes![schemeId].steps).toHaveLength(1);
    expect(Object.keys(doc.arrows)).toHaveLength(1);
  });

  it('収率の書き方', () => {
    expect(yieldText(85, getStyle('acs'))).toBe('85%');
    expect(yieldText('quant.', getStyle('acs'))).toBe('quant.');
    expect(yieldText('quant.', getStyle('lab'))).toBe('(quant.)');
    expect(footnoteText({ id: 'x', from: [], to: [], reagents: [{ text: 'TFA' }], solvent: 'CH2Cl2' }, 1, getStyle('footnote'))).toBe('(b) TFA, CH2Cl2');
  });
});

describe('キャンバスで直した構造を、化合物のデータへ戻す', () => {
  it('分子の原子を変えると化合物の構造が変わり、描き直される', () => {
    const { doc, schemeId } = buildCoupling();
    const cid = doc.schemes![schemeId].steps[0].to[0];
    const target = Object.values(doc.atoms).find((a) => a.ref === `${schemeId}:${cid}` && a.element === 'N')!;
    const edited = { ...doc, atoms: { ...doc.atoms, [target.id]: { ...target, element: 'O' } } };
    const synced = syncSchemes(doc, edited);
    const els = Object.values(synced.compounds![cid].structure.atoms).map((a) => a.element);
    expect(els.filter((e) => e === 'N')).toHaveLength(1);
    expect(synced).not.toBe(edited);
  });

  it('スキーム全体を平行に動かすと、置き場所が動く', () => {
    const { doc, schemeId } = buildCoupling();
    const moved = structuredClone(doc);
    for (const a of Object.values(moved.atoms)) a.x += 30;
    for (const r of Object.values(moved.arrows)) {
      r.x1 += 30;
      r.x2 += 30;
    }
    const synced = syncSchemes(doc, moved);
    expect(synced.schemes![schemeId].origin.x).toBeCloseTo(doc.schemes![schemeId].origin.x + 30);
  });

  it('描き直し（id が入れ替わる）では何もしない', () => {
    const { doc, schemeId } = buildCoupling();
    const again = renderScheme(doc, schemeId);
    expect(syncSchemes(doc, again)).toBe(again);
  });
});

describe('保存と書き出し', () => {
  it('スキームのデータは文書の保存で保たれ、版 1 の文書も読める', () => {
    const { doc } = buildCoupling();
    const back = parseDocFile(serializeDoc(doc));
    expect(back.schemes).toEqual(doc.schemes);
    expect(back.compounds).toEqual(doc.compounds);
    const v1 = JSON.stringify({ format: 'ai-chem-editor', version: 1, doc: { ...emptyDoc() } });
    expect(parseDocFile(v1).schemes).toEqual({});
  });

  it('CDXML に書き出すと scheme/step を持ち、太字と化学式の書き方が残る', () => {
    const { doc, schemeId } = buildCoupling();
    const numbered = numberCompounds(doc, schemeId);
    const x = writeCdxml(numbered);
    expect(x).toContain('<step ');
    expect(x).toMatch(/face="1">1<\/s>/);
    expect(x).toMatch(/face="96">CH2Cl2, rt, 12 h<\/s>/);
    const back = readCdxml(x);
    expect(Object.values(back.texts).filter((t) => t.bold)).toHaveLength(3);
    expect(documentSmiles(back).smiles).toBe(documentSmiles(numbered).smiles);
  });

  it('スキームをやめると、図はそのまま残りデータだけ消える', () => {
    const { doc, schemeId } = buildCoupling();
    const plain = dissolveScheme(doc, schemeId);
    expect(plain.schemes![schemeId]).toBeUndefined();
    expect(Object.keys(plain.arrows)).toHaveLength(1);
    expect(Object.values(plain.atoms).every((a) => !a.ref)).toBe(true);
  });
});

describe('試薬の欄の読み取り', () => {
  it('当量の書き方の違いと、括弧の中のカンマ', () => {
    expect(parseReagents('TFA (10 equiv), HATU 1.2 eq., DIPEA, Pd(PPh3)4 (5 equiv)')).toEqual([
      { text: 'TFA', equiv: 10 },
      { text: 'HATU', equiv: 1.2 },
      { text: 'DIPEA' },
      { text: 'Pd(PPh3)4', equiv: 5 },
    ]);
  });
});

describe('書式を直す', () => {
  it('プリセットを直すと写しができ、プリセットそのものは変わらない', () => {
    const { doc, schemeId } = buildCoupling();
    const out = editSchemeStyle(doc, schemeId, { equivFormat: '({n} eq.)', above: ['reagents', 'solvent'], below: ['temp', 'time'] });
    const sid = out.schemes![schemeId].styleId;
    expect(sid).not.toBe('acs');
    expect(out.styles![sid].name).toBe('ACS（変更）');
    expect(getStyle('acs').equivFormat).toBe('{n} equiv');
    // 溶媒を矢印の上へ。上の行は幅に収まるところまで詰める
    expect(texts(out)).toEqual(expect.arrayContaining(['EDC·HCl (1.2 eq.)', 'HOBt (1.2 eq.), CH2Cl2', 'rt, 12 h']));
    // 2回目は同じ写しを直す
    const again = editSchemeStyle(out, schemeId, { yieldPosition: 'none' });
    expect(again.schemes![schemeId].styleId).toBe(sid);
    expect(texts(again)).not.toContain('85%');
    // 文書の保存で書式も残る
    expect(parseDocFile(serializeDoc(again)).styles![sid].yieldPosition).toBe('none');
  });
});

describe('反応の使い回し', () => {
  it('スキームを複製すると、化合物を共有したまま条件だけ別に直せる', () => {
    const { doc: d0, schemeId } = buildCoupling();
    const { doc: d1, schemeId: copy } = duplicateScheme(d0, schemeId);
    expect(d1.schemes![copy].steps[0].from).toEqual(d0.schemes![schemeId].steps[0].from);
    const below = (sid: string, d: Doc) => Math.min(...Object.values(d.atoms).filter((a) => a.ref?.startsWith(`${sid}:`)).map((a) => a.y));
    const bottom = Math.max(...Object.values(d1.atoms).filter((a) => a.ref?.startsWith(`${schemeId}:`)).map((a) => a.y));
    expect(below(copy, d1)).toBeGreaterThan(bottom);
    let d = updateStep(d1, copy, 0, { solvent: 'DMF' });
    expect(d.schemes![schemeId].steps[0].solvent).toBe('CH2Cl2');
    // 番号は共有なので両方に出る
    const prod = d.schemes![schemeId].steps[0].to[0];
    d = updateCompound(d, prod, { number: '3' });
    expect(Object.values(d.texts).filter((t) => t.text === '3').map((t) => t.ref).sort()).toEqual([copy, schemeId].sort());
  });
});

describe('固定（反映させない版）', () => {
  it('固定した図は、共有する化合物の番号と書式を直しても変わらず、固定を外すと今の中身で描き直す', () => {
    const { doc: d0, schemeId } = buildCoupling();
    const { doc: d1, schemeId: copy } = duplicateScheme(d0, schemeId);
    const prod = d1.schemes![schemeId].steps[0].to[0];
    let d = pinScheme(updateCompound(d1, prod, { number: '3' }), schemeId, new Date('2026-10-28T00:00:00Z'));
    expect(d.schemes![schemeId].pinned?.at).toBe('2026-10-28T00:00:00.000Z');
    d = updateCompound(d, prod, { number: '5' });
    const refsOf = (x: Doc, t: string) => Object.values(x.texts).filter((y) => y.text === t).map((y) => y.ref);
    expect(refsOf(d, '3')).toEqual([schemeId]);
    expect(refsOf(d, '5')).toEqual([copy]);
    // 書式を変えても、固定した図は固定したときの書式で描く
    d = editSchemeStyle(d, schemeId, { yieldPosition: 'none' });
    expect(refsOf(d, '85%')).toContain(schemeId);
    // 固定を外すと、今の番号と書式で描き直す
    d = unpinScheme(d, schemeId);
    expect(d.schemes![schemeId].pinned).toBeUndefined();
    expect(refsOf(d, '5').sort()).toEqual([copy, schemeId].sort());
    expect(refsOf(d, '85%')).not.toContain(schemeId);
    // 文書の保存で固定も残る
    expect(parseDocFile(serializeDoc(pinScheme(d, schemeId))).schemes![schemeId].pinned?.compounds[prod].number).toBe('5');
  });

  it('固定した図の分子をキャンバスで直しても、化合物のデータは変わらず、固定した形に戻る。複製は固定しない', () => {
    const { doc: d0, schemeId } = buildCoupling();
    const doc = pinScheme(d0, schemeId);
    const cid = doc.schemes![schemeId].steps[0].to[0];
    const target = Object.values(doc.atoms).find((a) => a.ref === `${schemeId}:${cid}` && a.element === 'N')!;
    const edited = { ...doc, atoms: { ...doc.atoms, [target.id]: { ...target, element: 'O' } } };
    const synced = syncSchemes(doc, edited);
    expect(synced.compounds![cid]).toEqual(doc.compounds![cid]);
    expect(Object.values(synced.atoms).filter((a) => a.ref === `${schemeId}:${cid}` && a.element === 'N')).toHaveLength(2);
    const { doc: d2, schemeId: copy } = duplicateScheme(doc, schemeId);
    expect(d2.schemes![copy].pinned).toBeUndefined();
  });
});

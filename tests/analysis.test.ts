import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/analysis.json';
import { analyzeFragment, formatAnalysisText, targetFragments, type Analysis } from '../src/chem/analysis';
import { emptyDoc } from '../src/chem/model';
import { bondAtPoint, setAbbr } from '../src/chem/ops';
import { importText } from '../src/io/convert';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** 文書全体を1つの分析にする（塩などの複数の断片も1つとして数える） */
function analyzeAll(smiles: string): Analysis {
  const doc = importText(emptyDoc(), smiles).doc;
  const r = analyzeFragment(doc, Object.keys(doc.atoms));
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('分析パネルの値は RDKit（Python 版）と一致する', () => {
  it.each(Object.entries(fixture))('%s', (_name, exp) => {
    const a = analyzeAll(exp.smiles);
    expect(a.formula).toBe(exp.formula);
    expect(a.mw).toBeCloseTo(exp.mw, 2);
    expect(a.exactMass).toBeCloseTo(exp.exactMass, 4);
    expect(a.logP).toBeCloseTo(exp.logP, 2);
    expect(a.tpsa).toBeCloseTo(exp.tpsa, 2);
    expect(a.hbd).toBe(exp.hbd);
    expect(a.hba).toBe(exp.hba);
    expect(a.stereo.map((s) => s.label).sort()).toEqual(exp.stereo);
    // 元素分析値は合計 100%、平均原子量で数えた分子量は RDKit の分子量に近い
    expect(a.ea.reduce((s, e) => s + e.pct, 0)).toBeCloseTo(100, 6);
  });
});

describe('分析の細部', () => {
  it('アスピリンの元素分析値と m/z', () => {
    const a = analyzeAll('CC(=O)Oc1ccccc1C(=O)O');
    expect(a.ea.map((e) => [e.element, Number(e.pct.toFixed(2))])).toEqual([
      ['C', 60.0],
      ['H', 4.48],
      ['O', 35.52],
    ]);
    expect(a.mz[0].label).toBe('[M+H]⁺');
    expect(a.mz[0].value).toBeCloseTo(181.0495, 3);
    expect(formatAnalysisText(a)).toContain('Elemental Analysis: C, 60.00; H, 4.48; O, 35.52');
  });

  it('略号を展開して数える（Boc-NH-Me）', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    const [, b] = Object.keys(d.atoms);
    d = setAbbr(d, b, 'Boc');
    const a = analyzeFragment(d, Object.keys(d.atoms));
    expect('error' in a ? a.error : a.formula).toBe('C6H12O2');
  });

  it('立体の決まっていない不斉中心と電荷を知らせる', () => {
    const a = analyzeAll('CC(N)C(=O)[O-]');
    expect(a.unspecifiedStereo).toBe(1);
    expect(a.warnings.map((w) => w.message)).toEqual(['立体の決まっていない不斉中心が 1 個あります', '全体の電荷が -1 です']);
    expect(a.mz[0].label).toBe('M−');
  });

  it('選択に掛かる分子だけを対象にする', () => {
    const doc = importText(emptyDoc(), 'CCO.c1ccccc1').doc;
    const benzeneAtom = Object.values(doc.atoms).find((x) => x.element === 'C' && Object.values(doc.bonds).filter((b) => b.a1 === x.id || b.a2 === x.id).length === 2 && Object.values(doc.bonds).some((b) => (b.a1 === x.id || b.a2 === x.id) && b.order === 2))!;
    expect(targetFragments(doc, new Set())).toHaveLength(2);
    const t = targetFragments(doc, new Set([benzeneAtom.id]));
    expect(t).toHaveLength(1);
    expect(t[0]).toHaveLength(6);
  });
});

describe('二重結合の E/Z', () => {
  it('RDKit の CIP で E/Z を出し、結合の id で返す。E/Z の無い二重結合は出さない（描いた形が立体を決める）', () => {
    for (const [smi, want] of [['C/C=C/C', ['E']], ['C/C=C\\C', ['Z']], ['CC=C(C)C', []], ['F/C(Cl)=C(/Br)I', ['E']]] as const) {
      const d = importText(emptyDoc(), smi).doc;
      const r = analyzeFragment(d, Object.keys(d.atoms)) as Analysis;
      expect(r.bondStereo.map((s) => s.label), smi).toEqual(want);
      for (const s of r.bondStereo) expect(d.bonds[s.bondId].order).toBe(2);
    }
  });
});

describe('同位体のパターン', () => {
  const one = (smiles: string) => {
    const d = importText(emptyDoc(), smiles).doc;
    return (analyzeFragment(d, Object.keys(d.atoms)) as Analysis).isotopes!;
  };
  it('アスピリン（C9H8O4）の M+1 は約 10%、M+2 は約 1%', () => {
    const p = one('CC(=O)Oc1ccccc1C(=O)O');
    expect(p[0]).toMatchObject({ offset: 0, rel: 100 });
    expect(p[0].mass).toBeCloseTo(180.0423, 3);
    expect(p[1].rel).toBeCloseTo(10.3, 0);
    expect(p[2].rel).toBeGreaterThan(0.8);
    expect(p[2].rel).toBeLessThan(1.4);
  });
  it('塩素 2 個は 100 : 64 : 10、臭素 1 個は 1 : 1', () => {
    const cl = one('ClCCl').filter((x) => x.rel > 5);
    expect(cl.map((x) => x.offset)).toEqual([0, 2, 4]);
    expect(cl[1].rel).toBeCloseTo(64, 0);
    expect(cl[2].rel).toBeCloseTo(10.2, 0);
    const br = one('CBr').filter((x) => x.rel > 5);
    expect(br.map((x) => x.offset)).toEqual([0, 2]);
    expect(br[1].rel).toBeCloseTo(97.3, 0);
  });
  it('同位体を指定した原子があれば出さない', () => {
    const d = importText(emptyDoc(), 'CC').doc;
    const a = Object.values(d.atoms)[0];
    d.atoms[a.id] = { ...a, isotope: 13 };
    expect((analyzeFragment(d, Object.keys(d.atoms)) as Analysis).isotopes).toBeNull();
  });
});

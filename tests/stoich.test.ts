import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { importText } from '../src/io/convert';
import { addStepWithProduct, addSubstrate, freeFragments, startScheme, updateStep, updateStoich } from '../src/scheme/ops';
import { stoichTable, stoichTsv } from '../src/scheme/stoich';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

function coupling() {
  let d = importText(emptyDoc(), 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O').doc;
  d = importText(d, 'NCC(=O)OC').doc;
  d = importText(d, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC').doc;
  const [a, b, c] = freeFragments(d, new Set());
  let { doc, schemeId } = startScheme(d, a);
  doc = addSubstrate(doc, schemeId, 0, b);
  doc = addStepWithProduct(doc, schemeId, c);
  doc = updateStep(doc, schemeId, 0, { reagents: [{ text: 'EDC·HCl', equiv: 1.2 }, { text: 'Et3N', equiv: 3 }, { text: 'X-reagent', equiv: 2 }] });
  return { doc, schemeId };
}

describe('化学量論表', () => {
  it('最初の基質の重さと当量から、各試薬の mmol・mg・µL と理論収量を出す', () => {
    let { doc, schemeId } = coupling();
    doc = updateStoich(doc, schemeId, 0, { scale: { value: 100, unit: 'mg' }, substrateEquiv: { [doc.schemes![schemeId].steps[0].from[1]]: 1.1 } });
    const rows = stoichTable(doc, doc.schemes![schemeId].steps[0]);
    const by = (name: string) => rows.find((r) => r.name === name)!;
    const base = 100 / 189.21;
    expect(rows[0].mmol).toBeCloseTo(base, 4);
    expect(rows[1].equiv).toBe(1.1);
    expect(rows[1].mg).toBeCloseTo(base * 1.1 * 89.09, 1);
    expect(by('EDC·HCl').mg).toBeCloseTo(base * 1.2 * 191.7, 1);
    expect(by('Et3N').uL).toBeCloseTo((base * 3 * 101.19) / 0.726, 1);
    // 辞書に無い試薬は、分子量を入れるまで量が出ない
    expect(by('X-reagent').mg).toBeUndefined();
    doc = updateStoich(doc, schemeId, 0, { reagent: { index: 2, mw: 200 } });
    expect(stoichTable(doc, doc.schemes![schemeId].steps[0]).find((r) => r.name === 'X-reagent')!.mg).toBeCloseTo(base * 2 * 200, 1);
    // 生成物は理論収量
    expect(rows.at(-1)!.kind).toBe('product');
    expect(rows.at(-1)!.mg).toBeCloseTo(base * 260.29, 0);
  });

  it('mmol で基準を入れても計算でき、タブ区切りで書き出せる', () => {
    let { doc, schemeId } = coupling();
    doc = updateStoich(doc, schemeId, 0, { scale: { value: 2, unit: 'mmol' } });
    const rows = stoichTable(doc, doc.schemes![schemeId].steps[0]);
    expect(rows[0].mg).toBeCloseTo(2 * 189.21, 1);
    const tsv = stoichTsv(rows).split('\n');
    expect(tsv[0]).toBe('\t名前\tMW\t当量\tmmol\tmg\tµL');
    expect(tsv[1].split('\t').slice(2)).toEqual(['189.21', '1.00', '2.000', '378.4', '']);
  });
});

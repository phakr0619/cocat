import { beforeAll, describe, expect, it } from 'vitest';
import { ABBREVIATIONS } from '../src/chem/abbreviations';
import { parseCondensed } from '../src/chem/condensed';
import { canonical } from '../src/io/smiles';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const table = (name: string) => ABBREVIATIONS[name]?.smiles;
const read = (label: string) => {
  const r = parseCondensed(label, table);
  return r ? canonical(r.smiles) : null;
};

// ラベル → 正しい構造（* が結合する所）
const CASES: [string, string][] = [
  // 原子＋略号
  ['NHFmoc', '*NC(=O)OCC1c2ccccc2-c2ccccc21'],
  ['OPMB', '*OCc1ccc(OC)cc1'],
  ['NHAc', '*NC(C)=O'],
  ['N(Boc)2', '*N(C(=O)OC(C)(C)C)C(=O)OC(C)(C)C'],
  ['NMe2', '*N(C)C'],
  ['OTIPS', '*O[Si](C(C)C)(C(C)C)C(C)C'],
  ['SiMe3', '*[Si](C)(C)C'],
  ['CH2OTBS', '*CO[Si](C)(C)C(C)(C)C'],
  ['SO2Ph', '*S(=O)(=O)c1ccccc1'],
  ['SMe', '*SC'],
  ['PPh2', '*P(c1ccccc1)c1ccccc1'],
  // 縮約式
  ['CH2OH', '*CO'],
  ['CH2CH2OH', '*CCO'],
  ['CHO', '*C=O'],
  ['CO2tBu', '*C(=O)OC(C)(C)C'],
  ['COOH', '*C(=O)O'],
  ['CONH2', '*C(N)=O'],
  ['COMe', '*C(C)=O'],
  ['COCl', '*C(=O)Cl'],
  ['CH2Cl', '*CCl'],
  ['CCl3', '*C(Cl)(Cl)Cl'],
  ['CHF2', '*C(F)F'],
  ['OCF3', '*OC(F)(F)F'],
  ['OCH3', '*OC'],
  ['SO2NH2', '*S(N)(=O)=O'],
  ['SO3H', '*S(=O)(=O)O'],
  ['CH(OMe)2', '*C(OC)OC'],
  ['(CH2)3OH', '*CCCO'],
  ['CH=CH2', '*C=C'],
  ['CCH', '*C#C'],
  ['C2H5', '*CC'],
  ['C3H7', '*CCC'],
  ['C6H5', '*c1ccccc1'],
  ['N3', '*N=[N+]=[N-]'],
  ['NHNH2', '*NN'],
  ['B(OH)2', '*B(O)O'],
  ['PO(OEt)2', '*P(=O)(OCC)OCC'],
  ['P(O)(OEt)2', '*P(=O)(OCC)OCC'],
  ['C(=O)Me', '*C(C)=O'],
  // 塩
  ['BF3K', '*[B-](F)(F)F.[K+]'],
  ['CO2Na', '*C(=O)[O-].[Na+]'],
  ['SO3Na', '*S(=O)(=O)[O-].[Na+]'],
  ['ONa', '*[O-].[Na+]'],
  // 左向きの書き方
  ['HOH2C', '*CO'],
  ['FmocHN', '*NC(=O)OCC1c2ccccc2-c2ccccc21'],
  ['MeO2C', '*C(=O)OC'],
  ['KF3B', '*[B-](F)(F)F.[K+]'],
  ['Me2N', '*N(C)C'],
  ['H2NOC', '*C(N)=O'],
  ['tBuO2C', '*C(=O)OC(C)(C)C'],
];

describe('ラベルの書き方を読む（縮約式・原子＋略号・塩・左向き）', () => {
  for (const [label, want] of CASES) {
    it(label, () => expect(read(label)).toBe(canonical(want)));
  }

  it('右向き・左向きの書き方を返す（図のラベルに使う）', () => {
    expect(parseCondensed('NHFmoc', table)).toMatchObject({ label: 'NHFmoc', reversed: 'FmocHN' });
    expect(parseCondensed('HOH2C', table)).toMatchObject({ label: 'CH2OH', reversed: 'HOH2C' });
    expect(parseCondensed('BF3K', table)).toMatchObject({ label: 'BF3K', reversed: 'KF3B' });
  });

  it('読めないものは null（推し量って間違えない）', () => {
    for (const bad of ['Xyz', 'PG', 'R', 'CH5', 'C3H5', 'NH4', 'Foo2', 'O', '', '((CH2)', 'OHOH']) expect(read(bad), bad).toBeNull();
  });
});

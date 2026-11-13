import { beforeAll, describe, expect, it } from 'vitest';
import { writeCdxml } from '../src/io/cdxml';
import { canonical, documentSmiles } from '../src/io/smiles';
import { SAMPLES } from '../src/samples';
import { setSchemeStyle } from '../src/scheme/ops';
import { STYLE_PRESETS } from '../src/scheme/style';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const build = (id: string) => SAMPLES.find((s) => s.id === id)!.build();

describe('見本', () => {
  it.each(SAMPLES.map((s) => [s.name, s.id]))('%s は作れて、SMILES になる', (_, id) => {
    const d = build(id);
    expect(Object.keys(d.atoms).length).toBeGreaterThan(5);
    expect(documentSmiles(d).error).toBeUndefined();
  });

  it('3段のスキームは段が3つ、番号 1〜5 と呼び名を持つ', () => {
    const d = build('multistep');
    const s = Object.values(d.schemes!)[0];
    expect(s.steps).toHaveLength(3);
    const texts = Object.values(d.texts).map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(['1', '2', '3', '4', '5', 'LiOH 3 equiv', 'quant.']));
    // 折り返した図でも、反応 SMILES はデータの段の順・中身になる
    const lines = documentSmiles(d).smiles!.split('\n');
    expect(lines).toHaveLength(3);
    const c = (x: string) => x.split('.').map((m) => canonical(m)).sort().join('.');
    expect(lines.map((l) => l.split('>').map(c))).toEqual([
      [c('CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC'), '', c('CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC')],
      [c('CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC'), '', c('C[C@H](N)C(=O)NCC(=O)OC')],
      [c('C[C@H](N)C(=O)NCC(=O)OC'), '', c('C[C@H](N)C(=O)NCC(=O)O')],
    ]);
    // CDXML の <step> も3つ
    expect(writeCdxml(d).match(/<step /g)).toHaveLength(3);
  });

  it.each(['coupling', 'multistep', 'conditions'])('%s を書式を切り替えて描き直せる（同じ中身・同じ反応 SMILES）', (id) => {
    const d = build(id);
    const sid = Object.keys(d.schemes!)[0];
    const smiles = documentSmiles(d).smiles;
    for (const st of STYLE_PRESETS) {
      const r = setSchemeStyle(d, sid, st.id);
      expect(documentSmiles(r).smiles).toBe(smiles);
      if (st.conditions === 'footnote') expect(Object.values(r.texts).some((t) => t.text.startsWith('Reagents and conditions'))).toBe(true);
    }
  });
});

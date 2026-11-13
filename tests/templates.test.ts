import { beforeAll, describe, expect, it } from 'vitest';
import { ABBREVIATIONS } from '../src/chem/abbreviations';
import { emptyDoc } from '../src/chem/model';
import { setAbbr } from '../src/chem/ops';
import { placePart } from '../src/chem/partOps';
import { TEMPLATE_GROUPS } from '../src/chem/templates';
import { templateStructure } from '../src/ui/TemplatePalette';
import { importText } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import { getRDKit } from '../src/chem/rdkit';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** RDKit の CIP（新しい方式）で、立体の中心の R/S を並べる */
function cip(smiles: string): string {
  const m = getRDKit().get_mol(smiles)!;
  try {
    return (JSON.parse(m.get_stereo_tags()) as { CIP_atoms: [number, string][] }).CIP_atoms.map(([, l]) => l.replace(/[()]/g, '')).join('');
  } finally {
    m.delete();
  }
}

describe('雛形（テンプレート）', () => {
  it('どれも RDKit で読め、置くと同じ構造になる', () => {
    for (const g of TEMPLATE_GROUPS) {
      for (const t of g.items) {
        const s = templateStructure(t);
        const { doc } = placePart(emptyDoc(), s, { kind: 'blank', p: { x: 100, y: 100 } });
        expect(canonical(docToSmiles(doc).smiles!), t.name).toBe(canonical(t.smiles));
      }
    }
  });

  it('はじめのタブは芳香環で、ベンゼンと複素芳香環が入っている', () => {
    expect(TEMPLATE_GROUPS[0].name).toBe('芳香環');
    const names = TEMPLATE_GROUPS[0].items.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['ベンゼン', 'ナフタレン', 'ピリジン', 'ピロール', 'フラン', 'チオフェン', 'インドール']));
  });

  it('アミノ酸は L 体（Cys だけ R、Ile は 2S,3S、Thr は 2S,3R）', () => {
    const aa = TEMPLATE_GROUPS.find((g) => g.name === 'アミノ酸')!.items;
    expect(aa).toHaveLength(20);
    for (const t of aa) {
      const want = t.name === 'Gly' ? '' : t.name === 'Cys' ? 'R' : t.name === 'Ile' ? 'SS' : t.name === 'Thr' ? 'SR' : 'S';
      expect(cip(t.smiles), t.name).toBe(want);
    }
  });

  it('糖は D 体の決まった InChIKey（グルコースの α と β など）', () => {
    const key = (name: string) => getRDKit().get_inchikey_for_inchi(getRDKit().get_mol(TEMPLATE_GROUPS.find((g) => g.name === '糖')!.items.find((t) => t.name === name)!.smiles)!.get_inchi());
    expect(key('β-Glc')).toBe('WQZGKKKJIJFFOK-VFUOTHLCSA-N');
    expect(key('α-Glc')).toBe('WQZGKKKJIJFFOK-DVKNGEFBSA-N');
    expect(key('β-Gal')).toBe('WQZGKKKJIJFFOK-FPRJBGLDSA-N');
    expect(key('α-Man')).toBe('WQZGKKKJIJFFOK-PQMKYFCFSA-N');
    expect(key('β-Rib')).toBe('HMFHBZSHGGEWLO-TXICZTDVSA-N');
  });
});

describe('略号', () => {
  it('どの略号も、メチル基に付けて展開すると、表の構造になる', () => {
    for (const [name, def] of Object.entries(ABBREVIATIONS)) {
      let d = importText(emptyDoc(), 'CC').doc;
      const end = Object.values(d.atoms)[1];
      d = setAbbr(d, end.id, name);
      const want = canonical(def.smiles.replace('*', 'C'));
      expect(canonical(docToSmiles(d).smiles!), name).toBe(want);
    }
  });
});

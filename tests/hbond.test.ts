import { beforeAll, describe, expect, it } from 'vitest';
import { valenceErrors, implicitHydrogens } from '../src/chem/hydrogens';
import { adjacency, edit, emptyDoc, type Doc } from '../src/chem/model';
import { addAtom, addBondIn } from '../src/chem/ops';
import { cdxmlToCdx, cdxToCdxml } from '../src/io/cdx';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { exportMol } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** メタノールの O−H と、もう 1 つのメタノールの O を、点線の結合（水素結合）でつなぐ */
function dimer(stereo: 'dashed' | 'none'): { doc: Doc; h: string } {
  let h = '';
  const doc = edit(emptyDoc(), (d) => {
    const c1 = addAtom(d, { x: 0, y: 0 });
    const o1 = addAtom(d, { x: 14, y: 0 }, 'O');
    const hh = addAtom(d, { x: 28, y: 0 }, 'H');
    const o2 = addAtom(d, { x: 50, y: 0 }, 'O');
    const c2 = addAtom(d, { x: 64, y: 0 });
    addBondIn(d, c1.id, o1.id);
    addBondIn(d, o1.id, hh.id);
    addBondIn(d, o2.id, c2.id);
    addBondIn(d, hh.id, o2.id, 1, stereo);
    h = hh.id;
  });
  return { doc, h };
}

describe('点線の結合（水素結合・部分結合）', () => {
  it('価数に数えない: O−H···O の H に赤い枠（価数の超過）を出さず、受け手の O の水素も減らさない', () => {
    const { doc, h } = dimer('dashed');
    expect(valenceErrors(doc).has(h)).toBe(false);
    const o2 = Object.values(doc.atoms).filter((a) => a.element === 'O')[1];
    expect(implicitHydrogens(o2, adjacency(doc))).toBe(1);
    // ふつうの結合なら、今までどおり価数の超過
    const plain = dimer('none');
    expect(valenceErrors(plain.doc).has(plain.h)).toBe(true);
  });

  it('SMILES・MOL には入れない（2 つのメタノール）', () => {
    const { doc } = dimer('dashed');
    expect(canonical(docToSmiles(doc).smiles!)).toBe(canonical('[H]OC.CO'));
    expect(exportMol(doc).split('\n')[3].slice(3, 6).trim()).toBe('3');
  });

  it('CDXML・CDX では ChemDraw の水素結合（Order="hydrogen"）として書き、読むと点線の結合に戻る', () => {
    const { doc } = dimer('dashed');
    const x = writeCdxml(doc);
    expect(x).toMatch(/Order="hydrogen"/);
    const back = readCdxml(x);
    expect(Object.values(back.bonds).filter((b) => b.stereo === 'dashed')).toHaveLength(1);
    expect(valenceErrors(back).size).toBe(0);
    const viaCdx = readCdxml(cdxToCdxml(cdxmlToCdx(x)));
    expect(Object.values(viaCdx.bonds).filter((b) => b.stereo === 'dashed')).toHaveLength(1);
  });
});

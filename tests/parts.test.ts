import { beforeAll, describe, expect, it } from 'vitest';
import { attachPoint, placePart } from '../src/chem/partOps';
import { adjacency, emptyDoc, fragments } from '../src/chem/model';
import { setAbbr } from '../src/chem/ops';
import { importText } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import { addPart, importBundle, exportBundle, removePart } from '../src/project/library';
import { newProject } from '../src/project/model';
import { structureFrom } from '../src/scheme/model';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** SMILES の * をつなぐ点にした部品 */
function part(smiles: string) {
  const d = importText(emptyDoc(), smiles).doc;
  return structureFrom(d, Object.keys(d.atoms));
}

describe('部品', () => {
  it('* か R のラベルの原子が、つなぐ点になる', () => {
    expect(attachPoint(part('*C(=O)OC(C)(C)C'))).not.toBeNull();
    expect(attachPoint(part('c1ccccc1'))).toBeNull();
    let d = importText(emptyDoc(), 'Cc1ccncc1').doc;
    const me = Object.values(d.atoms).find((a) => (adjacency(d).bondsOf.get(a.id)?.length ?? 0) === 1)!;
    d = setAbbr(d, me.id, 'R');
    const ap = attachPoint(structureFrom(d, Object.keys(d.atoms)))!;
    expect(d.atoms[ap.star].abbr).toBe('R');
  });

  it('原子をクリックすると、空いている向きに結合1本でつなぐ（つなぐ点は置かない）', () => {
    const d0 = importText(emptyDoc(), 'NCC').doc;
    const n = Object.values(d0.atoms).find((a) => a.element === 'N')!;
    const { doc, ids } = placePart(d0, part('*C(=O)OC(C)(C)C'), { kind: 'atom', id: n.id });
    expect(canonical(docToSmiles(doc).smiles!)).toBe(canonical('CCNC(=O)OC(C)(C)C'));
    expect(fragments(doc)).toHaveLength(1);
    expect(Object.values(doc.atoms).some((a) => a.element === '*')).toBe(false);
    // 新しい結合の長さは結合長、置いた原子は既存の原子と重ならない
    const nb = Object.values(doc.bonds).find((b) => (b.a1 === n.id || b.a2 === n.id) && ids.has(b.id))!;
    const other = doc.atoms[nb.a1 === n.id ? nb.a2 : nb.a1];
    expect(Math.hypot(other.x - n.x, other.y - n.y)).toBeCloseTo(14.4, 1);
    for (const id of ids) {
      const a = doc.atoms[id];
      if (!a) continue;
      for (const b of Object.values(d0.atoms)) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(8);
    }
  });

  it('何もない所に置くと、つなぐ点を除いて置く', () => {
    const { doc } = placePart(emptyDoc(), part('*C(=O)OC(C)(C)C'), { kind: 'blank', p: { x: 100, y: 100 } });
    expect(canonical(docToSmiles(doc).smiles!)).toBe(canonical('O=COC(C)(C)C'));
    const { doc: d2 } = placePart(emptyDoc(), part('c1ccccc1'), { kind: 'blank', p: { x: 0, y: 0 } });
    expect(docToSmiles(d2).smiles).toBe('c1ccccc1');
  });

  it('プロジェクトに部品を足し・消し、一式の JSON に入る', () => {
    const d = importText(emptyDoc(), '*C(=O)OCc1ccccc1').doc;
    let { project, id } = addPart(newProject('p'), 'Cbz', d, Object.keys(d.atoms));
    expect(project.parts![id].name).toBe('Cbz');
    expect(Object.keys(importBundle(exportBundle(project)).parts!)).toEqual([id]);
    project = removePart(project, id);
    expect(project.parts).toEqual({});
    // 部品の無い古い一式も読める
    const old = JSON.stringify({ format: 'ai-chem-editor-project', version: 1, project: { ...newProject('x'), parts: undefined } });
    expect(importBundle(old).parts).toEqual({});
  });
});

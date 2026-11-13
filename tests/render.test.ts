import { beforeAll, describe, expect, it } from 'vitest';
import { dot, norm, sub, type P } from '../src/chem/geometry';
import { emptyDoc } from '../src/chem/model';
import { addSmiles } from '../src/io/smiles';
import { layout } from '../src/render/layout';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** 環の二重結合の、内側の線の両端の縮み（結合の端から、結合の向きに測った長さ） */
function innerTrims(smiles: string): number[][] {
  const { doc } = addSmiles(emptyDoc(), smiles, { x: 0, y: 0 });
  const lay = layout(doc);
  return Object.values(doc.bonds)
    .filter((b) => b.order === 2 && Object.values(doc.atoms).filter((a) => a.id === b.a1 || a.id === b.a2).every((a) => a.element === 'C' || a.element === 'N'))
    .map((b) => {
      const A: P = doc.atoms[b.a1];
      const B: P = doc.atoms[b.a2];
      const d = norm(sub(B, A));
      const len = dot(sub(B, A), d);
      const lines = lay.prims.filter((p) => p.k === 'line' && p.owner === b.id) as { a: P; b: P }[];
      // 結合そのものでない方（内側の線）
      const inner = lines.find((l) => Math.abs(l.a.x - A.x) + Math.abs(l.a.y - A.y) > 0.01 || Math.abs(l.b.x - B.x) + Math.abs(l.b.y - B.y) > 0.01)!;
      const t1 = dot(sub(inner.a, A), d);
      const t2 = len - dot(sub(inner.b, A), d);
      return [+t1.toFixed(2), +t2.toFixed(2)];
    });
}

describe('環の二重結合の内側の線', () => {
  it.each([
    ['シクロヘキセノン', 'O=C1C=CCCC1'],
    ['N-メチルピロール', 'Cn1cccc1'],
    ['ベンゼン', 'c1ccccc1'],
  ])('%s: 両端を同じだけ縮め、角からはみ出さない', (_, smiles) => {
    const trims = innerTrims(smiles);
    expect(trims.length).toBeGreaterThan(0);
    for (const [t1, t2] of trims) {
      expect(t1).toBeGreaterThan(0.5);
      expect(t2).toBeGreaterThan(0.5);
      expect(Math.abs(t1 - t2)).toBeLessThan(0.05);
    }
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { add, angleOf, dist, fromAngle, sub } from '../src/chem/geometry';
import { emptyDoc, type Doc } from '../src/chem/model';
import { bondAtPoint, clickBond, extendFromAtom, setElement, snapBondEnd, drawBond } from '../src/chem/ops';
import { BOND_LEN } from '../src/chem/style';
import { canonical, docToSmiles } from '../src/io/smiles';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const last = (doc: Doc) => Object.values(doc.atoms).at(-1)!;
const deg = (r: number) => (r * 180) / Math.PI;

describe('結合ツール', () => {
  it('何もない所をクリックすると右上30°に結合が1本できる', () => {
    const d = bondAtPoint(emptyDoc(), { x: 100, y: 100 }, 'single');
    const [a, b] = Object.values(d.atoms);
    expect(Object.keys(d.bonds)).toHaveLength(1);
    expect(dist(a, b)).toBeCloseTo(BOND_LEN);
    expect(deg(angleOf(sub(b, a)))).toBeCloseTo(-30);
  });

  it('末端の原子をクリックし続けると、120°のジグザグ鎖になる', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    for (let i = 0; i < 4; i++) d = extendFromAtom(d, last(d).id, 'single');
    const atoms = Object.values(d.atoms);
    expect(atoms).toHaveLength(6);
    for (let i = 1; i + 1 < atoms.length; i++) {
      const v1 = sub(atoms[i - 1], atoms[i]);
      const v2 = sub(atoms[i + 1], atoms[i]);
      const ang = Math.acos((v1.x * v2.x + v1.y * v2.y) / (BOND_LEN * BOND_LEN));
      expect(deg(ang)).toBeCloseTo(120);
    }
    // ジグザグ: 1つおきの原子が同じ高さ
    expect(atoms[0].y).toBeCloseTo(atoms[2].y);
    expect(atoms[1].y).toBeCloseTo(atoms[3].y);
    expect(atoms[5].x).toBeGreaterThan(atoms[0].x);
    expect(canonical(docToSmiles(d).smiles!)).toBe(canonical('CCCCCC'));
  });

  it('ドラッグの向きは30°刻みにそろう', () => {
    const start = { x: 0, y: 0 };
    const end = snapBondEnd(emptyDoc(), start, add(start, fromAngle((50 * Math.PI) / 180, 30)));
    expect(deg(angleOf(sub(end, start)))).toBeCloseTo(60);
    expect(dist(start, end)).toBeCloseTo(BOND_LEN);
  });

  it('既存の結合をクリックすると 単→二→三→単 と変わる', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    const id = Object.keys(d.bonds)[0];
    d = clickBond(d, id, 'single');
    expect(d.bonds[id].order).toBe(2);
    d = clickBond(d, id, 'single');
    expect(d.bonds[id].order).toBe(3);
    d = clickBond(d, id, 'single');
    expect(d.bonds[id].order).toBe(1);
  });

  it('同じくさびでクリックすると向きが反転する', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'wedge');
    const id = Object.keys(d.bonds)[0];
    const a1 = d.bonds[id].a1;
    d = clickBond(d, id, 'wedge');
    expect(d.bonds[id].a2).toBe(a1);
    d = clickBond(d, id, 'hash');
    expect(d.bonds[id].stereo).toBe('hash');
  });

  it('終点が既存の原子の近くなら、その原子につなぐ（環を閉じる）', () => {
    const pts = Array.from({ length: 6 }, (_, i) => fromAngle((i * Math.PI) / 3, BOND_LEN));
    let d = drawBond(emptyDoc(), pts[0], pts[1], 'single');
    for (let i = 1; i < 5; i++) d = drawBond(d, last(d).id, pts[i + 1], 'single');
    expect(Object.keys(d.atoms)).toHaveLength(6);
    // 最初の原子の少し横で離しても、最初の原子につながる
    d = drawBond(d, last(d).id, add(pts[0], { x: 1.5, y: 1 }), 'single');
    expect(Object.keys(d.atoms)).toHaveLength(6);
    expect(Object.keys(d.bonds)).toHaveLength(6);
    expect(canonical(docToSmiles(d).smiles!)).toBe('C1CCCCC1');
  });

  it('原子の元素を変えると水素は SMILES で自動的に付く', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    d = setElement(d, last(d).id, 'O');
    expect(canonical(docToSmiles(d).smiles!)).toBe('CO');
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { contractGroup, expandAbbr } from '../src/chem/abbrOps';
import { dist } from '../src/chem/geometry';
import { emptyDoc, type Doc } from '../src/chem/model';
import { bondAtPoint, setAbbr } from '../src/chem/ops';
import { placeRing } from '../src/chem/ringOps';
import { BOND_LEN } from '../src/chem/style';
import { extract, flipSelection, insertDoc, mergeOverlaps, moveSelection, rotateSelection } from '../src/chem/transform';
import { canonical, docToSmiles } from '../src/io/smiles';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const smi = (d: Doc) => canonical(docToSmiles(d).smiles!);
const bondIds = (d: Doc) => Object.keys(d.bonds);
/** 2つの原子がどちらも ring に入っていない結合（縮環の相手に使う） */
const bondNotIn = (d: Doc, before: Doc) => bondIds(d).filter((id) => !before.bonds[id]);

describe('環テンプレート', () => {
  it('3〜8員環を置ける', () => {
    for (const n of [3, 4, 5, 6, 7, 8] as const) {
      const d = placeRing(emptyDoc(), n, { kind: 'blank', p: { x: 100, y: 100 } });
      expect(Object.keys(d.atoms)).toHaveLength(n);
      expect(smi(d)).toBe(canonical(`C1${'C'.repeat(n - 1)}1`));
      for (const b of Object.values(d.bonds)) expect(dist(d.atoms[b.a1], d.atoms[b.a2])).toBeCloseTo(BOND_LEN);
    }
  });

  it('ベンゼンは二重結合が交互に入る', () => {
    const d = placeRing(emptyDoc(), 'benzene', { kind: 'blank', p: { x: 100, y: 100 } });
    expect(smi(d)).toBe('c1ccccc1');
  });

  it('結合に縮環すると、原子を共有して外側に環ができる（ナフタレン）', () => {
    const b1 = placeRing(emptyDoc(), 'benzene', { kind: 'blank', p: { x: 100, y: 100 } });
    const shared = Object.values(b1.bonds).find((b) => b.order === 1)!;
    const d = placeRing(b1, 'benzene', { kind: 'bond', id: shared.id });
    expect(Object.keys(d.atoms)).toHaveLength(10);
    expect(smi(d)).toBe(canonical('c1ccc2ccccc2c1'));
    // 二重結合の上に縮環しても正しいケクレ構造になる
    const dbl = Object.values(b1.bonds).find((b) => b.order === 2)!;
    expect(smi(placeRing(b1, 'benzene', { kind: 'bond', id: dbl.id }))).toBe(canonical('c1ccc2ccccc2c1'));
  });

  it('原子をクリックすると、その原子を共有する環（置換基・スピロ）になる', () => {
    let d = bondAtPoint(emptyDoc(), { x: 50, y: 50 }, 'single');
    const end = Object.values(d.atoms)[1];
    d = placeRing(d, 'benzene', { kind: 'atom', id: end.id });
    expect(smi(d)).toBe(canonical('Cc1ccccc1'));
    const c6 = placeRing(emptyDoc(), 6, { kind: 'blank', p: { x: 100, y: 100 } });
    const spiro = placeRing(c6, 5, { kind: 'atom', id: Object.keys(c6.atoms)[0] });
    expect(smi(spiro)).toBe(canonical('C1CCC2(CC1)CCCC2'));
  });

  it('6-8-6-4 の縮環（タキサン骨格の環の部分）を描ける', () => {
    const a = placeRing(emptyDoc(), 6, { kind: 'blank', p: { x: 100, y: 100 } });
    const right = Object.values(a.bonds).sort((p, q) => (a.atoms[q.a1].x + a.atoms[q.a2].x) - (a.atoms[p.a1].x + a.atoms[p.a2].x))[0];
    const b = placeRing(a, 8, { kind: 'bond', id: right.id });
    const newB = bondNotIn(b, a);
    const far = newB.sort((p, q) => (b.atoms[b.bonds[q].a1].x + b.atoms[b.bonds[q].a2].x) - (b.atoms[b.bonds[p].a1].x + b.atoms[b.bonds[p].a2].x))[0];
    const c = placeRing(b, 6, { kind: 'bond', id: far });
    expect(Object.keys(c.atoms)).toHaveLength(6 + 6 + 4);
    // 原子が重ならない
    const as = Object.values(c.atoms);
    for (let i = 0; i < as.length; i++) for (let j = i + 1; j < as.length; j++) expect(dist(as[i], as[j])).toBeGreaterThan(BOND_LEN * 0.5);
    const c4bond = bondNotIn(c, b)[2];
    const d = placeRing(c, 4, { kind: 'bond', id: c4bond });
    expect(Object.keys(d.atoms)).toHaveLength(18);
    expect(smi(d)).not.toBeNull();
  });

  it('椅子形シクロヘキサン', () => {
    const d = placeRing(emptyDoc(), 'chair', { kind: 'blank', p: { x: 100, y: 100 } });
    expect(smi(d)).toBe('C1CCCCC1');
    const lens = Object.values(d.bonds).map((b) => dist(d.atoms[b.a1], d.atoms[b.a2]));
    expect(lens.reduce((s, x) => s + x, 0) / lens.length).toBeCloseTo(BOND_LEN);
  });
});

describe('略号', () => {
  it('展開と縮約を往復できる', () => {
    let d = bondAtPoint(emptyDoc(), { x: 50, y: 50 }, 'single');
    const end = Object.values(d.atoms)[1];
    d = setAbbr(d, end.id, 'Boc');
    expect(smi(d)).toBe(canonical('CC(=O)OC(C)(C)C'));
    const ex = expandAbbr(d, end.id);
    expect(Object.keys(ex.atoms)).toHaveLength(8);
    expect(smi(ex)).toBe(canonical('CC(=O)OC(C)(C)C'));
    // 展開した原子は結合長がそろい、元の原子と重ならない
    for (const b of Object.values(ex.bonds)) expect(dist(ex.atoms[b.a1], ex.atoms[b.a2])).toBeCloseTo(BOND_LEN, 0);
    const back = contractGroup(ex, Object.keys(ex.groups)[0]);
    expect(Object.keys(back.atoms)).toHaveLength(2);
    expect(back.atoms[end.id].abbr).toBe('Boc');
  });

  it.each([
    ['Me', 'CC'], ['Et', 'CCC'], ['Ph', 'Cc1ccccc1'], ['Bn', 'CCc1ccccc1'], ['Ac', 'CC(C)=O'],
    ['Cbz', 'CC(=O)OCc1ccccc1'], ['Fmoc', 'CC(=O)OCC1c2ccccc2-c2ccccc21'], ['TBS', 'C[Si](C)(C)C(C)(C)C'],
    ['Ts', 'Cc1ccc(S(C)(=O)=O)cc1'], ['NO2', 'C[N+](=O)[O-]'], ['CO2Me', 'COC(C)=O'],
  ])('%s', (abbr, expected) => {
    let d = bondAtPoint(emptyDoc(), { x: 50, y: 50 }, 'single');
    d = setAbbr(d, Object.values(d.atoms)[1].id, abbr);
    expect(smi(d)).toBe(canonical(expected));
  });
});

describe('選択の編集', () => {
  const benzene = () => placeRing(emptyDoc(), 'benzene', { kind: 'blank', p: { x: 100, y: 100 } });
  it('移動・回転・反転しても構造は変わらない', () => {
    const d = benzene();
    const all = new Set(Object.keys(d.atoms));
    expect(smi(moveSelection(d, all, { x: 10, y: 5 }))).toBe('c1ccccc1');
    const r = rotateSelection(d, all, Math.PI / 6, { x: 100, y: 100 });
    expect(smi(r)).toBe('c1ccccc1');
    const f = flipSelection(d, all, 'h');
    expect(smi(f)).toBe('c1ccccc1');
  });

  it('コピーして貼り付けると、別の分子として増える', () => {
    const d = benzene();
    const part = extract(d, new Set(Object.keys(d.atoms)));
    const { doc } = insertDoc(d, part, { x: 60, y: 0 });
    expect(smi(doc)).toBe('c1ccccc1.c1ccccc1');
  });

  it('動かした原子が別の原子に重なると1つにまとまる', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    d = bondAtPoint(d, { x: 50, y: 0 }, 'single');
    const [, a2, a3] = Object.values(d.atoms);
    const moved = moveSelection(d, [a3.id], { x: a2.x - a3.x, y: a2.y - a3.y });
    expect(smi(mergeOverlaps(moved, new Set([a3.id])))).toBe('CCC');
  });
});

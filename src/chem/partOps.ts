// 部品（プロジェクトの母核・保護基など）を置く。つなぐ点（R の原子）があれば、クリックした原子につなぐ
import { add, angleOf, fromAngle, rotate, sub, type P } from './geometry';
import { isRGroup } from './label';
import type { Doc } from './model';
import { adjacency, edit, newId, remapUnits } from './model';
import { BOND_LEN } from './style';
import { freeDirection } from '../render/labels';
import type { Structure } from '../scheme/model';
import type { Prim } from '../render/layout';

export type PartTarget = { kind: 'blank'; p: P } | { kind: 'atom'; id: string };

/** つなぐ点（R・R1 のラベルか、元素の決まっていない原子で、結合が1本のもの）と、その隣の原子 */
export function attachPoint(s: Structure): { star: string; anchor: string; bondId: string } | null {
  for (const a of Object.values(s.atoms)) {
    const pseudo = (a.abbr && isRGroup(a.abbr)) || (a.element === '*' && !a.abbr);
    if (!pseudo) continue;
    const bonds = Object.values(s.bonds).filter((b) => b.a1 === a.id || b.a2 === a.id);
    if (bonds.length !== 1) continue;
    return { star: a.id, anchor: bonds[0].a1 === a.id ? bonds[0].a2 : bonds[0].a1, bondId: bonds[0].id };
  }
  return null;
}

/** 部品の原子を置く位置（つなぐ点は除く）。原子につなぐなら、空いている向きへ伸ばす */
function partPositions(doc: Doc, s: Structure, target: PartTarget): { pos: Map<string, P>; attach: { star: string; anchor: string; bondId: string; to: string } | null } {
  const ap = attachPoint(s);
  const pos = new Map<string, P>();
  const atoms = Object.values(s.atoms);
  if (target.kind === 'atom' && ap && doc.atoms[target.id]) {
    const A = doc.atoms[target.id];
    const dir = freeDirection(A, doc, adjacency(doc));
    const anchorAt = add(A, fromAngle(dir, BOND_LEN));
    const anchor = s.atoms[ap.anchor];
    // 部品の中の「隣 → つなぐ点」の向きを、「置く隣 → クリックした原子」の向きに合わせる
    const theta = dir + Math.PI - angleOf(sub(s.atoms[ap.star], anchor));
    for (const a of atoms) {
      if (a.id === ap.star) continue;
      pos.set(a.id, add(rotate(sub(a, anchor), theta), anchorAt));
    }
    return { pos, attach: { ...ap, to: target.id } };
  }
  const p = target.kind === 'blank' ? target.p : doc.atoms[target.id] ?? { x: 0, y: 0 };
  // 置き場所は構造の中心（つなぐ点を除く）
  const rest = atoms.filter((a) => a.id !== ap?.star);
  const cx = rest.reduce((t, a) => t + a.x, 0) / Math.max(1, rest.length);
  const cy = rest.reduce((t, a) => t + a.y, 0) / Math.max(1, rest.length);
  for (const a of rest) pos.set(a.id, { x: a.x - cx + p.x, y: a.y - cy + p.y });
  return { pos, attach: null };
}

/** 部品を置く。つなぐ点は置かない（何もない所なら、隣の原子は水素で埋まる） */
export function placePart(doc: Doc, s: Structure, target: PartTarget): { doc: Doc; ids: Set<string> } {
  const { pos, attach } = partPositions(doc, s, target);
  const ap = attach ?? attachPoint(s);
  const ids = new Set<string>();
  const out = edit(doc, (d) => {
    const map = new Map<string, string>();
    for (const a of Object.values(s.atoms)) {
      const p = pos.get(a.id);
      if (!p) continue;
      const id = newId(d, 'a');
      map.set(a.id, id);
      const { ref: _r, lib: _l, ...rest } = a;
      void _r;
      void _l;
      d.atoms[id] = { ...rest, id, x: p.x, y: p.y };
      ids.add(id);
    }
    remapUnits([...map.values()].map((id) => d.atoms[id]), () => newId(d, 'u'));
    for (const b of Object.values(s.bonds)) {
      if (!map.has(b.a1) || !map.has(b.a2)) continue;
      const id = newId(d, 'b');
      d.bonds[id] = { ...b, id, a1: map.get(b.a1)!, a2: map.get(b.a2)! };
      ids.add(id);
    }
    for (const g of Object.values(s.groups)) {
      if (!g.atomIds.every((x) => map.has(x))) continue;
      const id = newId(d, 'g');
      d.groups[id] = { ...g, id, atomIds: g.atomIds.map((x) => map.get(x)!), attachId: map.get(g.attachId)! };
    }
    if (attach && ap) {
      const sb = s.bonds[ap.bondId];
      const id = newId(d, 'b');
      d.bonds[id] = { id, a1: attach.to, a2: map.get(ap.anchor)!, order: sb.order, stereo: 'none', doublePos: 'auto' };
      ids.add(id);
    }
  });
  return { doc: out, ids };
}

/** 置く前のプレビュー（結合の線） */
export function partPreview(doc: Doc, s: Structure, p: P, hit: string | null): Prim[] {
  const target: PartTarget = hit && doc.atoms[hit] ? { kind: 'atom', id: hit } : { kind: 'blank', p };
  const { pos, attach } = partPositions(doc, s, target);
  const prims: Prim[] = [];
  for (const b of Object.values(s.bonds)) {
    const a = pos.get(b.a1);
    const c = pos.get(b.a2);
    if (a && c) prims.push({ k: 'line', a, b: c, w: 0.6, owner: '' });
  }
  if (attach) prims.push({ k: 'line', a: doc.atoms[attach.to], b: pos.get(attach.anchor)!, w: 0.6, owner: '' });
  return prims;
}

// 編集の操作。どれも doc を受け取り、新しい doc を返す（元は変えない）。
import {
  add, angleOf, dist, fromAngle, normAngle, sideOf, snapAngle, sub, type P,
} from './geometry';
import type { Atom, Bond, BondOrder, BondStereo, Doc } from './model';
import { adjacency, edit, findBond, neighbors, newId, otherEnd } from './model';
import { BOND_LEN } from './style';

export type BondTool = 'single' | 'double' | 'triple' | 'wedge' | 'hash' | 'wavy' | 'bold' | 'dashed' | 'dative';

/** 原子を同じ場所とみなす距離 */
export const MERGE_DIST = BOND_LEN * 0.25;

export function bondSpec(tool: BondTool): { order: BondOrder; stereo: BondStereo } {
  switch (tool) {
    case 'double':
      return { order: 2, stereo: 'none' };
    case 'triple':
      return { order: 3, stereo: 'none' };
    case 'wedge':
    case 'hash':
    case 'wavy':
    case 'bold':
    case 'dashed':
    case 'dative':
      return { order: 1, stereo: tool };
    default:
      return { order: 1, stereo: 'none' };
  }
}

export function atomAt(doc: Doc, p: P, tol = MERGE_DIST, exclude?: Set<string>): Atom | undefined {
  let best: Atom | undefined;
  let bd = tol;
  for (const a of Object.values(doc.atoms)) {
    if (exclude?.has(a.id)) continue;
    const dd = dist(a, p);
    if (dd <= bd) {
      bd = dd;
      best = a;
    }
  }
  return best;
}

export function addAtom(d: Doc, p: P, element = 'C'): Atom {
  const a: Atom = { id: newId(d, 'a'), x: p.x, y: p.y, element, charge: 0 };
  d.atoms[a.id] = a;
  return a;
}

/** a1-a2 の結合を足す（既にあれば何もしない）。書き換え用の d に対して使う */
export function addBondIn(d: Doc, a1: string, a2: string, order: BondOrder = 1, stereo: BondStereo = 'none'): Bond | undefined {
  if (a1 === a2) return undefined;
  const ex = findBond(d, a1, a2);
  if (ex) return ex;
  const b: Bond = { id: newId(d, 'b'), a1, a2, order, stereo, doublePos: 'auto' };
  d.bonds[b.id] = b;
  return b;
}

/** 原子 p から新しい結合を伸ばす向き（ChemDraw と同じく、鎖はジグザグに 120° で伸ばす） */
export function autoDirection(doc: Doc, atomId: string): number {
  const adj = adjacency(doc);
  const a = doc.atoms[atomId];
  const ns = neighbors(adj, atomId);
  if (ns.length === 0) return -Math.PI / 6;
  if (ns.length === 1) {
    const nb = doc.atoms[ns[0]];
    const base = angleOf(sub(nb, a));
    const c1 = normAngle(base + (2 * Math.PI) / 3);
    const c2 = normAngle(base - (2 * Math.PI) / 3);
    const p1 = add(a, fromAngle(c1, BOND_LEN));
    const p2 = add(a, fromAngle(c2, BOND_LEN));
    // 伸ばした先が混んでいる（既存の原子が結合1本ぶんより近い）向きは避ける
    const k1 = crowd(doc, atomId, p1);
    const k2 = crowd(doc, atomId, p2);
    if (k1 !== k2) return k1 < k2 ? c1 : c2;
    // 隣の原子のさらに隣と反対側（トランス）に伸ばすとジグザグになる
    const nn = neighbors(adj, ns[0]).filter((x) => x !== atomId);
    if (nn.length > 0) {
      const ref = doc.atoms[nn[0]];
      const sRef = sideOf(ref, nb, a);
      const s1 = sideOf(p1, nb, a);
      return s1 * sRef < 0 ? c1 : c2;
    }
    // 隣が末端なら、右へ（同じなら上へ）進む向き
    if (Math.abs(p1.x - p2.x) > 0.01) return p1.x > p2.x ? c1 : c2;
    return p1.y < p2.y ? c1 : c2;
  }
  // 隙間の真ん中の向きのうち、混んでいない向き（同じなら広い隙間）
  const angs = ns.map((n) => angleOf(sub(doc.atoms[n], a))).sort((x, y) => x - y);
  const cands: { ang: number; gap: number; crowd: number }[] = [];
  for (let i = 0; i < angs.length; i++) {
    const s = angs[i];
    const e = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
    const ang = s + (e - s) / 2;
    cands.push({ ang, gap: e - s, crowd: crowd(doc, atomId, add(a, fromAngle(ang, BOND_LEN))) });
  }
  cands.sort((x, y) => x.crowd - y.crowd || y.gap - x.gap);
  // 狭すぎる隙間（90° 未満）には入れない
  const pick = cands.find((c) => c.gap >= Math.PI / 2 - 1e-6) ?? cands[0];
  return normAngle(pick.ang);
}

/** p の近く（結合1本ぶん）にある、atomId とその隣以外の原子の数 */
function crowd(doc: Doc, atomId: string, p: P): number {
  const adj = adjacency(doc);
  const skip = new Set([atomId, ...neighbors(adj, atomId)]);
  let n = 0;
  for (const o of Object.values(doc.atoms)) if (!skip.has(o.id) && dist(o, p) < BOND_LEN * 1.05) n++;
  return n;
}

/**
 * 結合を1本描く。from は既存の原子 id か点、to は点（既存の原子の近くなら、その原子へつなぐ）。
 */
export function drawBond(doc: Doc, from: string | P, to: P, tool: BondTool): Doc {
  return edit(doc, (d) => {
    const spec = bondSpec(tool);
    const a1 = typeof from === 'string' ? d.atoms[from] : (atomAt(d, from) ?? addAtom(d, from));
    const target = atomAt(d, to, MERGE_DIST, new Set([a1.id]));
    const a2 = target ?? addAtom(d, to);
    const ex = findBond(d, a1.id, a2.id);
    if (ex) return;
    addBondIn(d, a1.id, a2.id, spec.order, spec.stereo);
  });
}

/** 原子をクリックしたとき: 自動の向きに結合を1本伸ばす */
export function extendFromAtom(doc: Doc, atomId: string, tool: BondTool): Doc {
  const a = doc.atoms[atomId];
  const to = add(a, fromAngle(autoDirection(doc, atomId), BOND_LEN));
  return drawBond(doc, atomId, to, tool);
}

/** 何もない所をクリックしたとき: 右上 30° に結合を1本描く */
export function bondAtPoint(doc: Doc, p: P, tool: BondTool): Doc {
  return drawBond(doc, p, add(p, fromAngle(-Math.PI / 6, BOND_LEN)), tool);
}

/** ドラッグの終点から、30° 刻みにそろえた結合の終点を求める（近くに原子があればそこへ） */
export function snapBondEnd(doc: Doc, start: P, cursor: P, startAtomId?: string): P {
  const near = atomAt(doc, cursor, MERGE_DIST * 1.6, startAtomId ? new Set([startAtomId]) : undefined);
  if (near) return { x: near.x, y: near.y };
  const ang = snapAngle(angleOf(sub(cursor, start)), Math.PI / 6);
  return add(start, fromAngle(ang, BOND_LEN));
}

/** 既存の結合をクリックしたとき */
export function clickBond(doc: Doc, bondId: string, tool: BondTool): Doc {
  return edit(doc, (d) => {
    const b = d.bonds[bondId];
    const spec = bondSpec(tool);
    if (tool === 'single') {
      if (b.stereo !== 'none') {
        b.stereo = 'none';
        b.order = 1;
      } else {
        b.order = ((b.order % 3) + 1) as BondOrder;
      }
    } else if (tool === 'double') {
      if (b.order !== 2 || b.stereo !== 'none') {
        b.order = 2;
        b.stereo = 'none';
      } else {
        // 二重結合をもう一度クリックすると、線の位置を 自動→中央→右→左 と切り替える
        const cycle = ['auto', 'center', 'right', 'left'] as const;
        b.doublePos = cycle[(cycle.indexOf(b.doublePos) + 1) % cycle.length];
      }
    } else if (spec.stereo !== 'none' && b.stereo === spec.stereo && tool !== 'wavy') {
      // 同じくさびをクリックすると向きが反転する
      [b.a1, b.a2] = [b.a2, b.a1];
    } else {
      b.order = spec.order;
      b.stereo = spec.stereo;
    }
  });
}

export function setBondOrder(doc: Doc, bondId: string, order: BondOrder, stereo: BondStereo = 'none'): Doc {
  return edit(doc, (d) => {
    d.bonds[bondId].order = order;
    d.bonds[bondId].stereo = stereo;
  });
}

export function setElement(doc: Doc, atomId: string, element: string): Doc {
  return edit(doc, (d) => {
    const a = d.atoms[atomId];
    a.element = element;
    delete a.abbr;
    delete a.salt;
  });
}

export function setAbbr(doc: Doc, atomId: string, abbr: string): Doc {
  return edit(doc, (d) => {
    const a = d.atoms[atomId];
    a.element = '*';
    a.abbr = abbr;
    a.charge = 0;
    delete a.salt;
  });
}

export function changeCharge(doc: Doc, atomId: string, delta: number): Doc {
  return edit(doc, (d) => {
    d.atoms[atomId].charge += delta;
  });
}

/** 選んだ物の色を変える（undefined で黒に戻す）。原子を選んでいれば、その原子どうしの結合も同じ色にする */
export function setColor(doc: Doc, ids: Iterable<string>, color: string | undefined): Doc {
  const set = new Set(ids);
  return edit(doc, (d) => {
    for (const b of Object.values(d.bonds)) if (set.has(b.a1) && set.has(b.a2)) set.add(b.id);
    for (const rec of [d.atoms, d.bonds, d.arrows, d.texts, d.pluses, d.shapes ?? {}] as Record<string, { color?: string }>[]) {
      for (const id of set) {
        const o = rec[id];
        if (!o) continue;
        if (color) o.color = color;
        else delete o.color;
      }
    }
  });
}

/** 原子・結合・図形を消す。結合を消して孤立した炭素も消す（ChemDraw と同じ） */
export function deleteItems(doc: Doc, ids: Iterable<string>): Doc {
  return edit(doc, (d) => {
    const set = new Set(ids);
    const touched = new Set<string>();
    for (const id of set) {
      if (d.atoms[id]) delete d.atoms[id];
      else if (d.bonds[id]) {
        touched.add(d.bonds[id].a1);
        touched.add(d.bonds[id].a2);
        delete d.bonds[id];
      } else if (d.arrows[id]) delete d.arrows[id];
      else if (d.texts[id]) delete d.texts[id];
      else if (d.pluses[id]) delete d.pluses[id];
      else if (d.shapes?.[id]) delete d.shapes[id];
    }
    for (const b of Object.values(d.bonds)) {
      if (!d.atoms[b.a1] || !d.atoms[b.a2]) {
        touched.add(b.a1);
        touched.add(b.a2);
        delete d.bonds[b.id];
      }
    }
    const adj = adjacency(d);
    for (const id of touched) {
      const a = d.atoms[id];
      if (a && a.element === 'C' && !a.abbr && !a.charge && (adj.bondsOf.get(id)?.length ?? 0) === 0) delete d.atoms[id];
    }
    for (const g of Object.values(d.groups)) {
      if (g.atomIds.some((x) => !d.atoms[x])) delete d.groups[g.id];
    }
  });
}

export { otherEnd };

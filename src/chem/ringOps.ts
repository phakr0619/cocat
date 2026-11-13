// 環テンプレート: 何もない所・原子・結合をクリックして環を置く（原子・結合を共有して縮環する）
import { add, angleOf, dist, dot, fromAngle, mid, mul, rightNormal, norm, rotate, snapAngle, sub, type P } from './geometry';
import type { Doc } from './model';
import { adjacency, edit, findBond, neighbors } from './model';
import { addAtom, addBondIn, atomAt, autoDirection, MERGE_DIST } from './ops';
import { smallestRings } from './rings';
import { BOND_LEN } from './style';

export type RingKind = 3 | 4 | 5 | 6 | 7 | 8 | 'benzene' | 'chair';

export type RingTarget = { kind: 'blank'; p: P } | { kind: 'atom'; id: string } | { kind: 'bond'; id: string };

/**
 * 環を置くときに、押したまま動かした先。
 * 何もない所では環を回す向き、原子からは環を出す向き、結合からは縮環する側を決める。free でなければ角度は 15° 刻み
 */
export type RingAim = { p: P; free?: boolean };

const AIM_STEP = Math.PI / 12;
/** 基点から aim への角度（15° 刻み。free なら刻まない） */
const aimAngle = (from: P, aim: RingAim) => {
  const a = angleOf(sub(aim.p, from));
  return aim.free ? a : snapAngle(a, AIM_STEP);
};
const centroid = (ps: P[]) => mul(ps.reduce((s, q) => add(s, q), { x: 0, y: 0 }), 1 / ps.length);

const circumR = (n: number) => BOND_LEN / (2 * Math.sin(Math.PI / n));
const apothem = (n: number) => BOND_LEN / (2 * Math.tan(Math.PI / n));

/**
 * 椅子形シクロヘキサンの頂点。立体の椅子形を斜め上から見た投影で作る（左の端が下、右の端が上）。
 * 辺の長さの平均が結合長になるようにそろえ、中心を origin に置く。
 */
export function chairPoints(origin: P): P[] {
  const h = 0.35;
  const tilt = 0.35;
  const raw: P[] = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    const z = i % 2 === 0 ? h : -h;
    return { x: -Math.cos(a), y: -z + tilt * Math.sin(a) };
  });
  let total = 0;
  for (let i = 0; i < 6; i++) total += dist(raw[i], raw[(i + 1) % 6]);
  const k = BOND_LEN / (total / 6);
  return raw.map((p) => add(origin, mul(p, k)));
}

/** 置く環の頂点。最初の頂点（と2番目）は target の原子に重なる */
export function ringVertices(doc: Doc, kind: RingKind, target: RingTarget, aim?: RingAim): P[] {
  const n = kind === 'benzene' || kind === 'chair' ? 6 : kind;
  if (kind === 'chair') {
    if (target.kind === 'blank') {
      const pts = chairPoints(target.p);
      // 何もない所: 押した所を中心に回す（真上に向けたときが今までの形）
      return aim ? pts.map((p) => add(target.p, rotate(sub(p, target.p), aimAngle(target.p, aim) + Math.PI / 2))) : pts;
    }
    const a = target.kind === 'atom' ? doc.atoms[target.id] : doc.atoms[doc.bonds[target.id].a1];
    const pts0 = chairPoints({ x: 0, y: 0 });
    const pts = pts0.map((p) => add(p, sub(a, pts0[0])));
    if (!aim || target.kind !== 'atom') return pts;
    // 原子から: 環の中心が aim の向きに来るよう、原子を中心に回す
    const turn = aimAngle(a, aim) - angleOf(sub(centroid(pts), a));
    return pts.map((p) => add(a, rotate(sub(p, a), turn)));
  }
  const R = circumR(n);
  if (target.kind === 'blank') {
    const first = aim ? aimAngle(target.p, aim) : -Math.PI / 2;
    return Array.from({ length: n }, (_, i) => add(target.p, fromAngle(first + (2 * Math.PI * i) / n, R)));
  }
  if (target.kind === 'atom') {
    const a = doc.atoms[target.id];
    const ns = neighbors(adjacency(doc), target.id);
    const dir = aim
      ? aimAngle(a, aim)
      : ns.length === 1 ? angleOf(sub(a, doc.atoms[ns[0]])) : ns.length === 0 ? Math.PI / 2 : autoDirection(doc, target.id);
    const c = add(a, fromAngle(dir, R));
    const start = dir + Math.PI;
    return Array.from({ length: n }, (_, i) => add(c, fromAngle(start + (2 * Math.PI * i) / n, R)));
  }
  const b = doc.bonds[target.id];
  const a1 = doc.atoms[b.a1];
  const a2 = doc.atoms[b.a2];
  const m = mid(a1, a2);
  const nrm = rightNormal(norm(sub(a2, a1)));
  const cR = add(m, mul(nrm, apothem(n)));
  const cL = add(m, mul(nrm, -apothem(n)));
  // 押したまま動かしたときは、カーソルのある側に縮環する
  const c = aim && dist(aim.p, m) > 0 ? (dot(sub(aim.p, m), nrm) >= 0 ? cR : cL) : chooseFuseSide(doc, target.id, cR, cL, R);
  const t0 = angleOf(sub(a1, c));
  const t1 = angleOf(sub(a2, c));
  let step = t1 - t0;
  while (step > Math.PI) step -= 2 * Math.PI;
  while (step < -Math.PI) step += 2 * Math.PI;
  return Array.from({ length: n }, (_, i) => add(c, fromAngle(t0 + i * step, R)));
}

/** 縮環する側: 原子が少ない側（同じなら、既存の環の外側） */
function chooseFuseSide(doc: Doc, bondId: string, cR: P, cL: P, R: number): P {
  const count = (c: P) => Object.values(doc.atoms).filter((a) => dist(a, c) < R * 0.95).length;
  const nr = count(cR);
  const nl = count(cL);
  if (nr !== nl) return nr < nl ? cR : cL;
  const ring = smallestRings(doc).get(bondId);
  if (ring) {
    const rc = mul(ring.reduce((s, id) => add(s, doc.atoms[id]), { x: 0, y: 0 }), 1 / ring.length);
    return dist(cR, rc) > dist(cL, rc) ? cR : cL;
  }
  // 隣の原子が多い側を避ける
  const b = doc.bonds[bondId];
  const adj = adjacency(doc);
  let sR = 0;
  let sL = 0;
  for (const id of [b.a1, b.a2]) {
    for (const nId of neighbors(adj, id)) {
      if (nId === b.a1 || nId === b.a2) continue;
      if (dist(doc.atoms[nId], cR) < dist(doc.atoms[nId], cL)) sR++;
      else sL++;
    }
  }
  if (sR !== sL) return sR < sL ? cR : cL;
  return cR.y <= cL.y ? cR : cL;
}

export function placeRing(doc: Doc, kind: RingKind, target: RingTarget, aim?: RingAim): Doc {
  const verts = ringVertices(doc, kind, target, aim);
  return edit(doc, (d) => {
    const ids: string[] = [];
    for (let i = 0; i < verts.length; i++) {
      let id: string | undefined;
      if (target.kind === 'atom' && i === 0) id = target.id;
      else if (target.kind === 'bond' && i < 2) id = i === 0 ? d.bonds[target.id].a1 : d.bonds[target.id].a2;
      else id = atomAt(d, verts[i], MERGE_DIST, new Set(ids))?.id;
      ids.push(id ?? addAtom(d, verts[i]).id);
    }
    const newEdges: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      if (findBond(d, a, b)) continue;
      const nb = addBondIn(d, a, b);
      if (nb) newEdges.push(nb.id);
    }
    if (kind === 'benzene') {
      // 隣り合わないように二重結合を置く。既に二重結合を持つ原子には付けない
      const hasDouble = (atomId: string) => Object.values(d.bonds).some((x) => x.order === 2 && (x.a1 === atomId || x.a2 === atomId));
      for (let i = 0; i < ids.length; i++) {
        const bond = findBond(d, ids[i], ids[(i + 1) % ids.length])!;
        if (!newEdges.includes(bond.id)) continue;
        if (!hasDouble(bond.a1) && !hasDouble(bond.a2)) bond.order = 2;
      }
    }
  });
}

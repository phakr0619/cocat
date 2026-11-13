// 鎖ツール: ドラッグした長さぶん、120° のジグザグ鎖を伸ばす
import { add, dot, fromAngle, sub, type P } from './geometry';
import type { Doc } from './model';
import { adjacency, edit, neighbors } from './model';
import { addAtom, addBondIn, atomAt, MERGE_DIST } from './ops';
import { BOND_LEN } from './style';

/** origin から角度 ang の向きに、長さ length ぶんのジグザグの点列 */
export function chainPoints(doc: Doc, origin: P, ang: number, length: number, fromAtomId?: string): P[] {
  const step = BOND_LEN * Math.cos(Math.PI / 6);
  const n = Math.max(1, Math.round(length / step));
  // 最初の結合を進行方向の上下どちらに振るか。既存の隣の原子と反対側（トランス）にする
  let sign = -1;
  if (fromAtomId) {
    const ns = neighbors(adjacency(doc), fromAtomId);
    if (ns.length) {
      const nb = doc.atoms[ns[0]];
      const back = sub(nb, origin);
      // 隣が進行方向の右（+90°側）にあれば、最初は左（-30°側）へ振る
      sign = dot(back, fromAngle(ang + Math.PI / 2)) > 0 ? -1 : 1;
    }
  }
  const pts: P[] = [origin];
  let cur = origin;
  for (let i = 0; i < n; i++) {
    const a = ang + (sign * (i % 2 === 0 ? 1 : -1) * Math.PI) / 6;
    cur = add(cur, fromAngle(a, BOND_LEN));
    pts.push(cur);
  }
  return pts;
}

export function addChain(doc: Doc, pts: P[], fromAtomId?: string): Doc {
  return edit(doc, (d) => {
    let prev = fromAtomId ?? (atomAt(d, pts[0])?.id ?? addAtom(d, pts[0]).id);
    for (let i = 1; i < pts.length; i++) {
      const ex = atomAt(d, pts[i], MERGE_DIST, new Set([prev]));
      const id = ex ? ex.id : addAtom(d, pts[i]).id;
      addBondIn(d, prev, id);
      prev = id;
    }
  });
}


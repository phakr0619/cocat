// 表示の外にある物を数える
import type { Rect } from '../chem/geometry';
import { molecules, type Doc } from '../chem/model';

type Pt = { x: number; y: number };

const inside = (r: Rect, p: Pt) => p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;

/**
 * 表示（文書の座標の矩形）に少しも入っていない物の数。分子は 1 つと数え、矢印・文字・＋・図形もそれぞれ 1 つと数える。
 * 物の点（原子・矢印の両端・文字の位置・図形の角）のどれも表示に入っていなければ、外にあるとみなす
 */
export function countOutside(doc: Doc, view: Rect): number {
  const groups: Pt[][] = [
    ...molecules(doc).map((ids) => ids.map((id) => doc.atoms[id])),
    ...Object.values(doc.arrows).map((a) => [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }]),
    ...Object.values(doc.texts).map((t) => [t]),
    ...Object.values(doc.pluses).map((p) => [p]),
    ...Object.values(doc.shapes ?? {}).map((s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y1 }, { x: s.x1, y: s.y2 }, { x: s.x2, y: s.y2 }]),
  ];
  return groups.filter((g) => g.length && !g.some((p) => inside(view, p))).length;
}

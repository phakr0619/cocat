// 当たり判定。カーソルの下の原子・結合・矢印・文字・＋記号を探す
import { dist, rectContains, segPointDist, inflate, type P } from '../chem/geometry';
import type { Arrow, Doc, Shape } from '../chem/model';
import type { Layout } from '../render/layout';

/** 矢印までの距離（曲がった矢印は曲線を細かく折れ線にして測る） */
export function arrowDist(r: Arrow, p: P): number {
  if (r.cx === undefined || r.cy === undefined) return segPointDist(p, { x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 });
  let best = Infinity;
  let prev = { x: r.x1, y: r.y1 };
  for (let i = 1; i <= 16; i++) {
    const t = i / 16;
    const q = { x: (1 - t) ** 2 * r.x1 + 2 * (1 - t) * t * r.cx + t * t * r.x2, y: (1 - t) ** 2 * r.y1 + 2 * (1 - t) * t * r.cy + t * t * r.y2 };
    best = Math.min(best, segPointDist(p, prev, q));
    prev = q;
  }
  return best;
}

/** 図形の線までの距離（中は当たらない。囲んだ分子を選べるように） */
export function shapeDist(s: Shape, p: P): number {
  const x1 = Math.min(s.x1, s.x2);
  const x2 = Math.max(s.x1, s.x2);
  const y1 = Math.min(s.y1, s.y2);
  const y2 = Math.max(s.y1, s.y2);
  if (s.kind === 'oval') {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = Math.max(1, (x2 - x1) / 2);
    const ry = Math.max(1, (y2 - y1) / 2);
    const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
    return Math.abs(k - 1) * Math.min(rx, ry);
  }
  const sides: [P, P][] =
    s.kind === 'rect'
      ? [[{ x: x1, y: y1 }, { x: x2, y: y1 }], [{ x: x2, y: y1 }, { x: x2, y: y2 }], [{ x: x2, y: y2 }, { x: x1, y: y2 }], [{ x: x1, y: y2 }, { x: x1, y: y1 }]]
      : [[{ x: x1, y: y1 }, { x: x1, y: y2 }], [{ x: x2, y: y1 }, { x: x2, y: y2 }]];
  return Math.min(...sides.map(([a, b]) => segPointDist(p, a, b)));
}

export const ATOM_HIT = 5.5;
export const BOND_HIT = 3.5;

export function hitTest(doc: Doc, lay: Layout, p: P): string | null {
  let best: string | null = null;
  let bd = ATOM_HIT;
  for (const a of Object.values(doc.atoms)) {
    const d = dist(a, p);
    if (d < bd) {
      bd = d;
      best = a.id;
    }
  }
  if (best) return best;
  for (const [id, l] of lay.labels) {
    if (l.boxes.some((b) => rectContains(inflate(b, 1), p))) return id;
  }
  bd = BOND_HIT;
  for (const b of Object.values(doc.bonds)) {
    const d = segPointDist(p, doc.atoms[b.a1], doc.atoms[b.a2]);
    if (d < bd) {
      bd = d;
      best = b.id;
    }
  }
  if (best) return best;
  for (const [id, box] of lay.textBoxes) if (rectContains(inflate(box, 1.5), p)) return id;
  for (const pl of Object.values(doc.pluses)) if (dist(pl, p) < 5) return pl.id;
  bd = 4;
  for (const s of Object.values(doc.shapes ?? {})) {
    const d = shapeDist(s, p);
    if (d < bd) {
      bd = d;
      best = s.id;
    }
  }
  for (const r of Object.values(doc.arrows)) {
    const d = arrowDist(r, p);
    if (d < bd) {
      bd = d;
      best = r.id;
    }
  }
  return best;
}

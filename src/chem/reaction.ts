// 反応スキームの解析: 矢印ごとに、反応物・生成物・矢印の上下の物・＋記号を決める。
// 矢印は左から右へ一列に並ぶものとして扱う（多段階でもよい）。
import { dot, norm, rectOfPoints, rightNormal, sub, type P, type Rect } from './geometry';
import type { Doc } from './model';
import { adjacency, molecules } from './model';
import { BOND_LEN } from './style';

export interface SchemeObject {
  /** 分子なら 'frag:<番号>'、それ以外は図形の id */
  key: string;
  kind: 'fragment' | 'text' | 'plus';
  atomIds: string[];
  id?: string;
  center: P;
  box: Rect;
}

export interface Step {
  arrowId: string;
  reactants: SchemeObject[];
  products: SchemeObject[];
  above: SchemeObject[];
  below: SchemeObject[];
  pluses: SchemeObject[];
}

export function schemeObjects(doc: Doc, textBoxes?: Map<string, Rect>): SchemeObject[] {
  const out: SchemeObject[] = [];
  molecules(doc, adjacency(doc)).forEach((f, i) => {
    const box = rectOfPoints(f.map((id) => doc.atoms[id]))!;
    out.push({ key: `frag:${i}`, kind: 'fragment', atomIds: f, center: { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }, box });
  });
  for (const t of Object.values(doc.texts)) {
    const box = textBoxes?.get(t.id) ?? { x1: t.x, y1: t.y - 8, x2: t.x + 6 * t.text.length, y2: t.y + 2 };
    out.push({ key: t.id, kind: 'text', atomIds: [], id: t.id, center: { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }, box });
  }
  for (const p of Object.values(doc.pluses)) {
    out.push({ key: p.id, kind: 'plus', atomIds: [], id: p.id, center: { x: p.x, y: p.y }, box: { x1: p.x - 4, y1: p.y - 4, x2: p.x + 4, y2: p.y + 4 } });
  }
  return out;
}

export function analyzeScheme(doc: Doc, textBoxes?: Map<string, Rect>): Step[] {
  const arrows = Object.values(doc.arrows).filter((r) => r.kind !== 'line');
  if (!arrows.length) return [];
  const objs = schemeObjects(doc, textBoxes);
  const main = norm(sub({ x: arrows[0].x2, y: arrows[0].y2 }, { x: arrows[0].x1, y: arrows[0].y1 }));
  // 流れの向き（最初の矢印の向き）に沿って矢印を並べる
  const sorted = [...arrows].sort((a, b) => dot({ x: a.x1, y: a.y1 }, main) - dot({ x: b.x1, y: b.y1 }, main));
  const geo = sorted.map((r) => {
    const tail = { x: r.x1, y: r.y1 };
    const u = norm(sub({ x: r.x2, y: r.y2 }, tail));
    const L = dot(sub({ x: r.x2, y: r.y2 }, tail), u);
    return { r, tail, u, v: rightNormal(u), L };
  });
  const steps: Step[] = sorted.map((r) => ({ arrowId: r.id, reactants: [], products: [], above: [], below: [], pluses: [] }));
  const band = BOND_LEN * 5;

  for (const o of objs) {
    // 矢印の上下にあるか
    let placed = false;
    for (let i = 0; i < geo.length; i++) {
      const g = geo[i];
      const rel = sub(o.center, g.tail);
      const s = dot(rel, g.u);
      const t = dot(rel, g.v);
      if (s >= -2 && s <= g.L + 2 && Math.abs(t) < band) {
        if (o.kind === 'plus') continue;
        (t < 0 ? steps[i].above : steps[i].below).push(o);
        placed = true;
        break;
      }
    }
    if (placed || o.kind === 'text') continue;
    // 矢印の間の位置で、反応物・生成物を決める
    const sAlong = geo.map((g) => dot(sub(o.center, g.tail), g.u));
    for (let i = 0; i < geo.length; i++) {
      const before = sAlong[i] < 0;
      const after = sAlong[i] > geo[i].L;
      const prevOk = i === 0 || sAlong[i - 1] > geo[i - 1].L;
      const nextOk = i === geo.length - 1 || sAlong[i + 1] < 0;
      if (before && prevOk) {
        if (o.kind === 'plus') steps[i].pluses.push(o);
        else steps[i].reactants.push(o);
      }
      if (after && nextOk) {
        if (o.kind === 'plus') {
          // 生成物の側の＋は、次の矢印が無いときだけこの段に入れる
          if (i === geo.length - 1) steps[i].pluses.push(o);
        } else steps[i].products.push(o);
      }
    }
  }
  return steps;
}


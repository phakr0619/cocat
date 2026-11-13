// 整列: 選んだ分子・矢印・文字・＋記号を、中心の高さ（または左右の位置）でそろえる
import { rectOfPoints, type Rect } from './geometry';
import type { Doc } from './model';
import { adjacency, molecules, kindOf } from './model';
import { moveSelection } from './transform';

interface Comp {
  ids: string[];
  box: Rect;
}

function components(doc: Doc, sel: Set<string>): Comp[] {
  const all = sel.size === 0;
  const has = (id: string) => all || sel.has(id);
  const out: Comp[] = [];
  for (const f of molecules(doc, adjacency(doc))) {
    if (!f.some(has)) continue;
    out.push({ ids: f, box: rectOfPoints(f.map((id) => doc.atoms[id]))! });
  }
  for (const r of Object.values(doc.arrows)) if (has(r.id)) out.push({ ids: [r.id], box: rectOfPoints([{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }])! });
  for (const p of Object.values(doc.pluses)) if (has(p.id)) out.push({ ids: [p.id], box: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } });
  return out;
}

/**
 * axis 'h': 横一列にそろえる（中心の高さを、いちばん左の物に合わせる）。
 * axis 'v': 縦一列にそろえる（中心の左右の位置を、いちばん上の物に合わせる）。
 * 文字は動かさない（矢印の上下の条件の位置を保つため、矢印と一緒に動かす）。
 */
export function alignCenters(doc: Doc, sel: Set<string>, axis: 'h' | 'v'): Doc {
  const comps = components(doc, sel);
  if (comps.length < 2) return doc;
  const cy = (c: Comp) => (c.box.y1 + c.box.y2) / 2;
  const cx = (c: Comp) => (c.box.x1 + c.box.x2) / 2;
  const ref = [...comps].sort((a, b) => (axis === 'h' ? a.box.x1 - b.box.x1 : a.box.y1 - b.box.y1))[0];
  let out = doc;
  for (const c of comps) {
    const delta = axis === 'h' ? { x: 0, y: cy(ref) - cy(c) } : { x: cx(ref) - cx(c), y: 0 };
    if (Math.abs(delta.x) + Math.abs(delta.y) < 1e-6) continue;
    const ids = [...c.ids];
    // 矢印を動かすときは、矢印の上下の文字も一緒に動かす
    if (c.ids.length === 1 && kindOf(c.ids[0]) === 'arrow') {
      const r = doc.arrows[c.ids[0]];
      for (const t of Object.values(doc.texts)) {
        if (t.x >= Math.min(r.x1, r.x2) - 10 && t.x <= Math.max(r.x1, r.x2) + 10 && Math.abs(t.y - (r.y1 + r.y2) / 2) < 40) ids.push(t.id);
      }
    }
    out = moveSelection(out, ids, delta);
  }
  return out;
}

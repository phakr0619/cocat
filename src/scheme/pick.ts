// スキームの図の物（矢印・条件の文字・化合物の番号の文字）が、データのどこから描かれたかを引く。
// 図の上で条件や番号を直すとき、押した物に合う段・化合物を開くために使う
import type { Doc } from '../chem/model';
import { measure } from './layout';

export type SchemeTarget =
  | { kind: 'step'; schemeId: string; stepIndex: number; arrowId: string }
  | { kind: 'compound'; schemeId: string; compoundId: string; atomIds: string[] };

/** スキームの矢印を、描いた順（= 段の順）に並べる */
export function schemeArrows(doc: Doc, schemeId: string) {
  return Object.values(doc.arrows).filter((r) => r.ref === schemeId);
}

/** id の物（矢印・文字・原子）が指す段か化合物。スキームの物でなければ null */
export function schemeTargetOf(doc: Doc, id: string): SchemeTarget | null {
  const arrow = doc.arrows[id];
  if (arrow?.ref && doc.schemes?.[arrow.ref]) {
    const i = schemeArrows(doc, arrow.ref).findIndex((r) => r.id === id);
    return i >= 0 && i < doc.schemes[arrow.ref].steps.length ? { kind: 'step', schemeId: arrow.ref, stepIndex: i, arrowId: id } : null;
  }
  const atom = doc.atoms[id];
  if (atom?.ref) {
    const [sid, cid] = atom.ref.split(':');
    if (!doc.schemes?.[sid] || !cid) return null;
    return { kind: 'compound', schemeId: sid, compoundId: cid, atomIds: Object.values(doc.atoms).filter((a) => a.ref === atom.ref).map((a) => a.id) };
  }
  const text = doc.texts[id];
  if (!text?.ref || !doc.schemes?.[text.ref]) return null;
  const sid = text.ref;
  const cx = text.x + measure(text.text.split('\n')[0], !!text.formula) / 2;
  // 矢印の上下の条件: 矢印の幅の中にあり、矢印にいちばん近い文字
  const arrows = schemeArrows(doc, sid);
  let best: { i: number; d: number } | null = null;
  arrows.forEach((r, i) => {
    const x1 = Math.min(r.x1, r.x2);
    const x2 = Math.max(r.x1, r.x2);
    if (cx < x1 - 1 || cx > x2 + 1) return;
    const d = Math.abs(text.y - r.y1);
    if (!best || d < best.d) best = { i, d };
  });
  // 化合物の番号・呼び名: 文字の真上にある、いちばん近い化合物
  const groups = new Map<string, { x1: number; x2: number; y2: number; ids: string[] }>();
  for (const a of Object.values(doc.atoms)) {
    if (!a.ref?.startsWith(`${sid}:`)) continue;
    const g = groups.get(a.ref) ?? { x1: a.x, x2: a.x, y2: a.y, ids: [] };
    g.x1 = Math.min(g.x1, a.x);
    g.x2 = Math.max(g.x2, a.x);
    g.y2 = Math.max(g.y2, a.y);
    g.ids.push(a.id);
    groups.set(a.ref, g);
  }
  let comp: { ref: string; d: number; ids: string[] } | null = null;
  for (const [ref, g] of groups) {
    if (g.y2 > text.y) continue;
    const d = Math.abs((g.x1 + g.x2) / 2 - cx) + (text.y - g.y2) * 0.5;
    if (!comp || d < comp.d) comp = { ref, d, ids: g.ids };
  }
  const b = best as { i: number; d: number } | null;
  const c = comp as { ref: string; d: number; ids: string[] } | null;
  // 太字は化合物の番号。それ以外は、矢印の幅の中にあれば条件
  if (b && !text.bold && b.i < doc.schemes[sid].steps.length && (!c || b.d < 60)) return { kind: 'step', schemeId: sid, stepIndex: b.i, arrowId: arrows[b.i].id };
  if (c) return { kind: 'compound', schemeId: sid, compoundId: c.ref.split(':')[1], atomIds: c.ids };
  return null;
}

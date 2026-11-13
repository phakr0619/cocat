// 文書の反応の段。スキームのデータがあれば、データから段を作る（折り返した図でも正しく読める）。
// データの無い描いた反応式は、これまでどおり図の位置から読む（analyzeScheme）
import { rectOfPoints, type Rect } from './geometry';
import type { Doc } from './model';
import { adjacency, molecules } from './model';
import { analyzeScheme, type SchemeObject, type Step } from './reaction';

export function reactionSteps(doc: Doc, textBoxes?: Map<string, Rect>): Step[] {
  const frags = molecules(doc, adjacency(doc));
  const fragOf = new Map<string, number>();
  frags.forEach((f, i) => f.forEach((id) => fragOf.set(id, i)));
  const fragObj = (i: number): SchemeObject => {
    const box = rectOfPoints(frags[i].map((id) => doc.atoms[id]))!;
    return { key: `frag:${i}`, kind: 'fragment', atomIds: frags[i], center: { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }, box };
  };
  const textObj = (id: string): SchemeObject => {
    const t = doc.texts[id];
    const box = textBoxes?.get(id) ?? { x1: t.x, y1: t.y - 8, x2: t.x + 6 * t.text.length, y2: t.y + 2 };
    return { key: id, kind: 'text', atomIds: [], id, center: { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }, box };
  };
  const plusObj = (id: string): SchemeObject => {
    const p = doc.pluses[id];
    return { key: id, kind: 'plus', atomIds: [], id, center: { x: p.x, y: p.y }, box: { x1: p.x - 4, y1: p.y - 4, x2: p.x + 4, y2: p.y + 4 } };
  };

  const steps: Step[] = [];
  const handled = new Set<string>();
  const num = (id: string) => parseInt(id.slice(1), 10);
  for (const s of Object.values(doc.schemes ?? {})) {
    // スキームは段ごとに矢印を1本、段の順に置く（src/scheme/layout.ts）
    const arrows = Object.values(doc.arrows).filter((r) => r.ref === s.id).sort((a, b) => num(a.id) - num(b.id));
    if (arrows.length !== s.steps.length) continue;
    handled.add(s.id);
    const texts = Object.values(doc.texts).filter((t) => t.ref === s.id).map((t) => textObj(t.id));
    const pluses = Object.values(doc.pluses).filter((p) => p.ref === s.id);
    s.steps.forEach((st, i) => {
      const r = arrows[i];
      const objs = (cids: string[]) => {
        const out: SchemeObject[] = [];
        for (const cid of cids) {
          const a = Object.values(doc.atoms).find((x) => x.ref === `${s.id}:${cid}`);
          const fi = a ? fragOf.get(a.id) : undefined;
          if (fi !== undefined && !out.some((o) => o.key === `frag:${fi}`)) out.push(fragObj(fi));
        }
        return out;
      };
      const x1 = Math.min(r.x1, r.x2);
      const x2 = Math.max(r.x1, r.x2);
      const near = texts.filter((t) => t.center.x >= x1 - 2 && t.center.x <= x2 + 2 && Math.abs(t.center.y - r.y1) < 60);
      // ＋は同じ行で、前の矢印とこの矢印の間にあるもの
      const prev = arrows[i - 1];
      const from = prev && Math.abs(prev.y1 - r.y1) < 1 ? Math.max(prev.x1, prev.x2) : -Infinity;
      const next = arrows[i + 1];
      const to = next && Math.abs(next.y1 - r.y1) < 1 ? Math.min(next.x1, next.x2) : Infinity;
      steps.push({
        arrowId: r.id,
        reactants: objs(st.from),
        products: objs(st.to),
        above: near.filter((t) => t.center.y < r.y1),
        below: near.filter((t) => t.center.y >= r.y1),
        pluses: pluses
          .filter((p) => Math.abs(p.y - r.y1) < 30 && ((p.x > from && p.x < x1) || (i === s.steps.length - 1 && p.x > x2 && p.x < to)))
          .map((p) => plusObj(p.id)),
      });
    });
  }

  // スキームのデータの無い物（描いた反応式）は図の位置から読む。分子の番号は文書全体の番号に合わせる
  const ref = (x: { ref?: string }) => x.ref && (handled.has(x.ref.split(':')[0]) || doc.tables?.[x.ref.split(':')[0]]);
  const free: Doc = {
    ...doc,
    atoms: Object.fromEntries(Object.entries(doc.atoms).filter(([, a]) => !ref(a))),
    arrows: Object.fromEntries(Object.entries(doc.arrows).filter(([, a]) => !ref(a))),
    texts: Object.fromEntries(Object.entries(doc.texts).filter(([, a]) => !ref(a))),
    pluses: Object.fromEntries(Object.entries(doc.pluses).filter(([, a]) => !ref(a))),
  };
  free.bonds = Object.fromEntries(Object.entries(doc.bonds).filter(([, b]) => free.atoms[b.a1] && free.atoms[b.a2]));
  const remap = (o: SchemeObject): SchemeObject => (o.kind === 'fragment' ? fragObj(fragOf.get(o.atomIds[0])!) : o);
  for (const st of analyzeScheme(free, textBoxes)) {
    steps.push({
      arrowId: st.arrowId,
      reactants: st.reactants.map(remap),
      products: st.products.map(remap),
      above: st.above.map(remap),
      below: st.below.map(remap),
      pluses: st.pluses,
    });
  }
  return steps;
}

// キャンバスで直したスキームの分子を、化合物のデータへ戻す
import type { Doc } from '../chem/model';
import { adjacency, edit, molecules } from '../chem/model';
import { structureFrom } from './model';
import { renderScheme } from './layout';

function snapshot(doc: Doc, ids: string[]): string {
  const set = new Set(ids);
  const atoms = ids.map((id) => {
    const a = doc.atoms[id];
    return [id, a.element, a.charge, a.abbr ?? '', Math.round(a.x * 100), Math.round(a.y * 100)];
  });
  const bonds = Object.values(doc.bonds)
    .filter((b) => set.has(b.a1) || set.has(b.a2))
    .map((b) => [b.id, b.a1, b.a2, b.order, b.stereo, b.doublePos]);
  return JSON.stringify([atoms.sort(), bonds.sort()]);
}

/**
 * prev から next への変更で、スキームの分子が直されていたら、化合物の構造を更新して描き直す。
 * - 描き直し（原子の id がすべて入れ替わった）なら何もしない
 * - 分子全体を平行に動かしただけなら、元の位置に戻る（配置は自動レイアウトが決める）
 */
export function syncSchemes(prev: Doc, next: Doc): Doc {
  if (!next.schemes || !Object.keys(next.schemes).length) return next;
  const frags = molecules(next, adjacency(next));
  let out = next;
  const touched = new Set<string>();
  const updates: { compoundId: string; atomIds: string[] }[] = [];
  const moved = new Map<string, { dx: number; dy: number }[]>();
  for (const s of Object.values(next.schemes)) {
    const ids = new Set(s.steps.flatMap((st) => [...st.from, ...st.to]));
    for (const cid of ids) {
      const key = `${s.id}:${cid}`;
      const prevIds = Object.values(prev.atoms).filter((a) => a.ref === key).map((a) => a.id);
      const refIds = Object.values(next.atoms).filter((a) => a.ref === key).map((a) => a.id);
      if (!refIds.some((id) => prevIds.includes(id))) continue;
      // 分子に描き足した原子（ref が無い）も、つながっていれば含める
      const nextIds = [...new Set(frags.filter((f) => f.some((id) => refIds.includes(id))).flat())];
      const before = snapshot(prev, prevIds);
      const after = snapshot(next, nextIds);
      if (before === after) continue;
      const delta = translation(prev, next, prevIds, nextIds);
      if (delta) {
        moved.set(s.id, [...(moved.get(s.id) ?? []), delta]);
        touched.add(s.id);
        continue;
      }
      // 固定した図は、化合物のデータへ戻さない（描き直すと固定した形に戻る）
      if (!s.pinned) updates.push({ compoundId: cid, atomIds: nextIds });
      touched.add(s.id);
    }
  }
  if (!updates.length && !touched.size) return next;
  out = edit(out, (d) => {
    for (const u of updates) {
      if (d.compounds?.[u.compoundId]) d.compounds[u.compoundId].structure = structureFrom(next, u.atomIds);
    }
    // スキームの矢印も同じだけ動いていれば、スキーム全体を動かしたとみなして置き場所を動かす
    for (const [sid, deltas] of moved) {
      const dl = deltas[0];
      if (!deltas.every((x) => Math.abs(x.dx - dl.dx) < 0.01 && Math.abs(x.dy - dl.dy) < 0.01)) continue;
      const arrows = Object.values(prev.arrows).filter((r) => r.ref === sid);
      const allMoved = arrows.every((r) => {
        const n = next.arrows[r.id];
        return n && Math.abs(n.x1 - r.x1 - dl.dx) < 0.01 && Math.abs(n.y1 - r.y1 - dl.dy) < 0.01;
      });
      if (allMoved) {
        d.schemes![sid].origin = { x: d.schemes![sid].origin.x + dl.dx, y: d.schemes![sid].origin.y + dl.dy };
      }
    }
  });
  // 同じ化合物を使う別のスキーム（検討表の行から作ったものなど）も描き直す
  const changed = new Set(updates.map((u) => u.compoundId));
  for (const s of Object.values(out.schemes ?? {})) {
    if (s.steps.some((st) => [...st.from, ...st.to].some((c) => changed.has(c)))) touched.add(s.id);
  }
  for (const sid of touched) out = renderScheme(out, sid);
  return out;
}

/** 分子が形を変えずに平行に動いただけなら、その移動量 */
function translation(prev: Doc, next: Doc, prevIds: string[], nextIds: string[]): { dx: number; dy: number } | null {
  if (prevIds.length !== nextIds.length || prevIds.some((id) => !next.atoms[id])) return null;
  const a0 = prev.atoms[prevIds[0]];
  const b0 = next.atoms[prevIds[0]];
  const dx = b0.x - a0.x;
  const dy = b0.y - a0.y;
  const same = prevIds.every((id) => {
    const a = prev.atoms[id];
    const b = next.atoms[id];
    return a.element === b.element && a.charge === b.charge && Math.abs(b.x - a.x - dx) < 0.01 && Math.abs(b.y - a.y - dy) < 0.01;
  });
  const strip = (t: string) => t.replace(/,-?\d+,-?\d+\]/g, ']');
  return same && strip(snapshot(prev, prevIds)) === strip(snapshot(next, nextIds)) ? { dx, dy } : null;
}

// キャンバスでの変更を検討表のデータへ戻す
// - 表（文字と罫線）を丸ごと動かしたら、置き場所を動かす（反応式があれば反応式ごと）
// - SAR の母核を直したら、母核の構造を更新する
import type { Doc } from '../chem/model';
import { adjacency, edit, molecules } from '../chem/model';
import { renderScheme } from '../scheme/layout';
import { structureFrom } from '../scheme/model';
import { renderTable, tableKey } from './layout';

type Delta = { dx: number; dy: number };

const same = (a: Delta, b: Delta) => Math.abs(a.dx - b.dx) < 0.01 && Math.abs(a.dy - b.dy) < 0.01;

/** 表が置いた文字・罫線・原子が、すべて同じだけ動いていればその量。動いていない・形が変わったなら null */
function moved(prev: Doc, next: Doc, tableId: string): Delta | null {
  const deltas: Delta[] = [];
  for (const t of Object.values(prev.texts)) {
    if (t.ref !== tableId) continue;
    const n = next.texts[t.id];
    if (!n || n.text !== t.text) return null;
    deltas.push({ dx: n.x - t.x, dy: n.y - t.y });
  }
  for (const r of Object.values(prev.arrows)) {
    if (r.ref !== tableId) continue;
    const n = next.arrows[r.id];
    if (!n || !same({ dx: n.x1 - r.x1, dy: n.y1 - r.y1 }, { dx: n.x2 - r.x2, dy: n.y2 - r.y2 })) return null;
    deltas.push({ dx: n.x1 - r.x1, dy: n.y1 - r.y1 });
  }
  if (!deltas.length || !deltas.every((x) => same(x, deltas[0]))) return null;
  return Math.abs(deltas[0].dx) + Math.abs(deltas[0].dy) > 0.01 ? deltas[0] : null;
}

function atomSig(d: Doc, ids: string[]): string {
  const set = new Set(ids);
  const atoms = ids.map((id) => [id, d.atoms[id].element, d.atoms[id].charge, d.atoms[id].abbr ?? '', Math.round(d.atoms[id].x * 100), Math.round(d.atoms[id].y * 100)]);
  const bonds = Object.values(d.bonds)
    .filter((b) => set.has(b.a1) || set.has(b.a2))
    .map((b) => [b.id, b.a1, b.a2, b.order, b.stereo, b.doublePos]);
  return JSON.stringify([atoms.sort(), bonds.sort()]);
}

export function syncTables(prev: Doc, next: Doc): Doc {
  if (!next.tables || !Object.keys(next.tables).length) return next;
  let out = next;
  for (const t of Object.values(next.tables)) {
    // SAR の母核
    const key = tableKey(t.id, 'core');
    const prevIds = Object.values(prev.atoms).filter((a) => a.ref === key).map((a) => a.id);
    const refIds = Object.values(out.atoms).filter((a) => a.ref === key).map((a) => a.id);
    if (t.core && refIds.some((id) => prevIds.includes(id))) {
      const ids = [...new Set(molecules(out, adjacency(out)).filter((f) => f.some((id) => refIds.includes(id))).flat())];
      const shape = (d: Doc, xs: string[]) => atomSig(d, xs).replace(/,-?\d+,-?\d+\]/g, ']');
      if (shape(prev, prevIds) !== shape(out, ids)) {
        const snapshot = out;
        out = renderTable(
          edit(out, (d) => {
            d.tables![t.id].core = structureFrom(snapshot, ids);
          }),
          t.id,
        );
        continue;
      }
    }
    const delta = moved(prev, out, t.id);
    if (!delta) continue;
    if (t.schemeId && out.schemes?.[t.schemeId]) {
      const sid = t.schemeId;
      out = renderScheme(
        edit(out, (d) => {
          const s = d.schemes![sid];
          s.origin = { x: s.origin.x + delta.dx, y: s.origin.y + delta.dy };
        }),
        sid,
      );
    } else {
      out = renderTable(
        edit(out, (d) => {
          const o = d.tables![t.id].origin;
          d.tables![t.id].origin = { x: o.x + delta.dx, y: o.y + delta.dy };
        }),
        t.id,
      );
    }
  }
  return out;
}

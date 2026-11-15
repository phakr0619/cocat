// キャンバスでの変更を実験の記録へ戻す: フロー図を丸ごと動かしたら置き場所を動かし、
// 一部だけを動かした・消したときは、データから描き直す（図はデータから作る物なので、形は崩さない）。
// 図の物を全部消したときは、記録も消す
import type { Doc } from '../chem/model';
import { edit } from '../chem/model';
import { renderRun } from './layout';

type Delta = { dx: number; dy: number };
const same = (a: Delta, b: Delta) => Math.abs(a.dx - b.dx) < 0.01 && Math.abs(a.dy - b.dy) < 0.01;

export function syncRuns(prev: Doc, next: Doc): Doc {
  if (!next.runs || !Object.keys(next.runs).length) return next;
  let out = next;
  for (const run of Object.values(next.runs)) {
    // 前の文書に無い記録（作ったばかり・貼り付け）と、データを直した記録はそのまま（直す操作が自分で描き直す）
    const before = prev.runs?.[run.id];
    if (!before || JSON.stringify(before) !== JSON.stringify(run)) continue;
    // 図に出している化合物の番号・呼び名が変わったら描き直す
    const labels = (d: Doc) => [...run.materials.map((m) => m.compoundId), run.product.compoundId].map((id) => (id ? `${d.compounds?.[id]?.number ?? ''}/${d.compounds?.[id]?.nickname ?? ''}` : '')).join('|');
    if (labels(prev) !== labels(out)) {
      out = renderRun(out, run.id);
      continue;
    }
    const deltas: Delta[] = [];
    let changed = false;
    let left = 0;
    for (const t of Object.values(prev.texts)) {
      if (t.ref !== run.id) continue;
      const n = out.texts[t.id];
      if (!n || n.ref !== run.id) changed = true;
      else (left++, deltas.push({ dx: n.x - t.x, dy: n.y - t.y }), (changed ||= n.text !== t.text));
    }
    for (const r of Object.values(prev.arrows)) {
      if (r.ref !== run.id) continue;
      const n = out.arrows[r.id];
      if (!n || n.ref !== run.id) changed = true;
      else (left++, deltas.push({ dx: n.x1 - r.x1, dy: n.y1 - r.y1 }), (changed ||= !same({ dx: n.x1 - r.x1, dy: n.y1 - r.y1 }, { dx: n.x2 - r.x2, dy: n.y2 - r.y2 })));
    }
    for (const s of Object.values(prev.shapes ?? {})) {
      if (s.ref !== run.id) continue;
      const n = out.shapes?.[s.id];
      if (!n || n.ref !== run.id) changed = true;
      else (left++, deltas.push({ dx: n.x1 - s.x1, dy: n.y1 - s.y1 }), (changed ||= !same({ dx: n.x1 - s.x1, dy: n.y1 - s.y1 }, { dx: n.x2 - s.x2, dy: n.y2 - s.y2 })));
    }
    if (!deltas.length && !changed) continue;
    if (!left) {
      // 図の物を全部消した: 記録も消す
      out = edit(out, (d) => {
        delete d.runs![run.id];
      });
      continue;
    }
    const uniform = !changed && deltas.every((x) => same(x, deltas[0]));
    const d0 = deltas[0];
    if (uniform && Math.abs(d0.dx) + Math.abs(d0.dy) < 0.01) continue;
    out = renderRun(
      edit(out, (d) => {
        if (uniform) {
          const o = d.runs![run.id].origin;
          d.runs![run.id].origin = { x: o.x + d0.dx, y: o.y + d0.dy };
        }
      }),
      run.id,
    );
  }
  return out;
}

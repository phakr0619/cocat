// キャンバスの分子をスキームへドラッグ＆ドロップで入れるときの、落とし先
import { rectContains, type P, type Rect } from '../chem/geometry';
import type { Doc } from '../chem/model';
import { BOND_LEN } from '../chem/style';

export type DropTarget =
  | { kind: 'substrate'; schemeId: string; step: number; rect: Rect; label: string }
  | { kind: 'product'; schemeId: string; rect: Rect; label: string };

export function dropTargets(doc: Doc): DropTarget[] {
  const out: DropTarget[] = [];
  for (const s of Object.values(doc.schemes ?? {})) {
    if (s.pinned) continue;
    // 矢印は段の順に置かれている（renderScheme が段の順に作る）
    const arrows = Object.values(doc.arrows).filter((r) => r.ref === s.id);
    arrows.forEach((r, i) => {
      if (i >= s.steps.length) return;
      out.push({
        kind: 'substrate',
        schemeId: s.id,
        step: i,
        rect: { x1: Math.min(r.x1, r.x2), y1: r.y1 - BOND_LEN * 1.6, x2: Math.max(r.x1, r.x2), y2: r.y1 + BOND_LEN * 1.6 },
        label: `段 ${i + 1} の基質に入れる`,
      });
    });
    // 最後の行の右端の先: 生成物として段を足す
    const last = arrows.at(-1);
    if (!last) continue;
    const rowAtoms = Object.values(doc.atoms).filter((a) => a.ref?.startsWith(`${s.id}:`) && Math.abs(a.y - last.y1) < BOND_LEN * 4);
    const right = Math.max(last.x2, ...rowAtoms.map((a) => a.x)) + BOND_LEN * 0.8;
    out.push({
      kind: 'product',
      schemeId: s.id,
      rect: { x1: right, y1: last.y1 - BOND_LEN * 3, x2: right + BOND_LEN * 6, y2: last.y1 + BOND_LEN * 3 },
      label: '生成物として段を足す',
    });
  }
  return out;
}

export function findDropTarget(doc: Doc, p: P): DropTarget | null {
  return dropTargets(doc).find((t) => rectContains(t.rect, p)) ?? null;
}

// 段階2のツール: 環テンプレート、選択（矩形・投げ縄）、移動・回転
import { angleOf, dist, inflate, pointInPolygon, rectContains, snapAngle, sub, type P, type Rect } from '../chem/geometry';
import { adjacency, molecules, kindOf, type Doc } from '../chem/model';
import { placeRing, ringVertices, type RingAim, type RingKind, type RingTarget } from '../chem/ringOps';
import {
  expandSelection, mergeOverlaps, moveSelection, rotateSelection, selectionBBox, withInnerBonds,
} from '../chem/transform';
import type { Prim } from '../render/layout';
import { findDropTarget, type DropTarget } from '../scheme/drop';
import { addStepWithProduct, addSubstrate, freeFragments } from '../scheme/ops';
import { CLICK_TOL, registerExtraTools, type Ctx, type MoveKeys, type Session } from './interaction';

const RING_KINDS: Record<string, RingKind> = {
  ring3: 3, ring4: 4, ring5: 5, ring6: 6, ring7: 7, ring8: 8, benzene: 'benzene', chair: 'chair',
};

/** 回転のハンドルの位置（選択の枠の上） */
export function rotateHandle(doc: Doc, sel: Set<string>): P | null {
  if (sel.size === 0) return null;
  const box = selectionBBox(doc, sel);
  if (!box || (box.x2 - box.x1 < 1 && box.y2 - box.y1 < 1)) return null;
  return { x: (box.x1 + box.x2) / 2, y: box.y1 - 14 };
}

export function selectionFrame(doc: Doc, sel: Set<string>): Rect | null {
  const box = selectionBBox(doc, sel);
  return box ? inflate(box, 6) : null;
}

/** 範囲の中の物を選ぶ */
export function itemsInside(doc: Doc, inside: (p: P) => boolean): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(doc.atoms)) if (inside(a)) out.add(a.id);
  for (const r of Object.values(doc.arrows)) if (inside({ x: r.x1, y: r.y1 }) && inside({ x: r.x2, y: r.y2 })) out.add(r.id);
  for (const t of Object.values(doc.texts)) if (inside(t)) out.add(t.id);
  for (const p of Object.values(doc.pluses)) if (inside(p)) out.add(p.id);
  for (const s of Object.values(doc.shapes ?? {})) if (inside({ x: s.x1, y: s.y1 }) && inside({ x: s.x2, y: s.y2 })) out.add(s.id);
  return withInnerBonds(doc, out);
}

/** 原子か結合を含む分子全体 */
export function fragmentOf(doc: Doc, id: string): Set<string> {
  const atomId = kindOf(id) === 'bond' ? doc.bonds[id].a1 : id;
  const frag = molecules(doc, adjacency(doc)).find((f) => f.includes(atomId)) ?? [atomId];
  return withInnerBonds(doc, new Set(frag));
}

registerExtraTools((ctx, tool, start, hit, ev) => {
  if (tool in RING_KINDS) return ringSession(ctx, RING_KINDS[tool], start, hit);
  if (tool === 'select' || tool === 'lasso') return selectSession(ctx, tool, start, hit, ev.shift);
  return extraStage3(ctx, tool, start, hit, ev);
});

let extraStage3: (ctx: Ctx, tool: string, start: P, hit: string | null, ev: { shift: boolean; alt: boolean }) => Session | null = () => null;
export function registerStage3Tools(fn: typeof extraStage3) {
  extraStage3 = fn;
}

function ringTarget(start: P, hit: string | null): RingTarget {
  const k = hit ? kindOf(hit) : null;
  return k === 'atom' ? { kind: 'atom', id: hit! } : k === 'bond' ? { kind: 'bond', id: hit! } : { kind: 'blank', p: start };
}

/** 環ツールでカーソルを動かしているときの、置く前のプレビュー */
export function ringPreview(doc: Doc, tool: string, p: P, hit: string | null): Prim[] | null {
  const kind = RING_KINDS[tool];
  if (kind === undefined) return null;
  const k = hit ? kindOf(hit) : null;
  if (k && k !== 'atom' && k !== 'bond') return null;
  const vs = ringVertices(doc, kind, ringTarget(p, hit));
  return vs.map((v, i) => ({ k: 'line' as const, a: v, b: vs[(i + 1) % vs.length], w: 0.6, owner: '' }));
}

/**
 * 環を置く。押してすぐ離せば今までの向きで置き、押したまま動かすと向きを変える（15° 刻み、Alt で自由）。
 * 手のぶれで回らないよう、CLICK_TOL より動いてから向きを変える
 */
function ringSession(ctx: Ctx, kind: RingKind, start: P, hit: string | null): Session {
  const target = ringTarget(start, hit);
  let moved = false;
  const aimAt = (p: P, keys?: MoveKeys): RingAim | undefined => {
    if (!moved && dist(p, start) >= CLICK_TOL) moved = true;
    return moved ? { p, free: !!keys?.alt } : undefined;
  };
  return {
    move(p, keys) {
      const aim = aimAt(p, keys);
      if (!aim) return;
      const vs = ringVertices(ctx.store.get().doc, kind, target, aim);
      ctx.setPreview({ prims: vs.map((v, i) => ({ k: 'line' as const, a: v, b: vs[(i + 1) % vs.length], w: 0.6, owner: '' })) });
    },
    up(p, keys) {
      ctx.setPreview(null);
      ctx.store.commit(placeRing(ctx.store.get().doc, kind, target, aimAt(p, keys)));
    },
  };
}

function selectSession(ctx: Ctx, tool: 'select' | 'lasso', start: P, hit: string | null, shift: boolean): Session {
  const { store } = ctx;
  const base = store.get().doc;
  const sel = store.get().selection;
  const handle = rotateHandle(base, sel);

  // 回転のハンドル
  if (handle && dist(handle, start) < 4) {
    const box = selectionBBox(base, sel)!;
    const center = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    const a0 = angleOf(sub(start, center));
    let last = base;
    return {
      move(p) {
        let ang = angleOf(sub(p, center)) - a0;
        ang = snapAngle(ang, Math.PI / 12 / (shift ? 1 : 15));
        last = rotateSelection(base, sel, ang, center);
        store.preview(last);
      },
      up() {
        if (last !== base) store.commitFrom(base, last, sel);
      },
    };
  }

  // 物の上で押した: クリックなら選択、ドラッグなら移動
  if (hit) {
    const already = sel.has(hit);
    const moving = already ? sel : new Set([hit]);
    // 動かしているのがスキームでない分子1つまるごとなら、スキームへドロップできる
    const frags = freeFragments(base, moving);
    const whole = frags.length === 1 && frags[0].every((id) => expandSelection(base, moving).has(id)) ? frags[0] : null;
    let moved = false;
    let last = base;
    let drop: DropTarget | null = null;
    return {
      move(p) {
        if (!moved && dist(p, start) < CLICK_TOL) return;
        moved = true;
        last = moveSelection(base, moving, sub(p, start));
        store.preview(last);
        drop = whole ? findDropTarget(base, p) : null;
        if (drop) {
          const r = drop.rect;
          ctx.setPreview({
            prims: [{ k: 'text', run: { text: drop.label, x: r.x1, y: r.y1 - 2, size: 6 }, owner: '' }],
            outline: [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }],
          });
        } else ctx.setPreview(null);
      },
      up() {
        ctx.setPreview(null);
        if (moved && drop && whole) {
          const d = drop;
          const next = d.kind === 'substrate' ? addSubstrate(base, d.schemeId, d.step, whole) : addStepWithProduct(base, d.schemeId, whole);
          store.commitFrom(base, next, new Set());
          return;
        }
        if (moved) {
          const merged = mergeOverlaps(last, expandSelection(last, moving));
          store.commitFrom(base, merged, already ? sel : new Set());
          return;
        }
        if (shift) {
          const next = new Set(sel);
          if (next.has(hit)) next.delete(hit);
          else next.add(hit);
          store.set({ selection: next });
        } else {
          store.set({ selection: kindOf(hit) === 'bond' ? expandSelection(base, [hit]) : new Set([hit]) });
        }
      },
    };
  }

  // 何もない所: 範囲選択
  const path: P[] = [start];
  // 投げ縄は始点に戻して閉じるので、離した位置ではなく動いた距離でクリックかを決める
  let far = 0;
  return {
    move(p) {
      path.push(p);
      far = Math.max(far, dist(p, start));
      const outline = tool === 'lasso' ? path : rectPath(start, p);
      ctx.setPreview({ prims: [] as Prim[], outline });
    },
    up(p) {
      ctx.setPreview(null);
      if (far < CLICK_TOL) {
        if (!shift) store.set({ selection: new Set() });
        return;
      }
      let found: Set<string>;
      if (tool === 'lasso') found = itemsInside(base, (q) => pointInPolygon(q, path));
      else {
        const r: Rect = { x1: Math.min(start.x, p.x), y1: Math.min(start.y, p.y), x2: Math.max(start.x, p.x), y2: Math.max(start.y, p.y) };
        found = itemsInside(base, (q) => rectContains(r, q));
      }
      store.set({ selection: shift ? new Set([...sel, ...found]) : found });
    },
  };
}

function rectPath(a: P, b: P): P[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}


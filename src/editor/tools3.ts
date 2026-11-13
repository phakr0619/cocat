// 段階3のツール: 反応矢印・文字・＋記号
import { add, angleOf, dist, fromAngle, mul, norm, rightNormal, snapAngle, sub, type P } from '../chem/geometry';
import type { ArrowKind, Doc, ShapeKind } from '../chem/model';
import { edit, kindOf, newId } from '../chem/model';
import { selectionBBox } from '../chem/transform';
import { addArrow, addPlus, setArrowKind, setText, type ArrowExtra } from '../chem/schemeOps';
import { placePart } from '../chem/partOps';
import { BOND_LEN } from '../chem/style';
import { layout } from '../render/layout';
import { arrowDist } from './hit';
import { CLICK_TOL, type Ctx, type Session } from './interaction';
import { fragmentOf, registerStage3Tools } from './tools2';

const ARROW_KINDS: Record<string, ArrowKind> = {
  'arrow-normal': 'normal',
  'arrow-equilibrium': 'equilibrium',
  'arrow-retro': 'retro',
  'arrow-resonance': 'resonance',
  'arrow-dashed': 'normal',
  'arrow-nogo': 'normal',
  'shape-line': 'line',
};
const SHAPE_KINDS: Record<string, ShapeKind> = {
  rect: 'rect',
  oval: 'oval',
  'bracket-square': 'bracket-square',
  'bracket-round': 'bracket-round',
  'bracket-curly': 'bracket-curly',
};
const ARROW_EXTRA: Record<string, Pick<ArrowExtra, 'dashed' | 'noGo'>> = {
  'arrow-dashed': { dashed: true },
  'arrow-nogo': { noGo: true },
};

/** クリックで置く矢印の長さ */
export const ARROW_LEN = BOND_LEN * 3;

registerStage3Tools((ctx, tool, start, hit, ev) => {
  if (tool in ARROW_KINDS) return arrowSession(ctx, ARROW_KINDS[tool], start, hit, ARROW_EXTRA[tool] ?? {});
  if (tool in SHAPE_KINDS) return shapeSession(ctx, SHAPE_KINDS[tool], start, hit);
  if (tool === 'arrow-curved' || tool === 'arrow-fishhook') return curvedSession(ctx, tool === 'arrow-fishhook', start, hit, ev.shift);
  if (tool === 'lone-pair' || tool === 'radical' || tool === 'delta-plus' || tool === 'delta-minus') {
    return {
      move() {},
      up() {
        const doc = ctx.store.get().doc;
        if (!hit || kindOf(hit) !== 'atom' || !doc.atoms[hit]) {
          ctx.store.set({ message: '原子をクリックしてください' });
          return;
        }
        ctx.store.commit(atomMark(doc, hit, tool));
      },
    };
  }
  if (tool === 'part') {
    const part = ctx.store.get().part;
    if (!part) return null;
    return {
      move() {},
      up() {
        ctx.setPreview(null);
        const doc = ctx.store.get().doc;
        const target = hit && doc.atoms[hit] ? { kind: 'atom' as const, id: hit } : { kind: 'blank' as const, p: start };
        ctx.store.commit(placePart(doc, part.structure, target).doc);
      },
    };
  }
  if (tool === 'plus') {
    return {
      move() {},
      up() {
        ctx.store.commit(addPlus(ctx.store.get().doc, start));
      },
    };
  }
  if (tool === 'text') {
    return {
      move() {},
      up() {
        const t = hit && kindOf(hit) === 'text' ? hit : null;
        ctx.openTextEditor?.(t, t ? ctx.store.get().doc.texts[t] : start);
      },
    };
  }
  return null;
});

/**
 * 原子の印: ローンペア（押すたびに 1→2→3→0 個）、ラジカル（付ける・外す）、部分電荷 δ+ / δ−（原子の右上に文字で置く）
 */
export function atomMark(doc: Doc, atomId: string, tool: string): Doc {
  if (tool === 'delta-plus' || tool === 'delta-minus') {
    const a = doc.atoms[atomId];
    return setText(doc, null, { x: a.x + 5, y: a.y - 6 }, tool === 'delta-plus' ? 'δ+' : 'δ−');
  }
  return edit(doc, (d) => {
    const a = d.atoms[atomId];
    if (tool === 'radical') {
      if (a.radical) delete a.radical;
      else a.radical = true;
    } else {
      const n = ((a.lonePairs ?? 0) + 1) % 4;
      if (n) a.lonePairs = n;
      else delete a.lonePairs;
    }
  });
}

export function addShape(doc: Doc, kind: ShapeKind, a: P, b: P): Doc {
  return edit(doc, (d) => {
    d.shapes ??= {};
    const id = newId(d, 'h');
    d.shapes[id] = { id, kind, x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
  });
}

/**
 * 図形: ドラッグで箱を決める。括弧の道具で分子をクリックすると、その分子を囲む（ポリマーの繰り返し・錯体）。
 * 何も無い所のクリックは、決まった大きさで置く
 */
function shapeSession(ctx: Ctx, kind: ShapeKind, start: P, hit: string | null): Session {
  const { store } = ctx;
  let end: P | null = null;
  return {
    move(p) {
      if (dist(p, start) < CLICK_TOL * 2) return;
      end = p;
      const lay = layout({ atoms: {}, bonds: {}, arrows: {}, texts: {}, pluses: {}, groups: {}, shapes: { tmp: { id: 'tmp', kind, x1: start.x, y1: start.y, x2: p.x, y2: p.y } }, nextId: 0 });
      ctx.setPreview({ prims: lay.prims });
    },
    up() {
      ctx.setPreview(null);
      const doc = store.get().doc;
      if (end) {
        if (Math.abs(end.x - start.x) > 2 && Math.abs(end.y - start.y) > 2) store.commit(addShape(doc, kind, start, end));
        return;
      }
      if (hit && (doc.atoms[hit] || doc.bonds[hit]) && kind.startsWith('bracket')) {
        const ids = [...fragmentOf(doc, hit)].filter((id) => doc.atoms[id]);
        const box = selectionBBox(doc, ids)!;
        const m = 7;
        store.commit(addShape(doc, kind, { x: box.x1 - m, y: box.y1 - m }, { x: box.x2 + m, y: box.y2 + m }));
        return;
      }
      if (!hit) store.commit(addShape(doc, kind, { x: start.x - 20, y: start.y - 15 }, { x: start.x + 20, y: start.y + 15 }));
    },
  };
}

/** 曲がった矢印の、尾と頭から決める既定の制御点（進む向きの左にふくらむ。flip なら右） */
export function defaultControl(tail: P, head: P, flip = false): P {
  const d = norm(sub(head, tail));
  const n = rightNormal(d);
  return add(mul(add(tail, head), 0.5), mul(n, (flip ? 1 : -1) * dist(tail, head) * 0.45));
}

/** 曲がった矢印の端を、原子か結合の中ほどに寄せる（電子の出どころと行き先） */
function snapEnd(ctx: Ctx, p: P, hit: string | null): P {
  const doc = ctx.store.get().doc;
  if (hit && doc.atoms[hit]) return { x: doc.atoms[hit].x, y: doc.atoms[hit].y };
  if (hit && doc.bonds[hit]) {
    const b = doc.bonds[hit];
    return mul(add(doc.atoms[b.a1], doc.atoms[b.a2]), 0.5);
  }
  return p;
}

/**
 * 曲がった矢印（電子の動き）。ドラッグで尾から頭へ引く（Shift で反対側にふくらむ）。
 * 置いた曲がった矢印をこの道具でドラッグすると曲がり具合を変え、クリックするとふくらむ側を逆にする
 */
function curvedSession(ctx: Ctx, half: boolean, start: P, hit: string | null, shift: boolean): Session {
  const { store } = ctx;
  const doc0 = store.get().doc;
  // この道具では、原子や結合より、すぐ下の曲がった矢印を先に拾う（短い矢印は原子に重なりやすい）
  const near = Object.values(doc0.arrows)
    .filter((r) => r.kind === 'curved')
    .map((r) => ({ r, d: arrowDist(r, start) }))
    .sort((a, b) => a.d - b.d)[0];
  const target = near && near.d < 3 ? near.r : hit && doc0.arrows[hit]?.kind === 'curved' ? doc0.arrows[hit] : null;
  const tail = target ? null : snapEnd(ctx, start, hit);
  let moved = false;
  let last = start;
  const preview = (r: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number }) => {
    const lay = layout({ atoms: {}, bonds: {}, arrows: { tmp: { id: 'tmp', kind: 'curved', half, ...r } }, texts: {}, pluses: {}, groups: {}, nextId: 0 });
    ctx.setPreview({ prims: lay.prims });
  };
  return {
    move(p) {
      if (dist(p, start) < CLICK_TOL * 2) return;
      moved = true;
      last = p;
      if (target) {
        // 曲線がカーソルの所を通るように、制御点を動かす
        preview({ ...target, cx: 2 * p.x - (target.x1 + target.x2) / 2, cy: 2 * p.y - (target.y1 + target.y2) / 2 });
      } else {
        const c = defaultControl(tail!, p, shift);
        preview({ x1: tail!.x, y1: tail!.y, x2: p.x, y2: p.y, cx: c.x, cy: c.y });
      }
    },
    up(p) {
      ctx.setPreview(null);
      const doc = store.get().doc;
      if (target) {
        const r = target;
        const c = moved ? { x: 2 * last.x - (r.x1 + r.x2) / 2, y: 2 * last.y - (r.y1 + r.y2) / 2 } : (() => {
          // 弦に対して制御点を折り返す
          const m = mul(add({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }), 0.5);
          return sub(mul(m, 2), { x: r.cx ?? m.x, y: r.cy ?? m.y });
        })();
        store.commit(edit(doc, (d) => Object.assign(d.arrows[r.id], { cx: c.x, cy: c.y })));
        return;
      }
      const headHit = moved ? hitAt(ctx, p) : null;
      const head = moved ? snapEnd(ctx, p, headHit) : add(tail!, { x: ARROW_LEN * 0.6, y: 0 });
      if (dist(head, tail!) < 2) return;
      const c = defaultControl(tail!, head, shift);
      store.commit(addArrow(doc, tail!, head, 'curved', { cx: c.x, cy: c.y, ...(half ? { half: true } : {}) }));
    },
  };
}

/** 離した所の原子・結合（曲がった矢印の頭を寄せる先） */
function hitAt(ctx: Ctx, p: P): string | null {
  const doc = ctx.store.get().doc;
  let best: string | null = null;
  let bd = 6;
  for (const a of Object.values(doc.atoms)) {
    const d = dist(a, p);
    if (d < bd) {
      bd = d;
      best = a.id;
    }
  }
  if (best) return best;
  for (const b of Object.values(doc.bonds)) {
    const d = dist(mul(add(doc.atoms[b.a1], doc.atoms[b.a2]), 0.5), p);
    if (d < bd) {
      bd = d;
      best = b.id;
    }
  }
  return best;
}

function arrowSession(ctx: Ctx, kind: ArrowKind, start: P, hit: string | null, extra: Pick<ArrowExtra, 'dashed' | 'noGo'> = {}): Session {
  const { store } = ctx;
  let end: P | null = null;
  return {
    move(p) {
      if (dist(p, start) < CLICK_TOL * 2) return;
      const ang = snapAngle(angleOf(sub(p, start)), Math.PI / 12);
      end = add(start, fromAngle(ang, dist(p, start)));
      const lay = layout({ atoms: {}, bonds: {}, arrows: { tmp: { id: 'tmp', x1: start.x, y1: start.y, x2: end.x, y2: end.y, kind, ...extra } }, texts: {}, pluses: {}, groups: {}, nextId: 0 });
      ctx.setPreview({ prims: lay.prims });
    },
    up() {
      ctx.setPreview(null);
      const doc = store.get().doc;
      if (end) store.commit(addArrow(doc, start, end, kind, extra));
      else if (hit && kindOf(hit) === 'arrow') store.commit(setArrowKind(doc, hit, kind, extra));
      else if (!hit) store.commit(addArrow(doc, start, add(start, { x: ARROW_LEN, y: 0 }), kind, extra));
    },
  };
}

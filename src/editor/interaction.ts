// ツールごとのマウス操作。押した時に Session を作り、動かす・離すをそれに渡す。
import { angleOf, dist, snapAngle, sub, type P } from '../chem/geometry';
import { kindOf } from '../chem/model';
import {
  bondAtPoint, clickBond, deleteItems, drawBond, extendFromAtom, snapBondEnd, type BondTool,
} from '../chem/ops';
import { addChain, chainPoints } from '../chem/chain';
import type { Layout, Prim } from '../render/layout';
import type { EditorStore } from './store';

/** 動かしている間のキー（押した後に押したキーも分かるように、移動ごとに渡す） */
export interface MoveKeys {
  shift: boolean;
  alt: boolean;
}

export interface Session {
  move(p: P, keys?: MoveKeys): void;
  up(p: P, keys?: MoveKeys): void;
}

export interface Preview {
  prims: Prim[];
  /** 選択範囲の枠・投げ縄 */
  outline?: P[];
}

export interface Ctx {
  store: EditorStore;
  layout: Layout;
  setPreview(p: Preview | null): void;
  /** 原子ラベルの入力欄を開く */
  openLabelEditor?(atomId: string): void;
  openTextEditor?(textId: string | null, at: P): void;
}

/** クリックとみなす移動量（pt） */
export const CLICK_TOL = 3;

const BOND_TOOLS: BondTool[] = ['single', 'double', 'triple', 'wedge', 'hash', 'wavy', 'bold', 'dashed', 'dative'];
export const isBondTool = (t: string): t is BondTool => (BOND_TOOLS as string[]).includes(t);

export function beginSession(ctx: Ctx, start: P, hit: string | null, ev: { shift: boolean; alt: boolean }): Session | null {
  const { store } = ctx;
  const tool = store.get().tool;
  if (isBondTool(tool)) return bondSession(ctx, tool, start, hit);
  if (tool === 'chain') return chainSession(ctx, start, hit);
  if (tool === 'erase') {
    return {
      move() {},
      up() {
        if (hit) store.commit(deleteItems(store.get().doc, [hit]));
      },
    };
  }
  return extraSession(ctx, tool, start, hit, ev);
}

/** 段階2以降のツール（選択・環・矢印など）。ここに足していく */
let extraSession: (ctx: Ctx, tool: string, start: P, hit: string | null, ev: { shift: boolean; alt: boolean }) => Session | null = () => null;
export function registerExtraTools(fn: typeof extraSession) {
  extraSession = fn;
}

function bondSession(ctx: Ctx, tool: BondTool, start: P, hit: string | null): Session {
  const { store } = ctx;
  const doc = store.get().doc;
  const fromAtom = hit && kindOf(hit) === 'atom' ? doc.atoms[hit] : undefined;
  const origin: P = fromAtom ? { x: fromAtom.x, y: fromAtom.y } : start;
  let dragging = false;
  let end: P | null = null;
  return {
    move(p) {
      if (!dragging && dist(p, start) < CLICK_TOL) return;
      dragging = true;
      end = snapBondEnd(doc, origin, p, fromAtom?.id);
      ctx.setPreview({ prims: [{ k: 'line', a: origin, b: end, w: 0.6, owner: '' }] });
    },
    up() {
      ctx.setPreview(null);
      if (dragging && end) {
        store.commit(drawBond(doc, fromAtom ? fromAtom.id : origin, end, tool));
      } else if (fromAtom) {
        store.commit(extendFromAtom(doc, fromAtom.id, tool));
      } else if (hit && kindOf(hit) === 'bond') {
        store.commit(clickBond(doc, hit, tool));
      } else if (!hit) {
        store.commit(bondAtPoint(doc, start, tool));
      }
    },
  };
}

function chainSession(ctx: Ctx, start: P, hit: string | null): Session {
  const { store } = ctx;
  const doc = store.get().doc;
  const fromAtom = hit && kindOf(hit) === 'atom' ? doc.atoms[hit] : undefined;
  const origin: P = fromAtom ? { x: fromAtom.x, y: fromAtom.y } : start;
  let pts: P[] | null = null;
  return {
    move(p) {
      if (dist(p, origin) < CLICK_TOL * 2) return;
      const ang = snapAngle(angleOf(sub(p, origin)), Math.PI / 6);
      pts = chainPoints(doc, origin, ang, dist(p, origin), fromAtom?.id);
      const prims: Prim[] = [];
      for (let i = 0; i + 1 < pts.length; i++) prims.push({ k: 'line', a: pts[i], b: pts[i + 1], w: 0.6, owner: '' });
      const tip = pts.at(-1)!;
      prims.push({ k: 'text', run: { text: String(pts.length - 1), x: tip.x + 4, y: tip.y - 4, size: 7 }, owner: '' });
      ctx.setPreview({ prims });
    },
    up() {
      ctx.setPreview(null);
      if (pts && pts.length > 1) store.commit(addChain(doc, pts, fromAtom?.id));
      else if (fromAtom) store.commit(extendFromAtom(doc, fromAtom.id, 'single'));
      else if (!hit) store.commit(bondAtPoint(doc, start, 'single'));
    },
  };
}


// 選択した物の移動・回転・反転・複製
import { add, rectOfPoints, rotate, type P, type Rect } from './geometry';
import type { Doc } from './model';
import { edit, kindOf, newId, remapUnits } from './model';
import { MERGE_DIST, atomAt } from './ops';

/** 選択から、動かす原子（結合を選んだらその両端も）と図形の id */
export function expandSelection(doc: Doc, sel: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of sel) {
    out.add(id);
    const b = doc.bonds[id];
    if (b) {
      out.add(b.a1);
      out.add(b.a2);
    }
  }
  return out;
}

/** 選んだ原子の両端がそろっている結合も選択に入れる */
export function withInnerBonds(doc: Doc, sel: Set<string>): Set<string> {
  const out = new Set(sel);
  for (const b of Object.values(doc.bonds)) if (sel.has(b.a1) && sel.has(b.a2)) out.add(b.id);
  return out;
}

export function selectionPoints(doc: Doc, sel: Iterable<string>): P[] {
  const pts: P[] = [];
  for (const id of expandSelection(doc, sel)) {
    const k = kindOf(id);
    if (k === 'atom' && doc.atoms[id]) pts.push(doc.atoms[id]);
    else if (k === 'arrow' && doc.arrows[id]) {
      const r = doc.arrows[id];
      pts.push({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 });
      if (r.cx !== undefined && r.cy !== undefined) pts.push({ x: r.cx, y: r.cy });
    } else if (k === 'text' && doc.texts[id]) pts.push(doc.texts[id]);
    else if (k === 'plus' && doc.pluses[id]) pts.push(doc.pluses[id]);
    else if (k === 'shape' && doc.shapes?.[id]) {
      const s = doc.shapes[id];
      pts.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
    }
  }
  return pts;
}

export function selectionBBox(doc: Doc, sel: Iterable<string>): Rect | null {
  return rectOfPoints(selectionPoints(doc, sel));
}

/** 選択の各点に f を当てる */
export function mapSelection(doc: Doc, sel: Iterable<string>, f: (p: P) => P): Doc {
  const ids = expandSelection(doc, sel);
  return edit(doc, (d) => {
    for (const id of ids) {
      const a = d.atoms[id];
      if (a) {
        const q = f(a);
        a.x = q.x;
        a.y = q.y;
        continue;
      }
      const r = d.arrows[id];
      if (r) {
        const q1 = f({ x: r.x1, y: r.y1 });
        const q2 = f({ x: r.x2, y: r.y2 });
        Object.assign(r, { x1: q1.x, y1: q1.y, x2: q2.x, y2: q2.y });
        // 曲がった矢印の制御点も同じように動かす（回転・反転でも形が保たれる）
        if (r.cx !== undefined && r.cy !== undefined) {
          const c = f({ x: r.cx, y: r.cy });
          Object.assign(r, { cx: c.x, cy: c.y });
        }
        continue;
      }
      const sh = d.shapes?.[id];
      if (sh) {
        const q1 = f({ x: sh.x1, y: sh.y1 });
        const q2 = f({ x: sh.x2, y: sh.y2 });
        Object.assign(sh, { x1: q1.x, y1: q1.y, x2: q2.x, y2: q2.y });
        continue;
      }
      const t = d.texts[id] ?? d.pluses[id];
      if (t) {
        const q = f(t);
        t.x = q.x;
        t.y = q.y;
      }
    }
  });
}

export const moveSelection = (doc: Doc, sel: Iterable<string>, delta: P) => mapSelection(doc, sel, (p) => add(p, delta));

export function rotateSelection(doc: Doc, sel: Iterable<string>, ang: number, center: P): Doc {
  return mapSelection(doc, sel, (p) => rotate(p, ang, center));
}

export function flipSelection(doc: Doc, sel: Iterable<string>, axis: 'h' | 'v'): Doc {
  const box = selectionBBox(doc, sel);
  if (!box) return doc;
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  return mapSelection(doc, sel, (p) => (axis === 'h' ? { x: 2 * cx - p.x, y: p.y } : { x: p.x, y: 2 * cy - p.y }));
}

/** 動かした原子が別の原子に重なったら1つにまとめる（ChemDraw と同じ） */
export function mergeOverlaps(doc: Doc, moved: Set<string>): Doc {
  const pairs: [string, string][] = [];
  for (const id of moved) {
    const a = doc.atoms[id];
    if (!a) continue;
    const t = atomAt(doc, a, MERGE_DIST, moved);
    if (t) pairs.push([id, t.id]);
  }
  if (!pairs.length) return doc;
  return edit(doc, (d) => {
    for (const [from, to] of pairs) {
      for (const b of Object.values(d.bonds)) {
        if (b.a1 === from) b.a1 = to;
        if (b.a2 === from) b.a2 = to;
      }
      delete d.atoms[from];
    }
    // 両端が同じになった結合と、重複した結合を消す
    const seen = new Set<string>();
    for (const b of Object.values(d.bonds)) {
      const key = [b.a1, b.a2].sort().join('-');
      if (b.a1 === b.a2 || seen.has(key)) delete d.bonds[b.id];
      else seen.add(key);
    }
  });
}

/** 選択の部分を取り出した doc（コピー用） */
export function extract(doc: Doc, sel: Iterable<string>): Doc {
  const ids = withInnerBonds(doc, expandSelection(doc, sel));
  return edit(doc, (d) => {
    for (const k of ['atoms', 'bonds', 'arrows', 'texts', 'pluses'] as const) {
      for (const id of Object.keys(d[k])) if (!ids.has(id)) delete d[k][id];
    }
    for (const id of Object.keys(d.shapes ?? {})) if (!ids.has(id)) delete d.shapes![id];
    for (const b of Object.values(d.bonds)) if (!d.atoms[b.a1] || !d.atoms[b.a2]) delete d.bonds[b.id];
    for (const g of Object.values(d.groups)) if (g.atomIds.some((x) => !d.atoms[x])) delete d.groups[g.id];
  });
}

/** part の中身を、id を振り直して doc に足す。足した物の id を返す */
export function insertDoc(doc: Doc, part: Doc, offset: P): { doc: Doc; ids: Set<string> } {
  const ids = new Set<string>();
  const out = edit(doc, (d) => {
    const map = new Map<string, string>();
    for (const a of Object.values(part.atoms)) {
      const id = newId(d, 'a');
      map.set(a.id, id);
      d.atoms[id] = { ...a, id, x: a.x + offset.x, y: a.y + offset.y };
      ids.add(id);
    }
    // 貼り付けた分子のまとまり（塩）は、元のまとまりと別にする
    remapUnits([...map.values()].map((id) => d.atoms[id]), () => newId(d, 'u'));
    for (const b of Object.values(part.bonds)) {
      const id = newId(d, 'b');
      d.bonds[id] = { ...b, id, a1: map.get(b.a1)!, a2: map.get(b.a2)! };
      ids.add(id);
    }
    for (const r of Object.values(part.arrows)) {
      const id = newId(d, 'r');
      d.arrows[id] = { ...r, id, x1: r.x1 + offset.x, y1: r.y1 + offset.y, x2: r.x2 + offset.x, y2: r.y2 + offset.y };
      if (r.cx !== undefined && r.cy !== undefined) Object.assign(d.arrows[id], { cx: r.cx + offset.x, cy: r.cy + offset.y });
      ids.add(id);
    }
    for (const t of Object.values(part.texts)) {
      const id = newId(d, 't');
      d.texts[id] = { ...t, id, x: t.x + offset.x, y: t.y + offset.y };
      ids.add(id);
    }
    for (const p of Object.values(part.pluses)) {
      const id = newId(d, 'p');
      d.pluses[id] = { ...p, id, x: p.x + offset.x, y: p.y + offset.y };
      ids.add(id);
    }
    for (const s of Object.values(part.shapes ?? {})) {
      const id = newId(d, 'h');
      d.shapes ??= {};
      d.shapes[id] = { ...s, id, x1: s.x1 + offset.x, y1: s.y1 + offset.y, x2: s.x2 + offset.x, y2: s.y2 + offset.y };
      ids.add(id);
    }
    for (const g of Object.values(part.groups)) {
      const id = newId(d, 'g');
      d.groups[id] = { ...g, id, atomIds: g.atomIds.map((x) => map.get(x)!), attachId: map.get(g.attachId)! };
    }
  });
  return { doc: out, ids };
}


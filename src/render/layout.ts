// 文書を描画の図形（線・多角形・文字）に変換する。画面の描画と SVG/PNG の書き出しで共用する。
import { stereoGroupLabels } from '../chem/stereoGroups';
import {
  add, clipParams, dist, dot, inflate, mul, norm, rectUnion, rightNormal, sideOf, sub,
  type P, type Rect,
} from '../chem/geometry';
import type { Adjacency, Arrow, Atom, Bond, Doc, DoublePos, Shape } from '../chem/model';
import { adjacency, otherEnd } from '../chem/model';
import { smallestRings } from '../chem/rings';
import { ACS, applyDrawStyle, DOUBLE_GAP, WEDGE_WIDTH } from '../chem/style';
import { atomLabel, type AtomLabel } from './labels';
import { CAP_HEIGHT, formulaRuns, hasRich, parseRich, SUB_DROP, SUB_SCALE, SUP_RISE, textWidth, type Run } from './text';

export type Prim =
  | { k: 'line'; a: P; b: P; w: number; owner: string; color?: string }
  | { k: 'poly'; pts: P[]; owner: string; color?: string }
  | { k: 'path'; d: string; w: number; owner: string; color?: string }
  | { k: 'text'; run: Run; owner: string; color?: string }
  /** 1行の文字。下付き・上付きは前の文字からの続きで描く（字幅の見積もりのずれがたまらない） */
  | { k: 'tline'; x: number; y: number; runs: TRun[]; bold?: boolean; owner: string; color?: string };

/** 1 行の文字の中の 1 かたまり。shift は上下のずれ（下が正） */
export interface TRun {
  text: string;
  size: number;
  shift: number;
  italic?: boolean;
  bold?: boolean;
}

/** 描く図形の色（無ければ黒）。物の色（Atom・Bond などの color）から、layout が付ける */
export type Colored = { color?: string };

export interface Layout {
  prims: Prim[];
  labels: Map<string, AtomLabel>;
  /** 文字の箱（当たり判定用） */
  textBoxes: Map<string, Rect>;
  bbox: Rect | null;
}

/** 線の太さ（図の設定で変わるので、描くたびに読む） */
const lw = () => ACS.lineWidth;

export function layout(doc: Doc): Layout {
  const restore = applyDrawStyle(doc.drawStyle);
  try {
    return layoutNow(doc);
  } finally {
    restore();
  }
}

function layoutNow(doc: Doc): Layout {
  const adj = adjacency(doc);
  const labels = new Map<string, AtomLabel>();
  const prims: Prim[] = [];
  for (const a of Object.values(doc.atoms)) {
    const l = atomLabel(a, doc, adj);
    if (l) labels.set(a.id, l);
  }
  const rings = smallestRings(doc, adj);
  for (const b of Object.values(doc.bonds)) drawBond(prims, b, doc, adj, labels, rings);
  for (const [id, l] of labels) for (const run of l.runs) prims.push({ k: 'text', run, owner: id });
  for (const a of Object.values(doc.atoms)) if (a.radical || a.lonePairs) drawElectrons(prims, a, doc, adj, labels.get(a.id));
  // rac・rel の印（分子の下の「rac」、中心ごとの「&1」「or1」）。src/chem/stereoGroups.ts
  for (const g of stereoGroupLabels(doc)) {
    const size = ACS.labelSize * 0.8;
    prims.push({ k: 'text', run: { text: g.text, x: g.x - textWidth(g.text, size) / 2, y: g.y + (CAP_HEIGHT * size) / 2, size }, owner: g.owner });
  }
  for (const r of Object.values(doc.arrows)) drawArrow(prims, r);
  for (const s of Object.values(doc.shapes ?? {})) drawShape(prims, s);
  for (const p of Object.values(doc.pluses)) {
    const s = 3.6;
    prims.push({ k: 'line', a: { x: p.x - s, y: p.y }, b: { x: p.x + s, y: p.y }, w: lw(), owner: p.id });
    prims.push({ k: 'line', a: { x: p.x, y: p.y - s }, b: { x: p.x, y: p.y + s }, w: lw(), owner: p.id });
  }
  const textBoxes = new Map<string, Rect>();
  for (const t of Object.values(doc.texts)) {
    const lines = t.text.split('\n');
    const lh = ACS.captionSize * 1.2;
    let box: Rect | null = null;
    lines.forEach((s, i) => {
      const y = t.y + i * lh;
      const runs = textRuns(s, !!t.formula);
      prims.push({ k: 'tline', x: t.x, y, runs, bold: t.bold, owner: t.id });
      const w = runs.reduce((acc, r) => acc + textWidth(r.text, r.size) * (t.bold || r.bold ? 1.08 : 1), 0);
      box = rectUnion(box, { x1: t.x, y1: y - CAP_HEIGHT * ACS.captionSize, x2: t.x + Math.max(w, 4), y2: y + 2 });
    });
    if (box) textBoxes.set(t.id, box);
  }
  // 物の色を、その物の図形に付ける（原子の色はラベルと電子の点に）
  const colorOf = new Map<string, string>();
  for (const rec of [doc.atoms, doc.bonds, doc.arrows, doc.texts, doc.pluses, doc.shapes ?? {}] as Record<string, { id: string; color?: string }>[]) {
    for (const o of Object.values(rec)) if (o.color) colorOf.set(o.id, o.color);
  }
  if (colorOf.size) for (const p of prims) if (colorOf.has(p.owner)) p.color = colorOf.get(p.owner);
  return { prims, labels, textBoxes, bbox: primsBBox(prims) };
}

export function primsBBox(prims: Prim[]): Rect | null {
  let r: Rect | null = null;
  for (const p of prims) {
    if (p.k === 'line') {
      r = rectUnion(r, { x1: Math.min(p.a.x, p.b.x), y1: Math.min(p.a.y, p.b.y), x2: Math.max(p.a.x, p.b.x), y2: Math.max(p.a.y, p.b.y) });
    } else if (p.k === 'poly') {
      for (const q of p.pts) r = rectUnion(r, { x1: q.x, y1: q.y, x2: q.x, y2: q.y });
    } else if (p.k === 'text') {
      const t = p.run;
      r = rectUnion(r, { x1: t.x, y1: t.y - t.size * 0.8, x2: t.x + textWidth(t.text, t.size), y2: t.y + t.size * 0.25 });
    } else if (p.k === 'tline') {
      const w = p.runs.reduce((acc, x) => acc + textWidth(x.text, x.size), 0) * (p.bold ? 1.08 : 1);
      r = rectUnion(r, { x1: p.x, y1: p.y - ACS.captionSize * 0.8, x2: p.x + w, y2: p.y + ACS.captionSize * 0.45 });
    } else {
      const nums = p.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      for (let i = 0; i + 1 < nums.length; i += 2) r = rectUnion(r, { x1: nums[i], y1: nums[i + 1], x2: nums[i], y2: nums[i + 1] });
    }
  }
  return r;
}

/**
 * 文字の欄の 1 行を、描く文字のかたまりにする。化学式の書き方（CH2Cl2 の 2 を下付き）なら英字の後の数字を下付きに、
 * 書き方の印（^{…}・_{…}・*…*・**…**。src/render/text.ts の parseRich）があれば上付き・下付き・斜体・太字にする
 */
export function textRuns(s: string, formula: boolean): TRun[] {
  const size = ACS.captionSize;
  const plain = (text: string, extra: Partial<TRun> = {}): TRun[] =>
    formula ? formulaRuns(text, size, 0).runs.map((r) => ({ text: r.text, size: r.size, shift: r.y, ...extra })) : [{ text, size, shift: 0, ...extra }];
  if (!hasRich(s)) return plain(s);
  const out: TRun[] = [];
  for (const seg of parseRich(s)) {
    const extra: Partial<TRun> = { ...(seg.italic ? { italic: true } : {}), ...(seg.bold ? { bold: true } : {}) };
    if (seg.script === 'sup') out.push({ text: seg.text, size: size * SUB_SCALE, shift: -size * SUP_RISE, ...extra });
    else if (seg.script === 'sub') out.push({ text: seg.text, size: size * SUB_SCALE, shift: size * SUB_DROP, ...extra });
    else out.push(...plain(seg.text, extra));
  }
  return out;
}

/** a→b の線分を、両端の原子ラベルの外側まで切る */
function clipToLabels(a: P, b: P, la?: AtomLabel, lb?: AtomLabel): [P, P] | null {
  let t0 = 0;
  let t1 = 1;
  const m = ACS.marginWidth;
  for (const box of la?.boxes ?? []) {
    const c = clipParams(a, b, inflate(box, m));
    if (c && c[0] < 0.5) t0 = Math.max(t0, c[1]);
  }
  for (const box of lb?.boxes ?? []) {
    const c = clipParams(a, b, inflate(box, m));
    if (c && c[1] > 0.5) t1 = Math.min(t1, c[0]);
  }
  if (t1 - t0 < 0.02) return null;
  const d = sub(b, a);
  return [add(a, mul(d, t0)), add(a, mul(d, t1))];
}

/** 二重結合の2本目の線を置く側（自動のとき） */
export function resolveDoubleSide(
  b: Bond,
  doc: Doc,
  adj: Adjacency,
  rings: Map<string, string[]>,
): Exclude<DoublePos, 'auto'> {
  if (b.doublePos !== 'auto') return b.doublePos;
  const p1 = doc.atoms[b.a1];
  const p2 = doc.atoms[b.a2];
  const ring = rings.get(b.id);
  if (ring) {
    const c = ring.reduce((s, id) => add(s, doc.atoms[id]), { x: 0, y: 0 });
    const center = mul(c, 1 / ring.length);
    return sideOf(center, p1, p2) > 0 ? 'right' : 'left';
  }
  const n1 = (adj.bondsOf.get(b.a1) ?? []).filter((x) => x.id !== b.id).map((x) => otherEnd(x, b.a1));
  const n2 = (adj.bondsOf.get(b.a2) ?? []).filter((x) => x.id !== b.id).map((x) => otherEnd(x, b.a2));
  if (n1.length === 0 && n2.length === 0) return 'center';
  // 片側が末端（C=O など）で、反対側に置換基が2つ以上あれば中央に置く
  if ((n1.length === 0 && n2.length !== 1) || (n2.length === 0 && n1.length !== 1)) return 'center';
  let right = 0;
  let left = 0;
  for (const n of [...n1, ...n2]) {
    const s = sideOf(doc.atoms[n], p1, p2);
    if (s > 1e-6) right++;
    else if (s < -1e-6) left++;
  }
  if (right > left) return 'right';
  if (left > right) return 'left';
  const first = n1[0] ?? n2[0];
  return sideOf(doc.atoms[first], p1, p2) >= 0 ? 'right' : 'left';
}

/** 内側の線の端を、隣の結合との角度に合わせて縮める量 */
function innerTrim(atomId: string, otherId: string, side: number, doc: Doc, adj: Adjacency, hasLabel: boolean): number {
  if (hasLabel) return 0;
  const a = doc.atoms[atomId];
  const dir = norm(sub(doc.atoms[otherId], a));
  let best = Infinity;
  for (const bb of adj.bondsOf.get(atomId) ?? []) {
    const n = otherEnd(bb, atomId);
    if (n === otherId) continue;
    const p = doc.atoms[n];
    const s = sideOf(p, a, doc.atoms[otherId]);
    if (s * side <= 0) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(dir, norm(sub(p, a))))));
    best = Math.min(best, ang);
  }
  if (!isFinite(best)) return 0;
  return Math.min(DOUBLE_GAP / Math.tan(best / 2), ACS.bondLength * 0.4);
}

function drawBond(prims: Prim[], b: Bond, doc: Doc, adj: Adjacency, labels: Map<string, AtomLabel>, rings: Map<string, string[]>) {
  const A = doc.atoms[b.a1];
  const B = doc.atoms[b.a2];
  if (!A || !B) return;
  const la = labels.get(b.a1);
  const lb = labels.get(b.a2);
  const d = norm(sub(B, A));
  const n = rightNormal(d);
  const owner = b.id;

  if (b.order === 1 && b.stereo !== 'none') {
    const seg = clipToLabels(A, B, la, lb);
    if (!seg) return;
    const [q1, q2] = seg;
    const L = dist(q1, q2);
    const t0 = dist(A, q1) / dist(A, B);
    // くさびの幅は元の結合の長さに対して決める（ラベルで切っても形を保つ）
    const widthAt = (t: number) => (WEDGE_WIDTH * t) / 1;
    if (b.stereo === 'bold') {
      const w = ACS.boldWidth / 2;
      prims.push({ k: 'poly', pts: [add(q1, mul(n, w)), add(q2, mul(n, w)), add(q2, mul(n, -w)), add(q1, mul(n, -w))], owner });
    } else if (b.stereo === 'dashed') {
      shaft(prims, q1, q2, owner, true);
    } else if (b.stereo === 'dative') {
      // 配位結合: a1（供与する側）から a2 へ向く矢印
      shaft(prims, q1, add(q2, mul(d, -HEAD_LEN * 0.45)), owner);
      const hl = HEAD_LEN * 0.75;
      const back = add(q2, mul(d, -hl));
      prims.push({ k: 'poly', pts: [q2, add(back, mul(n, HEAD_W * 0.8)), add(q2, mul(d, -hl * 0.8)), add(back, mul(n, -HEAD_W * 0.8))], owner });
    } else if (b.stereo === 'wedge') {
      const w1 = widthAt(t0) / 2;
      const w2 = widthAt(dist(A, q2) / dist(A, B)) / 2;
      prims.push({ k: 'poly', pts: [add(q1, mul(n, w1)), add(q2, mul(n, w2)), add(q2, mul(n, -w2)), add(q1, mul(n, -w1))], owner });
    } else if (b.stereo === 'hash') {
      const count = Math.max(2, Math.round(L / ACS.hashSpacing));
      for (let i = 0; i <= count; i++) {
        const p = add(q1, mul(d, (L * i) / count));
        const w = Math.max(widthAt(dist(A, p) / dist(A, B)), lw() * 1.2) / 2;
        prims.push({ k: 'line', a: add(p, mul(n, w)), b: add(p, mul(n, -w)), w: lw(), owner });
      }
    } else {
      // 波線: 半円をつないだ形
      const waves = Math.max(2, Math.round(L / 2.4));
      const step = L / waves;
      const amp = 0.9;
      let path = `M${f(q1.x)} ${f(q1.y)}`;
      for (let i = 0; i < waves; i++) {
        const c = add(add(q1, mul(d, step * (i + 0.5))), mul(n, i % 2 === 0 ? amp * 2 : -amp * 2));
        const e = add(q1, mul(d, step * (i + 1)));
        path += ` Q${f(c.x)} ${f(c.y)} ${f(e.x)} ${f(e.y)}`;
      }
      prims.push({ k: 'path', d: path, w: lw(), owner });
    }
    return;
  }

  const line = (a: P, c: P) => {
    const seg = clipToLabels(a, c, la, lb);
    if (seg) prims.push({ k: 'line', a: seg[0], b: seg[1], w: lw(), owner });
  };

  if (b.order === 1) {
    line(A, B);
  } else if (b.order === 3) {
    line(A, B);
    line(add(A, mul(n, DOUBLE_GAP)), add(B, mul(n, DOUBLE_GAP)));
    line(add(A, mul(n, -DOUBLE_GAP)), add(B, mul(n, -DOUBLE_GAP)));
  } else {
    const side = resolveDoubleSide(b, doc, adj, rings);
    if (side === 'center') {
      const o = mul(n, DOUBLE_GAP / 2);
      line(add(A, o), add(B, o));
      line(sub(A, o), sub(B, o));
    } else {
      const s = side === 'right' ? 1 : -1;
      line(A, B);
      const o = mul(n, DOUBLE_GAP * s);
      const tA = innerTrim(b.a1, b.a2, s, doc, adj, !!la);
      // innerTrim は「端の原子 → 相手」の向きで左右を見るので、反対の端からは左右が逆になる
      const tB = innerTrim(b.a2, b.a1, -s, doc, adj, !!lb);
      line(add(add(A, o), mul(d, tA)), add(add(B, o), mul(d, -tB)));
    }
  }
}

/** 図形: 四角・楕円・括弧の組 */
function drawShape(prims: Prim[], s: Shape) {
  const x1 = Math.min(s.x1, s.x2);
  const x2 = Math.max(s.x1, s.x2);
  const y1 = Math.min(s.y1, s.y2);
  const y2 = Math.max(s.y1, s.y2);
  const owner = s.id;
  const line = (a: P, b: P) => prims.push({ k: 'line', a, b, w: lw(), owner });
  if (s.kind === 'rect') {
    line({ x: x1, y: y1 }, { x: x2, y: y1 });
    line({ x: x2, y: y1 }, { x: x2, y: y2 });
    line({ x: x2, y: y2 }, { x: x1, y: y2 });
    line({ x: x1, y: y2 }, { x: x1, y: y1 });
    return;
  }
  if (s.kind === 'oval') {
    // 楕円を 4 つの 3 次ベジエでつなぐ（k は円に近づける決まった値）
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = (x2 - x1) / 2;
    const ry = (y2 - y1) / 2;
    const k = 0.5523;
    const P = (x: number, y: number) => `${f(x)} ${f(y)}`;
    const d =
      `M${P(cx + rx, cy)} C${P(cx + rx, cy + k * ry)} ${P(cx + k * rx, cy + ry)} ${P(cx, cy + ry)}` +
      ` C${P(cx - k * rx, cy + ry)} ${P(cx - rx, cy + k * ry)} ${P(cx - rx, cy)}` +
      ` C${P(cx - rx, cy - k * ry)} ${P(cx - k * rx, cy - ry)} ${P(cx, cy - ry)}` +
      ` C${P(cx + k * rx, cy - ry)} ${P(cx + rx, cy - k * ry)} ${P(cx + rx, cy)}`;
    prims.push({ k: 'path', d, w: lw(), owner });
    return;
  }
  // 括弧の組。高さに合わせて、角の長さ・ふくらみを決める
  const h = y2 - y1;
  const tick = Math.min(4, Math.max(2, h * 0.12));
  const ym = (y1 + y2) / 2;
  for (const [x, dir] of [[x1, 1], [x2, -1]] as const) {
    if (s.kind === 'bracket-square') {
      line({ x: x + dir * tick, y: y1 }, { x, y: y1 });
      line({ x, y: y1 }, { x, y: y2 });
      line({ x, y: y2 }, { x: x + dir * tick, y: y2 });
    } else if (s.kind === 'bracket-round') {
      const b = Math.min(5, h * 0.12);
      prims.push({ k: 'path', d: `M${f(x + dir * b)} ${f(y1)} Q${f(x - dir * b)} ${f(ym)} ${f(x + dir * b)} ${f(y2)}`, w: lw(), owner });
    } else {
      // 波かっこ: 上下の弧と、まん中のとがり
      const b = Math.min(3, h * 0.08);
      prims.push({
        k: 'path',
        d: `M${f(x + dir * b * 1.5)} ${f(y1)} Q${f(x)} ${f(y1)} ${f(x)} ${f(y1 + b * 1.5)} L${f(x)} ${f(ym - b)} Q${f(x)} ${f(ym)} ${f(x - dir * b)} ${f(ym)} Q${f(x)} ${f(ym)} ${f(x)} ${f(ym + b)} L${f(x)} ${f(y2 - b * 1.5)} Q${f(x)} ${f(y2)} ${f(x + dir * b * 1.5)} ${f(y2)}`,
        w: lw(),
        owner,
      });
    }
  }
}

/** 点（電子）。小さな八角形 */
function electronDot(prims: Prim[], c: P, owner: string) {
  const r = 0.75;
  prims.push({ k: 'poly', pts: Array.from({ length: 8 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 4), y: c.y + r * Math.sin((i * Math.PI) / 4) })), owner });
}

/**
 * ラジカル（点 1 つ）とローンペア（点 2 つ）を、結合の無い向きに置く。
 * 向きの候補は上・右・下・左・斜めの順で、結合から遠い向きを選ぶ
 */
function drawElectrons(prims: Prim[], a: Atom, doc: Doc, adj: Adjacency, label?: AtomLabel) {
  const bondAngles = (adj.bondsOf.get(a.id) ?? []).map((b) => {
    const o = doc.atoms[b.a1 === a.id ? b.a2 : b.a1];
    return Math.atan2(o.y - a.y, o.x - a.x);
  });
  const prefs = [-90, 0, 90, 180, -45, 45, 135, -135].map((d) => (d * Math.PI) / 180);
  const gap = (t: number) => (bondAngles.length ? Math.min(...bondAngles.map((b) => Math.abs(Math.atan2(Math.sin(t - b), Math.cos(t - b))))) : Math.PI);
  // 結合から 50 度より離れた向きを、好みの順に使う。足りなければ離れている順
  const free = prefs.filter((t) => gap(t) > (50 * Math.PI) / 180);
  const order = [...free, ...prefs.filter((t) => !free.includes(t)).sort((x, y) => gap(y) - gap(x))];
  const marks: ('pair' | 'single')[] = [...(a.radical ? ['single' as const] : []), ...Array.from({ length: a.lonePairs ?? 0 }, () => 'pair' as const)];
  marks.forEach((m, i) => {
    const t = order[i % order.length];
    const dir = { x: Math.cos(t), y: Math.sin(t) };
    // 原子のラベルがあれば、その外側に置く
    let r = 3.2;
    for (const box of label?.boxes ?? []) {
      const hx = (box.x2 - box.x1) / 2 + Math.abs(a.x - (box.x1 + box.x2) / 2);
      const hy = (box.y2 - box.y1) / 2 + Math.abs(a.y - (box.y1 + box.y2) / 2);
      const exit = Math.min(Math.abs(dir.x) > 1e-6 ? hx / Math.abs(dir.x) : Infinity, Math.abs(dir.y) > 1e-6 ? hy / Math.abs(dir.y) : Infinity);
      r = Math.max(r, exit + 1.6);
    }
    const c = add(a, mul(dir, r));
    if (m === 'single') electronDot(prims, c, a.id);
    else {
      const side = mul(rightNormal(dir), 1.25);
      electronDot(prims, add(c, side), a.id);
      electronDot(prims, sub(c, side), a.id);
    }
  });
}

/** 線を、点線なら短い線に分けて描く */
function shaft(prims: Prim[], a: P, b: P, owner: string, dashed?: boolean, w = lw()) {
  if (!dashed) {
    prims.push({ k: 'line', a, b, w, owner });
    return;
  }
  const L = dist(a, b);
  const d = norm(sub(b, a));
  const dash = 2.4;
  const gap = 1.8;
  for (let t = 0; t < L; t += dash + gap) prims.push({ k: 'line', a: add(a, mul(d, t)), b: add(a, mul(d, Math.min(L, t + dash))), w: lw(), owner });
}

const HEAD_LEN = 7.2;
const HEAD_W = 2.6;

/** 塗った矢頭（head が先、d は進む向き）。half なら片側（進む向きの左）だけ */
function arrowHead(prims: Prim[], head: P, d: P, owner: string, half = false, len = HEAD_LEN, hw = HEAD_W) {
  const n = rightNormal(d);
  const back = add(head, mul(d, -len));
  const notch = add(head, mul(d, -len * 0.8));
  if (half) prims.push({ k: 'poly', pts: [head, add(back, mul(n, -hw)), notch], owner });
  else prims.push({ k: 'poly', pts: [head, add(back, mul(n, hw)), notch, add(back, mul(n, -hw))], owner });
}

function drawArrow(prims: Prim[], r: Arrow) {
  const tail: P = { x: r.x1, y: r.y1 };
  const head: P = { x: r.x2, y: r.y2 };
  const d = norm(sub(head, tail));
  const n = rightNormal(d);
  const owner = r.id;
  const headLen = HEAD_LEN;
  const headW = HEAD_W;
  if (r.kind === 'curved') {
    // 電子の動き: 尾 → 制御点 → 頭 の曲線。頭は曲線の終わりの向きに置く
    const c: P = r.cx !== undefined && r.cy !== undefined ? { x: r.cx, y: r.cy } : add(mul(add(tail, head), 0.5), mul(n, -dist(tail, head) * 0.3));
    const dir = norm(sub(head, c));
    const end = add(head, mul(dir, -headLen * 0.6));
    prims.push({ k: 'path', d: `M${f(tail.x)} ${f(tail.y)} Q${f(c.x)} ${f(c.y)} ${f(end.x)} ${f(end.y)}`, w: lw(), owner });
    arrowHead(prims, head, dir, owner, r.half);
    return;
  }
  if (r.kind === 'line') {
    shaft(prims, tail, head, owner, r.dashed);
  } else if (r.kind === 'normal') {
    // 太さを決めた矢印は、矢頭も太さに合わせて大きくする
    const w = r.weight && r.weight > 0 ? r.weight : lw();
    const len = Math.max(headLen, w * 1.5);
    const hw = Math.max(headW, w * 0.9);
    shaft(prims, tail, add(head, mul(d, -len * 0.6)), owner, r.dashed, w);
    arrowHead(prims, head, d, owner, false, len, hw);
  } else if (r.kind === 'resonance') {
    // 両向き（共鳴）
    shaft(prims, add(tail, mul(d, headLen * 0.6)), add(head, mul(d, -headLen * 0.6)), owner, r.dashed);
    arrowHead(prims, head, d, owner);
    arrowHead(prims, tail, mul(d, -1), owner);
  } else if (r.kind === 'equilibrium') {
    const g = 1.8;
    // 上の線は右向き（頭は上側の半分）、下の線は左向き
    const up = mul(n, -g);
    const t1 = add(tail, up);
    const h1 = add(head, up);
    prims.push({ k: 'line', a: t1, b: h1, w: lw(), owner });
    prims.push({ k: 'line', a: h1, b: add(add(h1, mul(d, -headLen)), mul(n, -headW * 1.3)), w: lw(), owner });
    const down = mul(n, g);
    const t2 = add(head, down);
    const h2 = add(tail, down);
    prims.push({ k: 'line', a: t2, b: h2, w: lw(), owner });
    prims.push({ k: 'line', a: h2, b: add(add(h2, mul(d, headLen)), mul(n, headW * 1.3)), w: lw(), owner });
  } else {
    const g = 2.0;
    const tipBack = headLen * 0.9;
    prims.push({ k: 'line', a: add(tail, mul(n, g)), b: add(add(head, mul(d, -tipBack * (g / (headW * 2)))), mul(n, g)), w: lw(), owner });
    prims.push({ k: 'line', a: add(tail, mul(n, -g)), b: add(add(head, mul(d, -tipBack * (g / (headW * 2)))), mul(n, -g)), w: lw(), owner });
    prims.push({ k: 'line', a: head, b: add(add(head, mul(d, -tipBack)), mul(n, headW * 2)), w: lw(), owner });
    prims.push({ k: 'line', a: head, b: add(add(head, mul(d, -tipBack)), mul(n, -headW * 2)), w: lw(), owner });
  }
  if (r.noGo) {
    // 進まない反応: 軸の中ほどに ✕
    const m = mul(add(tail, head), 0.5);
    const s = 3.4;
    const u = mul(add(d, n), s / Math.SQRT2);
    const v = mul(sub(d, n), s / Math.SQRT2);
    prims.push({ k: 'line', a: sub(m, u), b: add(m, u), w: lw(), owner });
    prims.push({ k: 'line', a: sub(m, v), b: add(m, v), w: lw(), owner });
  }
}

export const f = (v: number) => (Math.round(v * 100) / 100).toString();

/** 図形を SVG の要素の文字列にする（書き出し用） */
export function primsToSvg(prims: Prim[]): string {
  const out: string[] = [];
  for (const p of prims) {
    const c = escapeXml(p.color ?? '#000');
    if (p.k === 'line') {
      out.push(`<line x1="${f(p.a.x)}" y1="${f(p.a.y)}" x2="${f(p.b.x)}" y2="${f(p.b.y)}" stroke="${c}" stroke-width="${p.w}" stroke-linecap="round"/>`);
    } else if (p.k === 'poly') {
      out.push(`<polygon points="${p.pts.map((q) => `${f(q.x)},${f(q.y)}`).join(' ')}" fill="${c}" stroke="${c}" stroke-width="0.2" stroke-linejoin="round"/>`);
    } else if (p.k === 'path') {
      out.push(`<path d="${p.d}" fill="none" stroke="${c}" stroke-width="${p.w}" stroke-linecap="round"/>`);
    } else if (p.k === 'tline') {
      out.push(`<text x="${f(p.x)}" y="${f(p.y)}" font-family="${ACS.font}" font-size="${f(ACS.captionSize)}"${p.bold ? ' font-weight="bold"' : ''} fill="${c}">${tspans(p.runs)}</text>`);
    } else {
      out.push(
        `<text x="${f(p.run.x)}" y="${f(p.run.y)}" font-family="${ACS.font}" font-size="${f(p.run.size)}"${p.run.bold ? ' font-weight="bold"' : ''} fill="${c}">${escapeXml(p.run.text)}</text>`,
      );
    }
  }
  return out.join('\n');
}

/** 下付き・上付きを、前の文字からの続きの tspan にする（dy は前の文字からの相対） */
export function tspans(runs: TRun[]): string {
  let cur = 0;
  return runs
    .map((r) => {
      const dy = r.shift - cur;
      cur = r.shift;
      return `<tspan font-size="${f(r.size)}"${dy ? ` dy="${f(dy)}"` : ''}${r.italic ? ' font-style="italic"' : ''}${r.bold ? ' font-weight="bold"' : ''}>${escapeXml(r.text)}</tspan>`;
    })
    .join('');
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/** 構造だけを描いた小さな SVG（ライブラリの一覧の絵） */
export function structureSvg(doc: Doc, maxW = 120, maxH = 72): string {
  const lay = layout(doc);
  const b = lay.bbox ?? { x1: 0, y1: 0, x2: 1, y2: 1 };
  const m = 3;
  const w = b.x2 - b.x1 + m * 2;
  const h = b.y2 - b.y1 + m * 2;
  const k = Math.min(maxW / w, maxH / h, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w * k)}" height="${f(h * k)}" viewBox="${f(b.x1 - m)} ${f(b.y1 - m)} ${f(w)} ${f(h)}">${primsToSvg(lay.prims)}</svg>`;
}

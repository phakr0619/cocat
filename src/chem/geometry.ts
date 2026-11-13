// 2D の幾何。座標は SVG と同じく y が下向き（pt 単位）。
export interface P {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): P => ({ x, y });
export const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: P, k: number): P => ({ x: a.x * k, y: a.y * k });
export const dot = (a: P, b: P): number => a.x * b.x + a.y * b.y;
export const cross = (a: P, b: P): number => a.x * b.y - a.y * b.x;
export const len = (a: P): number => Math.hypot(a.x, a.y);
export const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const angleOf = (a: P): number => Math.atan2(a.y, a.x);
export const fromAngle = (ang: number, l = 1): P => ({ x: Math.cos(ang) * l, y: Math.sin(ang) * l });

export function norm(a: P): P {
  const l = len(a);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 進行方向 d に対して右手側の法線（y 下向きの画面で見て右） */
export const rightNormal = (d: P): P => ({ x: -d.y, y: d.x });

export function rotate(p: P, ang: number, center: P = { x: 0, y: 0 }): P {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
}

export function snapAngle(ang: number, step: number): number {
  return Math.round(ang / step) * step;
}

/** 角度を (-π, π] に正規化 */
export function normAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

export function segPointDist(p: P, a: P, b: P): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

/** p が直線 a→b のどちら側か（右: 正、左: 負） */
export function sideOf(p: P, a: P, b: P): number {
  return cross(sub(b, a), sub(p, a));
}

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
}

export function rectOfPoints(ps: P[]): Rect | null {
  let r: Rect | null = null;
  for (const p of ps) r = rectUnion(r, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  return r;
}

export function inflate(r: Rect, m: number): Rect {
  return { x1: r.x1 - m, y1: r.y1 - m, x2: r.x2 + m, y2: r.y2 + m };
}

export function rectContains(r: Rect, p: P): boolean {
  return p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;
}

/** 線分 a→b と矩形の交わる範囲 [t0, t1]（Liang–Barsky）。交わらなければ null */
export function clipParams(a: P, b: P, r: Rect): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x - r.x1],
    [dx, r.x2 - a.x],
    [-dy, a.y - r.y1],
    [dy, r.y2 - a.y],
  ];
  for (const [pp, q] of checks) {
    if (Math.abs(pp) < 1e-12) {
      if (q < 0) return null;
    } else {
      const t = q / pp;
      if (pp < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

export function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 正多角形の頂点。center から見て最初の頂点の角度 startAng から時計回り（画面上） */
export function regularPolygon(center: P, n: number, side: number, startAng: number): P[] {
  const r = side / (2 * Math.sin(Math.PI / n));
  const out: P[] = [];
  for (let i = 0; i < n; i++) out.push(add(center, fromAngle(startAng + (2 * Math.PI * i) / n, r)));
  return out;
}

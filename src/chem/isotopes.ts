// 同位体のパターン（質量分析で見える M・M+1・M+2… の高さ）。組成式と、天然の同位体の質量と存在比（IUPAC・NIST の値）から計算する。
// 外のデータは使わない（存在比は物理の定数）。
const ISOTOPES: Record<string, [number, number][]> = {
  H: [[1.0078250319, 0.999885], [2.0141017779, 0.000115]],
  B: [[10.012937, 0.199], [11.0093055, 0.801]],
  C: [[12, 0.9893], [13.0033548378, 0.0107]],
  N: [[14.0030740052, 0.99636], [15.0001088984, 0.00364]],
  O: [[15.9949146221, 0.99757], [16.9991315, 0.00038], [17.9991604, 0.00205]],
  F: [[18.9984032, 1]],
  Na: [[22.98976966, 1]],
  Si: [[27.9769265327, 0.92223], [28.97649472, 0.04685], [29.97377022, 0.03092]],
  P: [[30.97376151, 1]],
  S: [[31.97207069, 0.9499], [32.9714585, 0.0075], [33.96786683, 0.0425], [35.96708088, 0.0001]],
  Cl: [[34.96885271, 0.7576], [36.9659026, 0.2424]],
  K: [[38.9637069, 0.932581], [39.96399867, 0.000117], [40.96182597, 0.067302]],
  Se: [[73.9224766, 0.0089], [75.9192141, 0.0937], [76.9199146, 0.0763], [77.9173095, 0.2377], [79.9165218, 0.4961], [81.9167, 0.0873]],
  Br: [[78.9183376, 0.5069], [80.916291, 0.4931]],
  I: [[126.904468, 1]],
};

/** 公称質量（整数）ごとの山。mass はその山の重み付きの平均の精密質量 */
type Dist = Map<number, { p: number; m: number }>;

function combine(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [ka, va] of a) {
    for (const [kb, vb] of b) {
      const p = va.p * vb.p;
      if (p < 1e-9) continue;
      const k = ka + kb;
      const cur = out.get(k);
      const m = va.m + vb.m;
      if (cur) {
        cur.m = (cur.m * cur.p + m * p) / (cur.p + p);
        cur.p += p;
      } else out.set(k, { p, m });
    }
  }
  return out;
}

function power(d: Dist, n: number): Dist {
  let result: Dist = new Map([[0, { p: 1, m: 0 }]]);
  let base = d;
  for (let k = n; k > 0; k >>= 1) {
    if (k & 1) result = combine(result, base);
    if (k > 1) base = combine(base, base);
  }
  return result;
}

export interface IsotopePeak {
  /** M からのずれ（0・1・2…） */
  offset: number;
  mass: number;
  /** いちばん高い山を 100 とした高さ */
  rel: number;
}

/**
 * 組成式（元素 → 数）の同位体のパターン。高さが minRel 以上の山を、軽い順に返す。
 * 表に無い元素があれば null（パターンを出さない）
 */
export function isotopePattern(counts: Map<string, number>, minRel = 0.5): IsotopePeak[] | null {
  let dist: Dist = new Map([[0, { p: 1, m: 0 }]]);
  for (const [el, n] of counts) {
    if (!n) continue;
    const iso = ISOTOPES[el];
    if (!iso) return null;
    const nominal0 = Math.round(iso[0][0]);
    const d: Dist = new Map(iso.map(([m, p]) => [Math.round(m) - nominal0, { p, m }]));
    dist = combine(dist, power(d, n));
  }
  const peaks = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  const max = Math.max(...peaks.map(([, v]) => v.p));
  return peaks.map(([k, v]) => ({ offset: k, mass: v.m, rel: (v.p / max) * 100 })).filter((x) => x.rel >= minRel);
}

// 元素の表。valences は水素を補うときの価数（小さい順）。空なら水素を補わない。
export interface ElementInfo {
  z: number;
  valences: number[];
}

export const ELEMENTS: Record<string, ElementInfo> = {
  H: { z: 1, valences: [1] },
  He: { z: 2, valences: [0] },
  Li: { z: 3, valences: [1] },
  Be: { z: 4, valences: [2] },
  B: { z: 5, valences: [3] },
  C: { z: 6, valences: [4] },
  N: { z: 7, valences: [3] },
  O: { z: 8, valences: [2] },
  F: { z: 9, valences: [1] },
  Ne: { z: 10, valences: [0] },
  Na: { z: 11, valences: [1] },
  Mg: { z: 12, valences: [2] },
  Al: { z: 13, valences: [3] },
  Si: { z: 14, valences: [4] },
  P: { z: 15, valences: [3, 5] },
  S: { z: 16, valences: [2, 4, 6] },
  Cl: { z: 17, valences: [1] },
  Ar: { z: 18, valences: [0] },
  K: { z: 19, valences: [1] },
  Ca: { z: 20, valences: [2] },
  Ti: { z: 22, valences: [] },
  Cr: { z: 24, valences: [] },
  Mn: { z: 25, valences: [] },
  Fe: { z: 26, valences: [] },
  Co: { z: 27, valences: [] },
  Ni: { z: 28, valences: [] },
  Cu: { z: 29, valences: [] },
  Zn: { z: 30, valences: [] },
  Ge: { z: 32, valences: [4] },
  As: { z: 33, valences: [3, 5] },
  Se: { z: 34, valences: [2, 4, 6] },
  Br: { z: 35, valences: [1] },
  Rb: { z: 37, valences: [1] },
  Ru: { z: 44, valences: [] },
  Rh: { z: 45, valences: [] },
  Pd: { z: 46, valences: [] },
  Ag: { z: 47, valences: [] },
  Sn: { z: 50, valences: [4] },
  Te: { z: 52, valences: [2, 4, 6] },
  I: { z: 53, valences: [1, 3, 5] },
  Cs: { z: 55, valences: [1] },
  Os: { z: 76, valences: [] },
  Ir: { z: 77, valences: [] },
  Pt: { z: 78, valences: [] },
  Au: { z: 79, valences: [] },
  Hg: { z: 80, valences: [] },
};

const BY_Z = new Map<number, string>(Object.entries(ELEMENTS).map(([s, e]) => [e.z, s]));

export const isElement = (s: string): boolean => s in ELEMENTS;
export const atomicNumber = (s: string): number => ELEMENTS[s]?.z ?? 0;
export const symbolOf = (z: number): string | undefined => BY_Z.get(z);

/**
 * 電荷を考えた価数。RDKit と同じく、等電子の元素の価数を使う（N+ → C の 4、O- → F の 1）。
 * 金属など価数を持たない元素は null。
 */
export function effectiveValences(symbol: string, charge: number): number[] | null {
  const e = ELEMENTS[symbol];
  if (!e || e.valences.length === 0) return null;
  if (charge === 0) return e.valences;
  // 典型元素の有機の部分集合だけ等電子で考える
  const iso = symbolOf(e.z - charge);
  if (iso && ['B', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'As', 'Se', 'Br'].includes(symbol)) {
    const v = ELEMENTS[iso]?.valences;
    if (v && v.length) return v;
  }
  return e.valences.map((v) => Math.max(0, v - Math.abs(charge)));
}

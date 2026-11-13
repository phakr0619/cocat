// NMR の予測（¹³C・¹H）。教科書に広く載っている加成則（基本の値＋置換基の寄与の表）で目安を出す。
// 実測のデータベース（NMRShiftDB2 など）は使わない。表の値は、次の方式の
// 教科書の表に載る代表値を手で書き、丸めたもの（特定の 1 冊の写しではない）:
//   ¹³C 脂肪族: Grant–Paul の式（基本 −2.3、α/β/γ/δ の炭素、立体の補正）に、置換基の α/β/γ/δ の寄与を足す（Pretsch 型）
//   ¹³C ベンゼン環: 128.5 に置換基の ipso/ortho/meta/para の寄与を足す
//   ¹³C アルケン: 123.3 に、同じ側（α/β/γ）と反対側（α'/β'/γ'）の寄与を足す
//   ¹³C アルキン: 71.9 に同じ形の寄与を足す。カルボニル・ニトリルは種類ごとの基本の値と、隣の基の補正
//   ¹H 脂肪族: Shoolery 型を広げたもの（CH3 0.90・CH2 1.20・CH 1.55 に、α と β の置換基の寄与。Curphy–Morrison 型）
//   ¹H ベンゼン環: 7.27 に置換基の ortho/meta/para の寄与
//   ¹H アルケン: Pascual–Meier–Simon の式（5.25 に gem/cis/trans の寄与）
// 表に無い原子・置換基は「予測できない」とし、あてずっぽうの値は出さない。
import { expandedMolfile } from '../io/smiles';
import type { Doc } from './model';
import { getRDKit } from './rdkit';

export interface NmrShift {
  /** 対応する原子（元の文書の id）。¹H では、その H が付いている原子 */
  atomIds: string[];
  /** ppm。予測できないときは null */
  shift: number | null;
  /** 何個分か（¹³C は炭素の数、¹H は H の数） */
  count: number;
  /** 種類（CH3・ArH・C=O など） */
  label: string;
  /** どの表で出したか */
  method: string;
  /** 予測できない理由 */
  reason?: string;
  /** 加成則が当てになりにくい形（置換基が込み合う・環の中など） */
  low?: boolean;
}

export interface NmrPrediction {
  c13: NmrShift[];
  h1: NmrShift[];
}

// ---------------------------------------------------------------- 分子のグラフ

interface GAtom {
  el: string;
  charge: number;
  /** H の数（暗黙の H と、描いた H の原子の合計） */
  hs: number;
  arom: boolean;
  nbr: { j: number; o: number }[];
  x: number;
  y: number;
  rings: number[][];
}

type G = GAtom[];

interface RdJson {
  defaults: { atom: Record<string, number>; bond: Record<string, number> };
  molecules: {
    atoms: { z?: number; impHs?: number; chg?: number }[];
    bonds: { bo?: number; atoms: [number, number] }[];
    extensions?: { name: string; aromaticAtoms?: number[]; atomRings?: number[][] }[];
  }[];
}

const SYMBOL: Record<number, string> = { 1: 'H', 5: 'B', 6: 'C', 7: 'N', 8: 'O', 9: 'F', 14: 'Si', 15: 'P', 16: 'S', 17: 'Cl', 35: 'Br', 53: 'I' };

function heavyNbrs(g: G, i: number, except = -1) {
  return g[i].nbr.filter((n) => n.j !== except);
}

function isC(g: G, i: number) {
  return g[i].el === 'C' && g[i].charge === 0;
}
/** 単結合だけの炭素（sp3） */
function isSp3C(g: G, i: number) {
  return isC(g, i) && !g[i].arom && g[i].nbr.every((n) => n.o === 1);
}
/** C=C の炭素（芳香環でない）。相手の原子を返す */
function alkenePartner(g: G, i: number): number {
  if (!isC(g, i) || g[i].arom) return -1;
  const dbl = g[i].nbr.filter((n) => n.o === 2);
  const tri = g[i].nbr.filter((n) => n.o === 3);
  if (dbl.length !== 1 || tri.length) return -1;
  const p = dbl[0].j;
  if (!isC(g, p) || g[p].arom) return -1;
  // アレン（C=C=C）は表に無い
  if (g[p].nbr.filter((n) => n.o >= 2).length !== 1) return -1;
  return p;
}
function alkynePartner(g: G, i: number): number {
  if (!isC(g, i) || g[i].arom) return -1;
  const tri = g[i].nbr.filter((n) => n.o === 3);
  if (tri.length !== 1 || g[i].nbr.some((n) => n.o === 2)) return -1;
  return isC(g, tri[0].j) ? tri[0].j : -1;
}
function isNitrileC(g: G, i: number) {
  return isC(g, i) && g[i].nbr.some((n) => n.o === 3 && g[n.j].el === 'N' && g[n.j].charge === 0);
}
/** C=O の炭素なら、O の番号 */
function carbonylO(g: G, i: number): number {
  if (!isC(g, i) || g[i].arom) return -1;
  const d = g[i].nbr.filter((n) => n.o === 2);
  if (d.length !== 1) return -1;
  const o = d[0].j;
  return g[o].el === 'O' && g[o].charge === 0 ? o : -1;
}

/** ベンゼン環（6 員環で、全部が芳香族の炭素）。i がちょうど 1 つの環にだけ入っているときだけ返す */
function benzeneRingOf(g: G, i: number): number[] | null {
  if (!g[i].arom || g[i].el !== 'C') return null;
  const ar = g[i].rings.filter((q) => q.every((x) => g[x].arom));
  if (ar.length !== 1) return null;
  const r = ar[0];
  if (r.length !== 6 || !r.every((k) => g[k].el === 'C' && g[k].arom && g[k].charge === 0)) return null;
  // ほかの芳香環と縮環していない（インダンのような、飽和の環との縮環はよい）
  for (const k of r) for (const q of g[k].rings) if (q !== r && q.every((x) => g[x].arom)) return null;
  return r;
}

/** ベンゼン環として読めない芳香族の原子の理由 */
function aromaticWhy(g: G, i: number) {
  const ar = g[i].rings.filter((q) => q.every((x) => g[x].arom));
  const fused = ar.some((r) => r.some((k) => g[k].rings.some((q) => q !== r && q.every((x) => g[x].arom))));
  return fused ? '縮環した芳香環（ナフタレンなど）は表に無い' : 'ベンゼン以外の芳香環（ピリジン・フランなど）は表に無い';
}

// ---------------------------------------------------------------- 置換基の種類

type Key =
  | 'C' | 'C=C' | 'C#C' | 'Ar' | 'CHO' | 'COR' | 'COAr' | 'COOH' | 'COO-' | 'COOR' | 'CON' | 'COCl' | 'CN'
  | 'OH' | 'OR' | 'OAr' | 'OCOR' | 'NH2' | 'NHR' | 'NR2' | 'NCOR' | 'NO2' | 'N+' | 'SH' | 'SR'
  | 'F' | 'Cl' | 'Br' | 'I';

/** a に付いた置換基 s の種類。表に無ければ null */
function classify(g: G, s: number, a: number): Key | null {
  const at = g[s];
  switch (at.el) {
    case 'C': {
      if (at.charge) return null;
      if (at.arom) return 'Ar';
      if (isSp3C(g, s)) return 'C';
      if (alkenePartner(g, s) >= 0) return alkenePartner(g, s) === a ? null : 'C=C';
      if (alkynePartner(g, s) >= 0) return alkynePartner(g, s) === a ? null : 'C#C';
      if (isNitrileC(g, s)) return 'CN';
      const o = carbonylO(g, s);
      if (o >= 0) return classifyCarbonyl(g, s, a, o);
      return null;
    }
    case 'O': {
      // 芳香環の中の O・N・S（フラン・ピロール・ピリジンなど）は表に無い
      if (at.charge || at.arom) return null;
      if (at.nbr.length + at.hs !== 2 || at.nbr.some((n) => n.o !== 1)) return null;
      if (at.hs === 1) return 'OH';
      const t = heavyNbrs(g, s, a)[0]?.j;
      if (t === undefined || g[t].el !== 'C') return null;
      if (carbonylO(g, t) >= 0) return 'OCOR';
      if (g[t].arom) return 'OAr';
      return 'OR';
    }
    case 'N': {
      if (at.arom) return null;
      const os = at.nbr.filter((n) => g[n.j].el === 'O');
      if (os.length === 2 && at.nbr.length === 3) return 'NO2';
      if (at.charge === 1 && at.nbr.every((n) => n.o === 1) && at.nbr.length + at.hs === 4) return 'N+';
      if (at.charge || at.nbr.some((n) => n.o !== 1) || os.length) return null;
      const others = heavyNbrs(g, s, a);
      if (others.some((n) => carbonylO(g, n.j) >= 0)) return 'NCOR';
      if (!others.every((n) => g[n.j].el === 'C')) return null;
      return at.hs === 2 ? 'NH2' : at.hs === 1 ? 'NHR' : 'NR2';
    }
    case 'S': {
      if (at.arom || at.charge || at.nbr.length + at.hs !== 2 || at.nbr.some((n) => n.o !== 1)) return null;
      return at.hs === 1 ? 'SH' : 'SR';
    }
    case 'F':
    case 'Cl':
    case 'Br':
    case 'I':
      return at.charge ? null : (at.el as Key);
    default:
      return null;
  }
}

function classifyCarbonyl(g: G, c: number, a: number, o: number): Key | null {
  const others = g[c].nbr.filter((n) => n.j !== a && n.j !== o);
  if (others.length === 0) return g[c].hs === 1 ? 'CHO' : null;
  const t = others[0].j;
  const el = g[t].el;
  if (el === 'O') {
    if (g[t].charge === -1) return 'COO-';
    if (g[t].hs === 1) return 'COOH';
    return g[t].charge === 0 ? 'COOR' : null;
  }
  if (el === 'N') return g[t].charge === 0 ? 'CON' : null;
  if (el === 'Cl') return 'COCl';
  if (el === 'C') return g[t].arom ? 'COAr' : 'COR';
  return null;
}

// ---------------------------------------------------------------- ¹³C の表

/** 脂肪族の炭素。置換基の α/β/γ/δ の寄与（Pretsch 型。基本 −2.3） */
const SP3_C13: Record<Key, [number, number, number, number]> = {
  C: [9.1, 9.4, -2.5, 0.3],
  'C=C': [19.5, 6.9, -2.1, 0.4],
  'C#C': [4.4, 5.6, -3.4, -0.6],
  Ar: [22.1, 9.3, -2.6, 0.3],
  CHO: [29.9, -0.6, -2.7, 0],
  COR: [30.0, 1.0, -2.5, 0],
  COAr: [28.5, 1.0, -2.5, 0],
  COOH: [20.1, 2.0, -2.8, 0],
  'COO-': [24.5, 3.5, -2.5, 0],
  COOR: [22.6, 2.0, -2.8, 0],
  CON: [22.0, 2.6, -3.2, -0.4],
  COCl: [33.1, 2.3, -3.6, 0],
  CN: [3.1, 2.4, -3.3, -0.5],
  OH: [49.0, 10.1, -6.2, 0.3],
  OR: [58.0, 7.2, -5.8, 0],
  OAr: [57.3, 7.2, -5.8, 0],
  OCOR: [56.5, 6.5, -6.0, 0],
  NH2: [28.3, 11.3, -5.1, 0],
  NHR: [36.9, 9.4, -4.6, 0],
  NR2: [40.5, 7.6, -5.3, 0],
  NCOR: [28.0, 7.0, -5.0, 0],
  NO2: [61.6, 3.1, -4.6, -1.0],
  'N+': [30.7, 5.4, -7.2, -1.4],
  SH: [10.6, 11.4, -3.6, -0.4],
  SR: [20.4, 6.2, -2.7, 0],
  F: [70.1, 7.8, -6.8, 0],
  Cl: [31.0, 10.0, -5.1, -0.5],
  Br: [18.9, 11.0, -3.8, -0.7],
  I: [-7.2, 10.9, -1.5, -0.9],
};

/** 立体の補正（Grant–Paul）。[見ている炭素の級][隣の炭素の級]（1〜4 級） */
const STERIC: number[][] = [
  [0, 0, -1.1, -3.4],
  [0, 0, -2.5, -7.2],
  [0, -3.7, -9.5, -15.0],
  [-1.5, -8.4, -15.0, -25.0],
];

/** ベンゼン環の置換基（ipso/ortho/meta/para）。¹³C は 128.5、¹H は 7.27 に足す */
type ArKey =
  | 'CH3' | 'CH2R' | 'CHR2' | 'CR3' | 'CH2OH' | 'CH2Cl' | 'CF3' | 'CH=CH2' | 'C#CH' | 'Ph' | 'CHO' | 'COR'
  | 'COOH' | 'COO-' | 'COOR' | 'CON' | 'COCl' | 'CN' | 'OH' | 'OR' | 'OAr' | 'OCOR' | 'NH2' | 'NHR' | 'NR2'
  | 'NCOR' | 'NO2' | 'SH' | 'SR' | 'F' | 'Cl' | 'Br' | 'I';

const AR_C13: Record<ArKey, [number, number, number, number]> = {
  CH3: [9.3, 0.7, -0.1, -2.9],
  CH2R: [15.6, -0.5, 0.0, -2.6],
  CHR2: [20.1, -2.0, 0.0, -2.5],
  CR3: [22.2, -3.4, -0.4, -3.1],
  CH2OH: [12.4, -1.2, 0.2, -1.1],
  CH2Cl: [9.1, 0.0, 0.2, -0.2],
  CF3: [2.6, -3.1, 0.4, 3.4],
  'CH=CH2': [9.1, -2.4, 0.2, -0.5],
  'C#CH': [-6.2, 3.6, -0.4, -0.3],
  Ph: [13.0, -1.1, 0.5, -1.0],
  CHO: [8.2, 1.2, 0.5, 5.8],
  COR: [8.9, 0.0, -0.1, 4.4],
  COOH: [2.1, 1.6, -0.1, 5.2],
  'COO-': [7.6, 0.8, 0.0, 2.8],
  COOR: [2.0, 1.2, -0.1, 4.3],
  CON: [5.0, -1.2, 0.1, 3.4],
  COCl: [4.7, 2.7, 0.3, 6.6],
  CN: [-15.7, 3.6, 0.7, 4.3],
  OH: [26.9, -12.8, 1.4, -7.4],
  OR: [31.4, -14.4, 1.0, -7.7],
  OAr: [27.6, -11.2, -0.3, -6.9],
  OCOR: [22.4, -7.1, 0.4, -3.2],
  NH2: [18.2, -13.4, 0.8, -10.0],
  NHR: [21.0, -16.2, 0.7, -12.0],
  NR2: [22.4, -15.7, 0.8, -11.8],
  NCOR: [9.7, -8.1, 0.2, -4.4],
  NO2: [19.6, -5.3, 0.9, 6.0],
  SH: [2.1, 0.7, 0.3, -3.2],
  SR: [10.2, -1.8, 0.4, -3.6],
  F: [35.1, -14.3, 0.9, -4.5],
  Cl: [6.4, 0.2, 1.0, -2.0],
  Br: [-5.4, 3.4, 2.2, -1.0],
  I: [-32.2, 9.9, 2.6, -7.3],
};

/** アルケンの炭素（123.3 に足す）。[同じ炭素に付く, 反対の炭素に付く]。アルキル基は別に α/β/γ で数える */
const ALKENE_C13: Partial<Record<Key, [number, number]>> = {
  Ar: [12.5, -11.0],
  'C=C': [13.6, -7.0],
  CHO: [13.1, 12.7],
  COR: [15.0, 5.8],
  COAr: [14.0, 4.5],
  COOH: [5.0, 9.8],
  COOR: [6.3, 7.0],
  CON: [8.0, 4.0],
  COCl: [8.1, 14.0],
  CN: [-15.1, 14.2],
  OR: [29.0, -39.0],
  OAr: [29.0, -39.0],
  OCOR: [18.4, -26.7],
  NR2: [28.0, -32.0],
  NCOR: [6.5, -29.2],
  SR: [9.0, -12.9],
  F: [24.9, -34.3],
  Cl: [2.8, -6.1],
  Br: [-8.6, -0.9],
  I: [-38.1, 7.0],
};

// ---------------------------------------------------------------- ¹H の表

/** 脂肪族の H。α の置換基の寄与 [CH3, CH2, CH] と β の寄与（Curphy–Morrison 型） */
const SP3_H1: Partial<Record<Key, [number, number, number, number]>> = {
  'C=C': [0.78, 0.75, 0.6, 0.1],
  'C#C': [0.9, 0.9, 0.8, 0.15],
  Ar: [1.45, 1.45, 1.33, 0.35],
  CHO: [1.3, 1.15, 1.0, 0.25],
  COR: [1.2, 1.2, 1.05, 0.2],
  COAr: [1.7, 1.7, 1.75, 0.3],
  COOH: [1.1, 1.05, 0.95, 0.25],
  'COO-': [1.0, 0.95, 0.9, 0.2],
  COOR: [1.1, 1.05, 0.95, 0.2],
  CON: [1.1, 1.05, 0.95, 0.2],
  COCl: [1.8, 1.8, 1.75, 0.45],
  CN: [1.1, 1.1, 1.05, 0.45],
  OH: [2.47, 2.4, 2.45, 0.25],
  OR: [2.43, 2.25, 2.2, 0.2],
  OAr: [2.83, 2.8, 2.85, 0.4],
  OCOR: [2.8, 2.9, 3.4, 0.4],
  NH2: [1.5, 1.4, 1.3, 0.1],
  NHR: [1.5, 1.4, 1.3, 0.1],
  NR2: [1.5, 1.4, 1.3, 0.1],
  NCOR: [1.9, 2.1, 2.4, 0.2],
  NO2: [3.38, 3.2, 3.1, 0.65],
  'N+': [2.4, 2.2, 2.0, 0.4],
  SH: [1.2, 1.3, 1.3, 0.4],
  SR: [1.2, 1.3, 1.3, 0.4],
  F: [3.36, 3.15, 3.0, 0.3],
  Cl: [2.15, 2.3, 2.55, 0.5],
  Br: [1.78, 2.18, 2.68, 0.6],
  I: [1.26, 1.95, 2.7, 0.65],
};
const SP3_H1_BASE = [0.9, 1.2, 1.55];

/** ベンゼン環の H。[ortho, meta, para] */
const AR_H1: Record<ArKey, [number, number, number]> = {
  CH3: [-0.18, -0.11, -0.21],
  CH2R: [-0.15, -0.06, -0.18],
  CHR2: [-0.13, -0.08, -0.18],
  CR3: [0.02, -0.08, -0.21],
  CH2OH: [-0.07, -0.07, -0.07],
  CH2Cl: [0.0, 0.0, 0.0],
  CF3: [0.32, 0.14, 0.2],
  'CH=CH2': [0.06, -0.03, -0.1],
  'C#CH': [0.15, -0.02, -0.01],
  Ph: [0.37, 0.2, 0.1],
  CHO: [0.56, 0.22, 0.29],
  COR: [0.62, 0.14, 0.21],
  COOH: [0.85, 0.18, 0.27],
  'COO-': [0.71, 0.1, 0.21],
  COOR: [0.71, 0.11, 0.21],
  CON: [0.61, 0.1, 0.17],
  COCl: [0.84, 0.22, 0.36],
  CN: [0.36, 0.18, 0.28],
  OH: [-0.56, -0.12, -0.45],
  OR: [-0.48, -0.09, -0.44],
  OAr: [-0.29, -0.05, -0.23],
  OCOR: [-0.25, 0.03, -0.13],
  NH2: [-0.75, -0.25, -0.65],
  NHR: [-0.8, -0.22, -0.68],
  NR2: [-0.66, -0.18, -0.67],
  NCOR: [0.12, -0.07, -0.28],
  NO2: [0.95, 0.26, 0.38],
  SH: [-0.08, -0.16, -0.22],
  SR: [-0.08, -0.1, -0.24],
  F: [-0.26, 0.0, -0.2],
  Cl: [0.03, -0.02, -0.09],
  Br: [0.18, -0.08, -0.04],
  I: [0.39, -0.21, 0.0],
};

/** アルケンの H（Pascual–Meier–Simon。5.25 に足す）。[gem, cis, trans] */
type PmsKey =
  | 'alkyl' | 'alkyl-ring' | 'CH2O' | 'CH2S' | 'CH2X' | 'CH2N' | 'C#C' | 'CN' | 'C=C' | 'COR' | 'COOH' | 'COOR'
  | 'CHO' | 'CON' | 'COCl' | 'OR' | 'OCOR' | 'Ar' | 'Cl' | 'Br' | 'I' | 'F' | 'NR2' | 'NCOR' | 'SR';
const PMS: Record<PmsKey, [number, number, number]> = {
  alkyl: [0.45, -0.22, -0.28],
  'alkyl-ring': [0.69, -0.25, -0.28],
  CH2O: [0.64, -0.01, -0.02],
  CH2S: [0.71, -0.13, -0.22],
  CH2X: [0.7, 0.11, -0.04],
  CH2N: [0.58, -0.1, -0.08],
  'C#C': [0.47, 0.38, 0.12],
  CN: [0.27, 0.75, 0.55],
  'C=C': [1.0, -0.09, -0.23],
  COR: [1.1, 1.12, 0.87],
  COOH: [0.97, 1.41, 0.71],
  COOR: [0.8, 1.18, 0.55],
  CHO: [1.02, 0.95, 1.17],
  CON: [1.37, 0.98, 0.46],
  COCl: [1.11, 1.46, 1.01],
  OR: [1.22, -1.07, -1.21],
  OCOR: [2.11, -0.35, -0.64],
  Ar: [1.38, 0.36, -0.07],
  Cl: [1.08, 0.18, 0.13],
  Br: [1.07, 0.45, 0.55],
  I: [1.14, 0.81, 0.88],
  F: [1.54, -0.4, -1.02],
  NR2: [0.8, -1.26, -1.21],
  NCOR: [2.08, -0.57, -0.72],
  SR: [1.11, -0.29, -0.13],
};

// ---------------------------------------------------------------- 予測の中身

type One = { shift: number; low?: boolean; label: string; method: string } | { shift: null; reason: string; label: string; method: string };

const M_SP3 = '脂肪族（Grant–Paul 型＋置換基の寄与）';
const M_AR = 'ベンゼン環（置換基の ipso/o/m/p の寄与）';
const M_ALKENE = 'アルケン（置換基の寄与）';
const M_ALKYNE = 'アルキン（置換基の寄与）';
const M_CO = 'カルボニル・ニトリル（種類ごとの基本の値）';
const M_NONE = '—';

function nameOf(g: G, s: number) {
  const a = g[s];
  return a.el + (a.charge ? (a.charge > 0 ? '⁺' : '⁻') : '');
}

function hLabel(hs: number) {
  return hs === 0 ? 'C' : hs === 1 ? 'CH' : `CH${hs}`;
}

/** ベンゼン環の置換基（環の外の s が環の a に付く）の種類 */
function arylKey(g: G, s: number, a: number): ArKey | null {
  const k = classify(g, s, a);
  if (k === null) return null;
  switch (k) {
    case 'C': {
      const others = heavyNbrs(g, s, a);
      if (others.length === 3 && others.every((n) => g[n.j].el === 'F')) return 'CF3';
      if (g[s].hs === 3) return 'CH3';
      if (g[s].hs === 2) {
        const el = g[others[0].j].el;
        if (el === 'O') return 'CH2OH';
        if (el === 'Cl' || el === 'Br' || el === 'I') return 'CH2Cl';
        return 'CH2R';
      }
      return g[s].hs === 1 ? 'CHR2' : 'CR3';
    }
    case 'C=C':
      return 'CH=CH2';
    case 'C#C':
      return 'C#CH';
    case 'Ar':
      return 'Ph';
    case 'COAr':
      return 'COR';
    case 'N+':
      return null;
    default:
      return k as ArKey;
  }
}

/** ベンゼン環の各原子への置換基の寄与（[位置, 種類]）。読めない置換基があれば理由 */
function ringSubstituents(g: G, ring: number[], target: number): { pos: number; key: ArKey }[] | string {
  const t = ring.indexOf(target);
  const out: { pos: number; key: ArKey }[] = [];
  for (let k = 0; k < 6; k++) {
    const r = ring[k];
    for (const n of g[r].nbr) {
      if (ring.includes(n.j)) continue;
      const key = arylKey(g, n.j, r);
      if (!key) return `環の置換基（${nameOf(g, n.j)} の基）が表に無い`;
      const d = Math.abs(k - t);
      out.push({ pos: Math.min(d, 6 - d), key });
    }
  }
  return out;
}

/** sp3 の炭素の骨格（sp3 の炭素だけ）をたどる単純な道。長さ 4 まで。環では同じ原子に別の道で着くことがある */
function walkSkeleton(g: G, i: number, visit: (k: number, d: number, from: number) => void) {
  const path = [i];
  const rec = (k: number, d: number) => {
    visit(k, d, path.length > 1 ? path[path.length - 2] : -1);
    if (d >= 4) return;
    for (const n of g[k].nbr) {
      if (!isSp3C(g, n.j) || path.includes(n.j)) continue;
      path.push(n.j);
      rec(n.j, d + 1);
      path.pop();
    }
  };
  rec(i, 0);
}

function c13Sp3(g: G, i: number): One {
  const label = hLabel(g[i].hs);
  let v = -2.3;
  let bad: string | null = null;
  let low = false;
  let strong = 0;
  walkSkeleton(g, i, (k, d, from) => {
    if (d >= 1) v += SP3_C13.C[d - 1];
    if (d > 3) return;
    for (const n of g[k].nbr) {
      if (n.j === from || isSp3C(g, n.j)) continue;
      const key = classify(g, n.j, k);
      if (!key) {
        if (d <= 1) bad ??= `${d === 0 ? '隣' : '2 つ先'}の基（${nameOf(g, n.j)}）が表に無い`;
        else low = true;
        continue;
      }
      if (d === 0 && /^(O|N|F|Cl|Br|I|S)/.test(key)) strong++;
      v += SP3_C13[key][d];
    }
  });
  if (bad) return { shift: null, reason: bad, label, method: M_SP3 };
  // CF3・CCl3 のように同じ炭素に 3 つ以上重なると、足し算が大きく外れる（CF3 の炭素は実測 124 前後）
  if (strong >= 3) return { shift: null, reason: '同じ炭素にヘテロ原子の置換基が 3 つ以上重なる形（CF3 など）は加成則で読めない', label, method: M_SP3 };
  // 立体の補正: 自分の級（H 以外の置換基の数）と、隣の sp3 の炭素の級
  const deg = g[i].nbr.length;
  if (deg >= 1) for (const n of g[i].nbr) if (isSp3C(g, n.j)) v += STERIC[Math.min(deg, 4) - 1][Math.min(g[n.j].nbr.length, 4) - 1];
  if (strong >= 2) low = true;
  if (g[i].rings.some((r) => r.length < 5)) low = true;
  return { shift: v, low, label, method: M_SP3 };
}

function c13Aromatic(g: G, i: number): One {
  const label = g[i].hs ? 'ArCH' : 'ArC';
  const ring = benzeneRingOf(g, i);
  if (!ring) {
    const why = aromaticWhy(g, i);
    return { shift: null, reason: why, label, method: M_AR };
  }
  const subs = ringSubstituents(g, ring, i);
  if (typeof subs === 'string') return { shift: null, reason: subs, label, method: M_AR };
  let v = 128.5;
  for (const s of subs) v += AR_C13[s.key][s.pos];
  return { shift: v, low: subs.length >= 3, label, method: M_AR };
}

/** アルケン・アルキンの、片側のアルキル基の α/β/γ の数（同じ原子は 1 回だけ） */
function alkylShells(g: G, start: number, from: number, used: Set<number>): number[] {
  const shells = [0, 0, 0];
  let frontier = [start];
  const prev = new Map<number, number>([[start, from]]);
  for (let d = 0; d < 3 && frontier.length; d++) {
    const next: number[] = [];
    for (const k of frontier) {
      if (used.has(k)) continue;
      used.add(k);
      shells[d]++;
      // β・γ は sp3 の炭素の先だけたどる（ヘテロ原子も 1 つの原子として数える）
      if (!isSp3C(g, k)) continue;
      for (const n of g[k].nbr) {
        if (n.j === prev.get(k) || used.has(n.j)) continue;
        prev.set(n.j, k);
        next.push(n.j);
      }
    }
    frontier = next;
  }
  return shells;
}

function c13Alkene(g: G, i: number, p: number): One {
  const label = g[i].hs === 2 ? '=CH2' : g[i].hs === 1 ? '=CH' : '=C';
  let v = 123.3;
  const used = new Set<number>([i, p]);
  const OWN = [10.6, 7.2, -1.5];
  const OPP = [-7.9, -1.8, 1.5];
  for (const [side, from, w] of [[i, p, OWN], [p, i, OPP]] as const) {
    for (const n of g[side].nbr) {
      if (n.j === from) continue;
      if (isSp3C(g, n.j)) {
        const sh = alkylShells(g, n.j, side, used);
        v += sh[0] * w[0] + sh[1] * w[1] + sh[2] * w[2];
        continue;
      }
      const key = classify(g, n.j, side);
      const z = key ? ALKENE_C13[key] : undefined;
      if (!z) return { shift: null, reason: `二重結合の置換基（${nameOf(g, n.j)} の基）が表に無い`, label, method: M_ALKENE };
      v += side === i ? z[0] : z[1];
    }
  }
  return { shift: v, low: g[i].rings.some((r) => r.length < 6), label, method: M_ALKENE };
}

function c13Alkyne(g: G, i: number, p: number): One {
  const label = g[i].hs ? '≡CH' : '≡C';
  let v = 71.9;
  const used = new Set<number>([i, p]);
  const OWN = [6.9, 4.8, -0.1];
  const OPP = [-5.7, 2.3, 1.3];
  for (const [side, from, w] of [[i, p, OWN], [p, i, OPP]] as const) {
    for (const n of g[side].nbr) {
      if (n.j === from) continue;
      if (isSp3C(g, n.j)) {
        const sh = alkylShells(g, n.j, side, used);
        v += sh[0] * w[0] + sh[1] * w[1] + sh[2] * w[2];
      } else if (g[n.j].arom && g[n.j].el === 'C') v += side === i ? 11.8 : 5.3;
      else return { shift: null, reason: `三重結合の置換基（${nameOf(g, n.j)} の基）が表に無い`, label, method: M_ALKYNE };
    }
  }
  return { shift: v, label, method: M_ALKYNE };
}

/** カルボニルの両隣の補正: アルキル側は β の原子 1 つごとに +2.5（3 つまで）、共役（芳香環・C=C）は別に返す */
function carbonylSides(g: G, c: number, sides: number[]) {
  let beta = 0;
  let conj = 0;
  for (const s of sides) {
    if (isSp3C(g, s)) beta += Math.min(3, g[s].nbr.length - 1);
    else if ((g[s].el === 'C' && g[s].arom) || alkenePartner(g, s) >= 0 || alkynePartner(g, s) >= 0) conj++;
  }
  void c;
  return { beta, conj };
}

function c13Carbonyl(g: G, i: number, o: number): One {
  const others = g[i].nbr.filter((n) => n.j !== o).map((n) => n.j);
  const het = others.filter((s) => g[s].el !== 'C');
  const cs = others.filter((s) => g[s].el === 'C');
  const { beta, conj } = carbonylSides(g, i, cs);
  const ring = g[i].rings.find(() => true);
  const method = M_CO;
  const done = (v: number, label: string, low = false): One => ({ shift: v, low, label, method });
  const none = (reason: string): One => ({ shift: null, reason, label: 'C=O', method });
  if (het.length === 0) {
    if (cs.length === 2) {
      // ケトン: アセトン 206.7。共役 1 つで −8.7、2 つ目で −1.5。5 員環は +8
      let v = 206.7 + 2.5 * beta - (conj >= 1 ? 8.7 : 0) - (conj >= 2 ? 1.5 : 0);
      const n = ring?.length ?? 0;
      if (n === 5) v += 8;
      return done(v, 'C=O', n > 0 && n !== 5 && n !== 6);
    }
    if (cs.length === 1 && g[i].hs === 1) return done(conj ? 192.3 : 200.5 + 2.2 * Math.min(beta, 3), 'CHO');
    return none('ホルムアルデヒドは表に無い');
  }
  const els = het.map((s) => `${g[s].el}${g[s].charge < 0 ? '-' : ''}`).sort().join(',');
  if (het.length === 1 && (cs.length === 1 || g[i].hs === 1)) {
    const t = het[0];
    const formyl = cs.length === 0;
    const corr = 2.5 * beta;
    switch (els) {
      case 'O': {
        if (g[t].hs === 1) return done(formyl ? 166 : (conj ? 172.5 : 177.5 + corr), 'COOH');
        const u = heavyNbrs(g, t, i)[0]?.j;
        if (u !== undefined && carbonylO(g, u) >= 0) return done(conj ? 162.5 : 167 + corr, 'C=O');
        return done(formyl ? 161 : conj ? 166.5 : 171.0 + corr, 'COOR', ring !== undefined);
      }
      case 'O-':
        return done(conj ? 175.5 : 181 + corr, 'COO⁻');
      case 'N':
        return done(formyl ? 162.5 : conj ? 168 : 170.5 + corr, 'CON', ring !== undefined);
      case 'Cl':
        return done(conj ? 168 : 170.5 + corr, 'COCl');
    }
    return none(`カルボニルの隣（${els}）が表に無い`);
  }
  if (het.length === 2 && cs.length === 0) {
    if (els === 'N,O') return done(156, 'NC(=O)O');
    if (els === 'N,N') return done(158.5, 'NC(=O)N');
    if (els === 'O,O') return done(155, 'OC(=O)O');
  }
  return none(`カルボニルの隣（${els}）が表に無い`);
}

function c13Nitrile(g: G, i: number): One {
  const s = g[i].nbr.find((n) => n.o === 1)?.j;
  if (s === undefined) return { shift: null, reason: 'HCN は表に無い', label: 'CN', method: M_CO };
  if (isSp3C(g, s)) return { shift: 117.5 + 1.5 * Math.min(2, g[s].nbr.length - 1), label: 'CN', method: M_CO };
  if (g[s].el === 'C' && (g[s].arom || alkenePartner(g, s) >= 0)) return { shift: 118.5, label: 'CN', method: M_CO };
  return { shift: null, reason: `ニトリルの隣（${nameOf(g, s)}）が表に無い`, label: 'CN', method: M_CO };
}

function predictC13(g: G, i: number): One {
  const a = g[i];
  const label = hLabel(a.hs);
  if (a.charge) return { shift: null, reason: '電荷を持つ炭素は表に無い', label, method: M_NONE };
  if (a.arom) return c13Aromatic(g, i);
  if (isSp3C(g, i)) return c13Sp3(g, i);
  const o = carbonylO(g, i);
  if (o >= 0) return c13Carbonyl(g, i, o);
  if (isNitrileC(g, i)) return c13Nitrile(g, i);
  const p = alkenePartner(g, i);
  if (p >= 0) return c13Alkene(g, i, p);
  const q = alkynePartner(g, i);
  if (q >= 0) return c13Alkyne(g, i, q);
  return { shift: null, reason: 'この種類の炭素（イミン・アレン・C=S など）は表に無い', label, method: M_NONE };
}

// ---------------------------------------------------------------- ¹H

function h1Sp3(g: G, i: number): One {
  const hs = g[i].hs;
  const label = hLabel(hs);
  if (hs === 4) return { shift: 0.23, label: 'CH4', method: M_SP3 };
  const col = 3 - hs; // CH3 → 0, CH2 → 1, CH → 2
  let v = SP3_H1_BASE[col];
  let strong = 0;
  let het = 0;
  let low = false;
  for (const n of g[i].nbr) {
    if (isSp3C(g, n.j)) {
      for (const m of g[n.j].nbr) {
        if (m.j === i || isSp3C(g, m.j)) continue;
        const key = classify(g, m.j, n.j);
        const z = key ? SP3_H1[key] : undefined;
        if (z) v += z[3];
        else low = true;
      }
      continue;
    }
    const key = classify(g, n.j, i);
    const z = key ? SP3_H1[key] : undefined;
    if (!z) return { shift: null, reason: `隣の基（${nameOf(g, n.j)}）が表に無い`, label, method: M_SP3 };
    v += z[col];
    strong++;
    if (/^(O|N|F|Cl|Br|I|S)/.test(key!)) het++;
  }
  // CHCl3 のように同じ炭素にヘテロ原子が 3 つ重なると、足し算が大きく外れる
  if (het >= 3) return { shift: null, reason: '同じ炭素にヘテロ原子の置換基が 3 つ以上重なる形は加成則で読めない', label, method: M_SP3 };
  if (strong >= 2) low = true;
  return { shift: v, low, label, method: M_SP3 };
}

function h1Aromatic(g: G, i: number): One {
  const ring = benzeneRingOf(g, i);
  if (!ring) {
    const why = aromaticWhy(g, i);
    return { shift: null, reason: why, label: 'ArH', method: M_AR };
  }
  const subs = ringSubstituents(g, ring, i);
  if (typeof subs === 'string') return { shift: null, reason: subs, label: 'ArH', method: M_AR };
  let v = 7.27;
  for (const s of subs) if (s.pos > 0) v += AR_H1[s.key][s.pos - 1];
  return { shift: v, low: subs.length >= 3, label: 'ArH', method: M_AR };
}

function pmsKey(g: G, s: number, a: number, alkene: number[]): PmsKey | null {
  if (isSp3C(g, s)) {
    const els = heavyNbrs(g, s, a).map((n) => g[n.j].el);
    if (els.includes('O') || els.includes('I')) return 'CH2O';
    if (els.includes('Cl') || els.includes('Br')) return 'CH2X';
    if (els.includes('N')) return 'CH2N';
    if (els.includes('S')) return 'CH2S';
    return g[s].rings.some((r) => alkene.every((k) => r.includes(k))) ? 'alkyl-ring' : 'alkyl';
  }
  const k = classify(g, s, a);
  switch (k) {
    case null:
      return null;
    case 'COAr':
      return 'COR';
    case 'OAr':
      return 'OR';
    case 'NH2':
    case 'NHR':
      return 'NR2';
    case 'C':
    case 'OH':
    case 'SH':
    case 'NO2':
    case 'N+':
    case 'COO-':
      return null;
    default:
      return k in PMS ? (k as PmsKey) : null;
  }
}

/** a→b の直線に対して、点 q がどちらの側か（+1・−1。ほぼ直線上なら 0） */
function sideOf(g: G, a: number, b: number, q: number) {
  const ux = g[b].x - g[a].x;
  const uy = g[b].y - g[a].y;
  const c = ux * (g[q].y - g[a].y) - uy * (g[q].x - g[a].x);
  const L = Math.hypot(ux, uy) * Math.hypot(g[q].x - g[a].x, g[q].y - g[a].y) || 1;
  return Math.abs(c / L) < 0.1 ? 0 : Math.sign(c);
}

/** アルケンの H。=CH2 では 2 つの H を別に返す */
function h1Alkene(g: G, i: number, p: number): One[] {
  const label = g[i].hs === 2 ? '=CH2' : '=CH';
  const gem = heavyNbrs(g, i, p).map((n) => n.j);
  const opp = heavyNbrs(g, p, i).map((n) => n.j);
  const keyOf = (s: number, at: number) => pmsKey(g, s, at, [i, p]);
  let base = 5.25;
  for (const s of gem) {
    const k = keyOf(s, i);
    if (!k) return [{ shift: null, reason: `二重結合の置換基（${nameOf(g, s)} の基）が表に無い`, label, method: M_ALKENE }];
    base += PMS[k][0];
  }
  const oppKeys: { s: number; k: PmsKey }[] = [];
  for (const s of opp) {
    const k = keyOf(s, p);
    if (!k) return [{ shift: null, reason: `二重結合の置換基（${nameOf(g, s)} の基）が表に無い`, label, method: M_ALKENE }];
    oppKeys.push({ s, k });
  }
  // H の側: gem の置換基の反対側。=CH2 なら両側に 1 つずつ
  const hSides = g[i].hs === 2 ? [1, -1] : [gem.length ? -sideOf(g, i, p, gem[0]) : 0];
  return hSides.map((hs) => {
    let v = base;
    for (const { s, k } of oppKeys) {
      // 反対の炭素の置換基の側は、p→i の直線から見ても同じ向きに測れるよう、i→p で測る
      const ss = sideOf(g, i, p, s);
      if (hs === 0 || ss === 0) return { shift: null, reason: '図から cis・trans が読めない（二重結合のまわりの向き）', label, method: M_ALKENE };
      v += ss === hs ? PMS[k][1] : PMS[k][2];
    }
    return { shift: v, label, method: M_ALKENE };
  });
}

function h1Alkyne(g: G, i: number, p: number): One {
  const s = heavyNbrs(g, p, i)[0]?.j;
  const label = '≡CH';
  if (s === undefined) return { shift: 1.91, label, method: M_ALKYNE };
  if (isSp3C(g, s)) {
    const het = heavyNbrs(g, s, p).some((n) => g[n.j].el === 'O' || g[n.j].el === 'N');
    return { shift: het ? 2.45 : 1.9, label, method: M_ALKYNE };
  }
  if (g[s].el === 'C' && g[s].arom) return { shift: 3.05, label, method: M_ALKYNE };
  if (carbonylO(g, s) >= 0) return { shift: 2.9, label, method: M_ALKYNE };
  return { shift: null, reason: `三重結合の置換基（${nameOf(g, s)} の基）が表に無い`, label, method: M_ALKYNE };
}

function h1Aldehyde(g: G, i: number, o: number): One {
  const s = g[i].nbr.find((n) => n.j !== o)?.j;
  const label = 'CHO';
  if (s === undefined) return { shift: null, reason: 'ホルムアルデヒドは表に無い', label, method: M_CO };
  if (isSp3C(g, s)) return { shift: 9.75, label, method: M_CO };
  if (g[s].el === 'C' && g[s].arom) return { shift: 9.95, label, method: M_CO };
  if (alkenePartner(g, s) >= 0) return { shift: 9.55, label, method: M_CO };
  if (g[s].el === 'N' || g[s].el === 'O') return { shift: 8.05, label: 'HC(=O)X', method: M_CO };
  return { shift: null, reason: `CHO の隣（${nameOf(g, s)}）が表に無い`, label, method: M_CO };
}

function predictH1(g: G, i: number): One[] {
  const a = g[i];
  if (a.el !== 'C') {
    return [{ shift: null, reason: 'OH・NH などの H は、溶媒・濃度・温度で大きく動くので出さない', label: `${a.el}H${a.hs > 1 ? a.hs : ''}`, method: M_NONE }];
  }
  if (a.charge) return [{ shift: null, reason: '電荷を持つ炭素は表に無い', label: hLabel(a.hs), method: M_NONE }];
  if (a.arom) return [h1Aromatic(g, i)];
  if (isSp3C(g, i)) return [h1Sp3(g, i)];
  const o = carbonylO(g, i);
  if (o >= 0) return [h1Aldehyde(g, i, o)];
  const p = alkenePartner(g, i);
  if (p >= 0) return h1Alkene(g, i, p);
  const q = alkynePartner(g, i);
  if (q >= 0) return [h1Alkyne(g, i, q)];
  return [{ shift: null, reason: 'この種類の炭素の H は表に無い', label: hLabel(a.hs), method: M_NONE }];
}

// ---------------------------------------------------------------- 入口

/** RDKit の分子（JSON）から、加成則のためのグラフを作る。H の原子は付いている原子の H の数に入れる */
function buildGraph(json: RdJson, coords: { x: number; y: number }[]): { g: G; heavy: number[]; ranks: number[] } {
  const mol = json.molecules[0];
  const defA = json.defaults.atom;
  const defB = json.defaults.bond;
  const ext = mol.extensions?.find((e) => e.name === 'rdkitRepresentation');
  const arom = new Set(ext?.aromaticAtoms ?? []);
  const all = mol.atoms.map((a, k) => ({
    el: SYMBOL[a.z ?? defA.z] ?? `#${a.z ?? defA.z}`,
    charge: a.chg ?? defA.chg ?? 0,
    hs: a.impHs ?? defA.impHs ?? 0,
    arom: arom.has(k),
    nbr: [] as { j: number; o: number }[],
    x: coords[k]?.x ?? 0,
    y: coords[k]?.y ?? 0,
    rings: [] as number[][],
  }));
  for (const b of mol.bonds) {
    const [p, q] = b.atoms;
    const o = b.bo ?? defB.bo ?? 1;
    if (all[p].el === 'H' || all[q].el === 'H') {
      const x = all[p].el === 'H' ? q : p;
      if (all[x].el !== 'H') all[x].hs++;
      continue;
    }
    all[p].nbr.push({ j: q, o });
    all[q].nbr.push({ j: p, o });
  }
  for (const r of ext?.atomRings ?? []) for (const k of r) all[k].rings.push(r);
  const heavy = all.map((_, k) => k).filter((k) => all[k].el !== 'H');
  return { g: all, heavy, ranks: symmetryClasses(all) };
}

/** 位相的に等価な原子の組（Morgan 型の繰り返し）。元素・電荷・H の数・芳香族・結合から始め、隣の組で分けていく */
function symmetryClasses(g: G): number[] {
  // 芳香環の結合は Kekulé の 1・2 で分けない
  const bo = (k: number, n: { j: number; o: number }) => (g[k].arom && g[n.j].arom ? 'a' : String(n.o));
  let cls = g.map((a, k) => `${a.el}|${a.charge}|${a.hs}|${a.arom ? 1 : 0}|${a.nbr.map((n) => bo(k, n)).sort().join('')}`);
  let count = new Set(cls).size;
  for (let it = 0; it < g.length; it++) {
    const next = g.map((a, k) => `${cls[k]}(${a.nbr.map((n) => `${bo(k, n)}${cls[n.j]}`).sort().join(',')})`);
    // 文字が長くならないよう、番号に置き換える
    const ids = new Map<string, number>();
    const renamed = next.map((x) => String(ids.has(x) ? ids.get(x) : (ids.set(x, ids.size), ids.size - 1)));
    const n = ids.size;
    cls = renamed;
    if (n === count) break;
    count = n;
  }
  return cls.map(Number);
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** 分子（atomIds の原子）の ¹³C と ¹H を予測する。等価な原子（RDKit の順位が同じで、値も同じ）はまとめる */
export function predictNmr(doc: Doc, atomIds: string[]): NmrPrediction | { error: string } {
  const { molblock, order, expanded } = expandedMolfile(doc, atomIds);
  const R = getRDKit();
  const m = R.get_mol(molblock, JSON.stringify({ removeHs: false }));
  if (!m) return { error: 'RDKit が構造を読めません。価数を確かめてください' };
  let json: RdJson;
  try {
    json = JSON.parse(m.get_json()) as RdJson;
  } finally {
    m.delete();
  }
  const coords = order.map((id) => expanded.atoms[id] ?? { x: 0, y: 0 });
  const { g, heavy, ranks } = buildGraph(json, coords);
  const idOf = (k: number) => order[k];

  const c13 = new Map<string, NmrShift>();
  const h1 = new Map<string, NmrShift>();
  const put = (map: Map<string, NmrShift>, k: number, one: One, count: number, sub = '') => {
    const shift = one.shift === null ? null : round(one.shift, map === c13 ? 1 : 2);
    const key = `${ranks[k]}|${shift}|${sub}|${'reason' in one ? one.reason : ''}`;
    const ids = [idOf(k)];
    const cur = map.get(key);
    if (cur) {
      cur.atomIds.push(...ids);
      cur.count += count;
      return;
    }
    map.set(key, {
      atomIds: ids,
      shift,
      count,
      label: one.label,
      method: one.method,
      ...('reason' in one ? { reason: one.reason } : {}),
      ...('low' in one && one.low ? { low: true } : {}),
    });
  };
  for (const k of heavy) {
    const a = g[k];
    if (a.el === 'C') put(c13, k, predictC13(g, k), 1);
    if (a.hs > 0 && a.el !== 'H') {
      const ones = predictH1(g, k);
      // =CH2 の 2 つの H は、それぞれ 1 個として出す
      ones.forEach((one, n) => put(h1, k, one, ones.length > 1 ? 1 : a.hs, ones.length > 1 ? String(n) : ''));
    }
  }
  const sort = (xs: NmrShift[]) => xs.sort((p, q) => (q.shift ?? -1e9) - (p.shift ?? -1e9));
  return { c13: sort([...c13.values()]), h1: sort([...h1.values()]) };
}

/** 論文の書き方（δ の値を大きい順、等価なものは個数）の文字にする */
export function formatNmrText(p: NmrPrediction): string {
  const c = p.c13.filter((s) => s.shift !== null).map((s) => `${s.shift!.toFixed(1)}${s.count > 1 ? ` (${s.count}C)` : ''}`);
  const h = p.h1.filter((s) => s.shift !== null).map((s) => `${s.shift!.toFixed(2)} (${s.count}H)`);
  const lines: string[] = [];
  if (h.length) lines.push(`1H NMR (predicted, additivity rules): δ ${h.join(', ')}`);
  if (c.length) lines.push(`13C NMR (predicted, additivity rules): δ ${c.join(', ')}`);
  return lines.join('\n');
}

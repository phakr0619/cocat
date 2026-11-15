// 分子グラフと反応スキームのデータモデル。座標は pt、y 下向き（CDXML と同じ）。
import type { P } from './geometry';

export type BondOrder = 1 | 2 | 3;
/** 結合の描き方。bold は太い線、dashed は点線（部分結合・水素結合）、dative は配位結合（a1 から a2 へ向く矢印。構造には入れない） */
export type BondStereo = 'none' | 'wedge' | 'hash' | 'wavy' | 'bold' | 'dashed' | 'dative';
/** 二重結合の2本目の線を置く側。left/right は a1→a2 の進行方向から見た側 */
export type DoublePos = 'auto' | 'center' | 'left' | 'right';
/** line は矢頭の無い線（検討表の罫線など）。resonance は両向き（共鳴）。curved は電子の動きを示す曲がった矢印（cx・cy が曲がり具合） */
export type ArrowKind = 'normal' | 'equilibrium' | 'retro' | 'line' | 'resonance' | 'curved';

export interface Atom {
  id: string;
  x: number;
  y: number;
  /** 元素記号。略号の原子では '*' */
  element: string;
  charge: number;
  /** 略号（Boc など）。縮約された状態の原子 */
  abbr?: string;
  /** スキームが置いた化合物の原子なら「スキーム id:化合物 id」 */
  ref?: string;
  /** プロジェクトのライブラリから置いた分子の原子なら、ライブラリの化合物 id */
  lib?: string;
  /** 同位体の質量数（13 なら ¹³C、水素の 2 は D と書く） */
  isotope?: number;
  /** ラジカル（不対電子 1 個。点を 1 つ描き、水素が 1 つ減る） */
  radical?: boolean;
  /** 描くローンペア（点 2 つ）の数。構造には効かない、図の上の印 */
  lonePairs?: number;
  /** 色（「#d32f2f」など）。無ければ黒 */
  color?: string;
  /**
   * まとまり（塩など、離れた部分をまとめた 1 つの化合物）の印。同じ値の原子は、つながっていなくても 1 つの分子として扱う
   * （分析・スキーム・ライブラリ・選択）。値は文書の中で一意（newId の 'u'）。docs/salt-design.md
   */
  unit?: string;
  /**
   * ラベルに書いた塩（「NH2Cl」「NH·HCl」）。対イオンは図に原子として持たず、書き出し・計算のときに原子を足す（expandSalts）。
   * ion: 原子を 1 価の陽イオン（水素が 1 つ増える）にして X⁻ を足す。dot: 原子はそのままで HX を足す
   */
  salt?: { x: SaltHalide; style: 'ion' | 'dot' };
  /**
   * 拡張立体表記の組（不斉中心だけに付ける）。and はラセミ（rac、&n）、or は相対配置（rel、orN）。無ければ絶対配置（abs）。
   * src/chem/stereoGroups.ts
   */
  stereoGroup?: { type: StereoGroupType; n: number };
}

export type SaltHalide = 'Cl' | 'Br' | 'I';
export type StereoGroupType = 'and' | 'or';

export interface Bond {
  id: string;
  /** くさびは a1 が細い側 */
  a1: string;
  a2: string;
  order: BondOrder;
  stereo: BondStereo;
  doublePos: DoublePos;
  /** 色（「#d32f2f」など）。無ければ黒 */
  color?: string;
}

export interface Arrow {
  id: string;
  /** 尾 */
  x1: number;
  y1: number;
  /** 頭 */
  x2: number;
  y2: number;
  kind: ArrowKind;
  /** スキームが置いた矢印ならスキーム id（検討表の罫線なら表の id） */
  ref?: string;
  /** 曲がった矢印の制御点（2 次のベジエ曲線。尾 → 制御点 → 頭） */
  cx?: number;
  cy?: number;
  /** 曲がった矢印の頭が片側だけ（電子 1 個の動き。釣り針の形） */
  half?: boolean;
  /** 点線の矢印 */
  dashed?: boolean;
  /** 進まない反応（✕ を付ける） */
  noGo?: boolean;
  /** 色（「#d32f2f」など）。無ければ黒 */
  color?: string;
  /** 線の太さ（pt）。無ければ描き方の線の太さ。実験の記録のフロー図で、重さを太さで示すときに使う */
  weight?: number;
}

export interface TextBox {
  id: string;
  /** 1行目のベースラインの左端 */
  x: number;
  y: number;
  text: string;
  /** 太字（化合物番号など） */
  bold?: boolean;
  /** 化学式の書き方（英字の後の数字を下付き）。CH2Cl2 など */
  formula?: boolean;
  /** スキームが置いた文字ならスキーム id */
  ref?: string;
  /** 色（「#d32f2f」など）。無ければ黒 */
  color?: string;
}

export interface Plus {
  id: string;
  x: number;
  y: number;
  /** スキームが置いた＋ならスキーム id */
  ref?: string;
  /** 色（「#d32f2f」など）。無ければ黒 */
  color?: string;
}

/** 図形: 四角・円（楕円）・括弧の組（[ ]・( )・{ }。ポリマーの繰り返しや錯体を囲む）。x1,y1〜x2,y2 の箱に描く */
export type ShapeKind = 'rect' | 'oval' | 'bracket-square' | 'bracket-round' | 'bracket-curly';
export interface Shape {
  id: string;
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 実験の記録のフロー図が置いた箱なら、その記録の id */
  ref?: string;
  /** 色（「#d32f2f」など）。無ければ黒 */
  color?: string;
}

/** 展開した略号。縮約に戻すために覚えておく */
export interface Group {
  id: string;
  abbr: string;
  atomIds: string[];
  /** 外とつながる原子 */
  attachId: string;
}

export interface Doc {
  atoms: Record<string, Atom>;
  bonds: Record<string, Bond>;
  arrows: Record<string, Arrow>;
  texts: Record<string, TextBox>;
  pluses: Record<string, Plus>;
  groups: Record<string, Group>;
  /** 図形（無ければ空） */
  shapes?: Record<string, Shape>;
  /** 図の設定（線の太さ・文字の大きさ）。無ければ ACS Document 1996 */
  drawStyle?: import('./style').DrawStyle;
  /** ページ（A4・スライド）の大きさと枚数。無ければページの枠を出さない（キャンバスはどこまでも広い） */
  page?: import('./page').PageSetup;
  nextId: number;
  /** 反応スキームのデータ（src/scheme/model.ts）。無ければ空 */
  compounds?: Record<string, import('../scheme/model').Compound>;
  schemes?: Record<string, import('../scheme/model').Scheme>;
  /** 利用者が変えた書式（プリセットを写して直したもの） */
  styles?: Record<string, import('../scheme/style').SchemeStyle>;
  /** 検討表のデータ（src/table/model.ts） */
  tables?: Record<string, import('../table/model').StudyTable>;
  /** 実験の記録のデータ（src/process/model.ts）。無ければ空 */
  runs?: Record<string, import('../process/model').ProcessRun>;
  /** この文書で使った、利用者の辞書の略号（名前 → * で結合する SMILES）。別の PC で開いても読めるように持つ */
  abbrDefs?: Record<string, string>;
}

export const emptyDoc = (): Doc => ({ atoms: {}, bonds: {}, arrows: {}, texts: {}, pluses: {}, groups: {}, nextId: 1, compounds: {}, schemes: {}, tables: {} });

/** id の頭の文字で種類が分かる: a 原子, b 結合, r 矢印, t 文字, p ＋記号, h 図形, g 略号, c 化合物, s スキーム, x スキームの段, m 検討表, k 表の列と行, u まとまり（原子の unit）, e 実験の記録とその中の行 */
export function newId(doc: Doc, prefix: 'a' | 'b' | 'r' | 't' | 'p' | 'h' | 'g' | 'c' | 's' | 'x' | 'm' | 'k' | 'u' | 'e'): string {
  return `${prefix}${doc.nextId++}`;
}

export function kindOf(id: string): 'atom' | 'bond' | 'arrow' | 'text' | 'plus' | 'shape' | 'group' {
  switch (id[0]) {
    case 'a':
      return 'atom';
    case 'b':
      return 'bond';
    case 'r':
      return 'arrow';
    case 't':
      return 'text';
    case 'p':
      return 'plus';
    case 'h':
      return 'shape';
    default:
      return 'group';
  }
}

/** doc を複製して fn で書き換える。編集操作はすべてこれを通す（元の doc は変えない） */
export function edit(doc: Doc, fn: (d: Doc) => void): Doc {
  const d = structuredClone(doc);
  fn(d);
  return d;
}

export const atomPos = (a: Atom): P => ({ x: a.x, y: a.y });

export interface Adjacency {
  /** 原子 id → その原子の結合 */
  bondsOf: Map<string, Bond[]>;
}

export function adjacency(doc: Doc): Adjacency {
  const bondsOf = new Map<string, Bond[]>();
  for (const id in doc.atoms) bondsOf.set(id, []);
  for (const b of Object.values(doc.bonds)) {
    bondsOf.get(b.a1)?.push(b);
    bondsOf.get(b.a2)?.push(b);
  }
  return { bondsOf };
}

export const otherEnd = (b: Bond, atomId: string): string => (b.a1 === atomId ? b.a2 : b.a1);

export function neighbors(adj: Adjacency, atomId: string): string[] {
  return (adj.bondsOf.get(atomId) ?? []).map((b) => otherEnd(b, atomId));
}

export function findBond(doc: Doc, a1: string, a2: string): Bond | undefined {
  for (const b of Object.values(doc.bonds)) {
    if ((b.a1 === a1 && b.a2 === a2) || (b.a1 === a2 && b.a2 === a1)) return b;
  }
  return undefined;
}

/** 連結成分（分子）ごとの原子 id */
export function fragments(doc: Doc, adj = adjacency(doc)): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id in doc.atoms) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of neighbors(adj, cur)) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * 分子ごとの原子 id。連結成分のうち、まとまり（原子の unit）が同じものを 1 つにまとめる（塩・共結晶など）。
 * 「1 つの化合物」を数える所（分析・スキーム・ライブラリ・選択）はこちらを使う
 */
export function molecules(doc: Doc, adj = adjacency(doc)): string[][] {
  const frags = fragments(doc, adj);
  // 同じ unit を持つ連結成分をつなぐ（1 つの連結成分に unit が 2 種類あっても、どちらのまとまりともつながる）
  const parent = frags.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstOf = new Map<string, number>();
  frags.forEach((f, i) => {
    for (const id of f) {
      const u = doc.atoms[id].unit;
      if (!u) continue;
      const j = firstOf.get(u);
      if (j === undefined) firstOf.set(u, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, string[]>();
  frags.forEach((f, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), ...f]);
  });
  return [...groups.values()];
}

/** 原子の unit を、新しい値に振り直す（貼り付け・置き直しで、元のまとまりと混ざらないように）。mk は新しい値を作る */
export function remapUnits(atoms: Iterable<Atom>, mk: () => string): void {
  const map = new Map<string, string>();
  for (const a of atoms) {
    if (!a.unit) continue;
    if (!map.has(a.unit)) map.set(a.unit, mk());
    a.unit = map.get(a.unit);
  }
}

export function bondValence(b: Bond): number {
  return b.order;
}

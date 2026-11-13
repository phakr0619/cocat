// 水素の自動付与と価数チェック
import { effectiveValences } from './elements';
import type { Adjacency, Atom, Doc } from './model';
import { adjacency } from './model';
import { getAbbr } from './abbreviations';
import { isRGroup } from './label';

/** 図の上の印で、構造（価数・SMILES・MOL）には入れない結合: 配位結合と点線の結合（水素結合・部分結合） */
export function drawnOnly(b: { stereo: string }): boolean {
  return b.stereo === 'dative' || b.stereo === 'dashed';
}

export function bondOrderSum(adj: Adjacency, atomId: string): number {
  let s = 0;
  // 配位結合と点線の結合（水素結合・部分結合）は、価数に数えない（NH3→BH3 の N は 3 価のまま、O−H···O の H は 1 価のまま）
  for (const b of adj.bondsOf.get(atomId) ?? []) if (!drawnOnly(b)) s += b.order;
  return s;
}

/** 補う水素の数。略号の原子と、価数を持たない元素は 0 */
export function implicitHydrogens(atom: Atom, adj: Adjacency): number {
  if (atom.abbr) return 0;
  // ラベルに書いた塩（NH2Cl）は、陽イオンとして水素を数える
  const vals = effectiveValences(atom.element, atom.charge + (atom.salt?.style === 'ion' ? 1 : 0));
  if (!vals) return 0;
  // ラジカルの不対電子は、結合 1 本と同じに数える
  const used = bondOrderSum(adj, atom.id) + (atom.radical ? 1 : 0);
  for (const v of vals) if (v >= used) return v - used;
  return 0;
}

/** 価数を超えている原子の id */
/** 構造の分からないラベル（略号の表・利用者の辞書・ラベルの読み方のどれでも読めず、置換基の記号でもないもの） */
export function unreadableLabel(abbr: string): boolean {
  return !getAbbr(abbr) && !isRGroup(abbr);
}

export function valenceErrors(doc: Doc, adj = adjacency(doc)): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(doc.atoms)) {
    if (a.abbr) {
      if ((adj.bondsOf.get(a.id)?.length ?? 0) > 1) out.add(a.id);
      // 構造の分からないラベル（ChemDraw のファイルで構造が抜けていて、読めなかったもの）も赤い枠で知らせる
      else if (unreadableLabel(a.abbr)) out.add(a.id);
      continue;
    }
    const vals = effectiveValences(a.element, a.charge);
    if (!vals) continue;
    if (bondOrderSum(adj, a.id) > Math.max(...vals)) out.add(a.id);
  }
  return out;
}

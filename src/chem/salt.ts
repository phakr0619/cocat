// 塩（まとまり）: 離れた部分を 1 つの化合物としてまとめる・解く。docs/salt-design.md
import { targetFragments } from './analysis';
import { implicitHydrogens } from './hydrogens';
import type { Doc, SaltHalide } from './model';
import { adjacency, edit, fragments, newId } from './model';

/** 選んだ物に掛かる分子（まとまり単位）。選択が空なら何も無い */
function touched(doc: Doc, sel: Set<string>): string[][] {
  return sel.size ? targetFragments(doc, sel) : [];
}

/** 選んだ物で「塩としてまとめる」ができるか（分子が 2 つ以上） */
export function canGroupSalt(doc: Doc, sel: Set<string>): boolean {
  return touched(doc, sel).length >= 2;
}

/** 選んだ物に、まとまり（2 つ以上の部分）があるか */
export function canUngroupSalt(doc: Doc, sel: Set<string>): boolean {
  return touched(doc, sel).some((m) => m.some((id) => doc.atoms[id].unit));
}

/** 選んだ分子（2 つ以上）を 1 つのまとまりにする。前のまとまりは 1 つに合わせる */
export function groupSalt(doc: Doc, sel: Set<string>): Doc {
  const mols = touched(doc, sel);
  if (mols.length < 2) return doc;
  return edit(doc, (d) => {
    const unit = newId(d, 'u');
    for (const m of mols) for (const id of m) d.atoms[id].unit = unit;
  });
}

/** 選んだ分子のまとまりを解き、部分ごとの分子に戻す */
export function ungroupSalt(doc: Doc, sel: Set<string>): Doc {
  const mols = touched(doc, sel);
  if (!mols.some((m) => m.some((id) => doc.atoms[id].unit))) return doc;
  return edit(doc, (d) => {
    for (const m of mols) for (const id of m) delete d.atoms[id].unit;
  });
}

/**
 * 読み込んだ分子（SMILES・MOL）の部分のうち、電荷を持つ部分があり、全体の電荷が打ち消し合うなら、全体を 1 つのまとまりにする。
 * 例: C[NH3+].[Cl-]・CC(=O)[O-].[Na+]。中性の部分だけ（酸.アミン）はまとめない（2026-11-06 に決めた）
 */
export function groupIonsOnImport(doc: Doc, atomIds: Iterable<string>): Doc {
  const ids = new Set(atomIds);
  const parts = fragments(doc, adjacency(doc)).filter((f) => f.some((id) => ids.has(id)));
  if (parts.length < 2) return doc;
  const charges = parts.map((p) => p.reduce((s, id) => s + doc.atoms[id].charge, 0));
  if (!charges.some((c) => c !== 0) || charges.reduce((s, c) => s + c, 0) !== 0) return doc;
  return edit(doc, (d) => {
    const unit = newId(d, 'u');
    for (const p of parts) for (const id of p) d.atoms[id].unit = unit;
  });
}

/**
 * ラベルの塩の書き方（「NH2Cl」）が、この原子に合わないときの知らせ。合えば null。
 * ion の書き方で水素の数を書いたときは、陽イオンにしたときの水素の数と同じでなければならない
 * （1 級アミンに「NHCl」と書いたら、塩ではなく N−Cl の結合を持つクロロアミンの書き方なので、塩としては読まない）
 */
export function saltLabelProblem(doc: Doc, atomId: string, parsed: { element: string; salt?: { style: 'ion' | 'dot'; hCount?: number; x: string } }): string | null {
  const salt = parsed.salt;
  if (!salt || salt.hCount === undefined) return null;
  const atom = { ...doc.atoms[atomId], element: parsed.element, charge: 0, abbr: undefined, salt: { x: salt.x as SaltHalide, style: salt.style } };
  const h = implicitHydrogens(atom, adjacency(doc));
  if (h === salt.hCount) return null;
  const want = salt.style === 'ion' ? `${parsed.element}${h ? `H${h > 1 ? h : ''}` : ''}${salt.x}` : `${parsed.element}${h ? `H${h > 1 ? h : ''}` : ''}·H${salt.x}`;
  return `この原子の塩は「${want}」と書きます（水素の数が合いません）`;
}

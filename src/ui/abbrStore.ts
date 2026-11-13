// 利用者の略号の辞書: ブラウザに覚え（localStorage）、使った略号は文書にも写す（別の PC で開いても読めるように）。
// docs/abbreviation-labels.md
import { ABBREVIATIONS, abbrSource, getAbbr, setUserAbbrs } from '../chem/abbreviations';
import { parseCondensed } from '../chem/condensed';
import { isElement } from '../chem/elements';
import { edit, type Doc } from '../chem/model';
import { getRDKit } from '../chem/rdkit';

const KEY = 'ai-chem-editor:abbr-user';
let docDefs: Record<string, string> = {};

export function loadUserDict(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveUserDict(d: Record<string, string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // 覚えられなくても、開いている間は使える
  }
}

/** 文書の辞書と利用者の辞書を合わせて、略号の引き方に入れる（同じ名前は利用者の辞書を使う） */
export function applyAbbrs() {
  setUserAbbrs({ ...docDefs, ...loadUserDict() });
}

/** 開いた文書が持つ辞書を入れる */
export function setDocAbbrs(defs: Record<string, string> | undefined) {
  const next = defs ?? {};
  if (JSON.stringify(next) === JSON.stringify(docDefs)) return;
  docDefs = next;
  applyAbbrs();
}

/**
 * 辞書に足す SMILES を確かめ、* から始まる形にする。* は結合する所で、ちょうど 1 つ。
 * 例: 「c1ccc2ccccc2c1*」→「*c1ccc2ccccc2c1」
 */
export function normalizeAbbrSmiles(smiles: string): { smiles: string } | { error: string } {
  const s = smiles.trim();
  if (!s) return { error: 'SMILES を入れてください' };
  const m = getRDKit().get_mol(s);
  if (!m) return { error: 'SMILES が読めません' };
  try {
    const atoms = (JSON.parse(m.get_json()).molecules?.[0]?.atoms ?? []) as { z?: number }[];
    const dummies = atoms.map((a, i) => ((a.z ?? 6) === 0 ? i : -1)).filter((i) => i >= 0);
    if (dummies.length !== 1) return { error: '結合する所を * で 1 つだけ書いてください（例: *c1ccc2ccccc2c1）' };
    const out = m.get_smiles(JSON.stringify({ rootedAtAtom: dummies[0] }));
    return out.startsWith('*') ? { smiles: out } : { error: '結合する所（*）から書けませんでした' };
  } finally {
    m.delete();
  }
}

/** 足せる名前か。だめなら理由 */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return '名前を入れてください';
  if (/\s/.test(n)) return '名前に空白は使えません';
  if (n.length > 16) return '名前は 16 文字までです';
  if (isElement(n)) return `${n} は元素記号なので、略号の名前にできません`;
  if (abbrSource(n) === 'standard') return `${n} は標準の略号にあります`;
  return null;
}

export function addUserAbbr(name: string, smiles: string) {
  saveUserDict({ ...loadUserDict(), [name.trim()]: smiles });
  applyAbbrs();
}

export function removeUserAbbr(name: string) {
  const d = loadUserDict();
  delete d[name];
  saveUserDict(d);
  applyAbbrs();
}

/** 文書で使った利用者の略号を、文書の辞書（abbrDefs）に写す。別の PC で開いても読めるように */
export function withUsedAbbrDefs(doc: Doc): Doc {
  // 自分の辞書の略号と、自分の辞書の略号を部品に使ったラベル（ONap）。標準の略号だけで読めるラベルは写さない
  const needsUser = (x: string) => abbrSource(x) === 'user' || (abbrSource(x) === 'label' && !parseCondensed(x, (n) => ABBREVIATIONS[n]?.smiles));
  const used = new Set(Object.values(doc.atoms).map((a) => a.abbr).filter((x): x is string => !!x && needsUser(x)));
  const need = [...used].filter((n) => doc.abbrDefs?.[n] !== getAbbr(n)!.smiles);
  if (!need.length) return doc;
  return edit(doc, (d) => {
    d.abbrDefs ??= {};
    for (const n of need) d.abbrDefs[n] = getAbbr(n)!.smiles;
  });
}

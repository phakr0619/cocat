// 名前 → 構造（M5 の最初の段）
//
// まず送らずに引く: 手元の辞書 → プロジェクトのライブラリ（番号・呼び名）→ SMILES として読めるか。
// どれでもなければ LLM に名前だけを送って SMILES と組成式を書かせ、RDKit で読み、組成式と立体（名前に書いた R/S）を照らす。
// OPSIN（規則で変換する）はブラウザで動く版が無く、サーバーも作らないので、今は使わない

import { analyzeFragment } from '../chem/analysis';
import { lookupCommonName, normalizeName } from '../chem/commonNames';
import { emptyDoc } from '../chem/model';
import { getRDKit } from '../chem/rdkit';
import { addSmiles } from '../io/smiles';
import type { LibraryCompound } from '../project/model';
import { askChecked } from './ask';
import { cipOf, statedCip } from './textToScheme';
import type { JsonSchema, LlmError, LlmProvider, LlmUsage, ThinkingLevel } from './types';

export type NameSource = 'dictionary' | 'library' | 'smiles' | 'opsin' | 'llm';

/** 送らずに引いた結果 */
export type LocalHit = { source: Exclude<NameSource, 'llm' | 'opsin'>; smiles: string; label?: string };

/** SMILES として読めるか（名前を SMILES と取り違えないよう、空白を含むものは読まない） */
function readableSmiles(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const m = getRDKit().get_mol(t);
  if (!m) return null;
  try {
    return m.get_num_atoms() ? t : null;
  } finally {
    m.delete();
  }
}

/** 送らずに引く。辞書 → ライブラリ（番号か呼び名がそのまま同じもの）→ SMILES の順。無ければ null */
export function resolveLocally(name: string, library: LibraryCompound[] = []): LocalHit | null {
  if (!name.trim()) return null;
  const dict = lookupCommonName(name);
  if (dict) return { source: 'dictionary', smiles: dict };
  const key = normalizeName(name);
  const lib = library.find((c) => [c.number, c.nickname].some((v) => v && normalizeName(v) === key));
  if (lib) return { source: 'library', smiles: lib.smiles, label: lib.number ?? lib.nickname };
  const smi = readableSmiles(name);
  return smi ? { source: 'smiles', smiles: smi } : null;
}

// ---- LLM ----

export const NAME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    smiles: { type: 'string', description: 'SMILES of the named compound. Omit when the name does not define one structure' },
    formula: { type: 'string', description: 'Molecular formula (Hill order) of the structure in "smiles", e.g. C3H7NO2' },
    note: { type: 'string', description: 'Why no SMILES was given, or anything the chemist should check (Japanese)' },
  },
};

export const NAME_SYSTEM_PROMPT = `You convert one chemical name (IUPAC, CAS, common or trade name; Japanese or English) into SMILES.
- Return the structure that the name defines. Encode the stereochemistry the name states (R/S, E/Z, D/L, cis/trans) exactly, and do not add stereochemistry the name does not state.
- If the name does not define a single structure (an in-house code, a compound number such as "3", a class name such as "amino acid", or a name you do not know), omit "smiles" and say why in "note". Never guess.
- "formula" is the molecular formula of the structure you return, written by counting atoms, in Hill order.`;

export type NameAnswer = { smiles?: string; formula?: string; note?: string };

export function checkNameShape(raw: unknown): { value: NameAnswer } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the answer must be a JSON object' };
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  for (const k of ['smiles', 'formula', 'note'] as const) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') return { error: `"${k}" must be a string` };
  return { value: { smiles: str(o.smiles), formula: str(o.formula), note: str(o.note) } };
}

/** 組成式を元素ごとの数にする（「C3H7NO2」→ C:3 H:7 N:1 O:2）。読めなければ null */
export function formulaCounts(formula: string): Map<string, number> | null {
  const t = formula.replace(/\s/g, '');
  const parts = [...t.matchAll(/([A-Z][a-z]?)(\d*)/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== t) return null;
  const out = new Map<string, number>();
  for (const [, el, n] of parts) out.set(el, (out.get(el) ?? 0) + (n ? Number(n) : 1));
  return out;
}

const sameCounts = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** SMILES の組成式（RDKit で読み、描くときと同じ数え方）。読めなければ null */
export function formulaOfSmiles(smiles: string): string | null {
  try {
    const r = addSmiles(emptyDoc(), smiles, { x: 0, y: 0 });
    const a = analyzeFragment(r.doc, r.atomIds);
    return 'error' in a ? null : a.formula;
  } catch {
    return null;
  }
}

const cipText = (c: { R: number; S: number }) => (c.R + c.S ? [...Array(c.R).fill('R'), ...Array(c.S).fill('S')].join(',') : 'なし');

/** LLM の答えを確かめる。構造が読めれば smiles と、気づいたこと（warnings）を返す */
export function checkNameAnswer(name: string, a: NameAnswer): { smiles: string; formula: string; warnings: string[] } | { error: string } {
  if (!a.smiles) return { error: a.note ? `構造を決められませんでした: ${a.note}` : 'この名前からは構造を決められませんでした' };
  const formula = formulaOfSmiles(a.smiles);
  if (!formula) return { error: `答えの SMILES を読めませんでした（${a.smiles}）` };
  const warnings: string[] = [];
  const said = a.formula ? formulaCounts(a.formula) : null;
  const actual = formulaCounts(formula);
  if (a.formula && said && actual && !sameCounts(said, actual)) warnings.push(`答えの組成式（${a.formula}）と、SMILES の組成式（${formula}）が違います。構造を確かめてください`);
  const stated = statedCip(name);
  const cip = cipOf(a.smiles);
  if (stated && cip && (stated.R !== cip.R || stated.S !== cip.S)) warnings.push(`名前の立体（${cipText(stated)}）と、構造の立体（${cipText(cip)}）が違います`);
  if (a.note) warnings.push(a.note);
  return { smiles: a.smiles, formula, warnings };
}

/** 送る本文。名前のほかは送らない */
export function namePrompt(name: string): string {
  return `NAME: ${name.trim()}`;
}

export type NameToStructureResult =
  | { ok: true; smiles: string; formula: string; warnings: string[]; usage?: LlmUsage }
  | { ok: false; error: LlmError | { kind: 'unresolved'; message: string }; usage?: LlmUsage };

/** 名前を LLM に送り、SMILES を書かせて確かめる（形が崩れていれば1回だけ直させる） */
export async function nameToStructure(llm: LlmProvider, req: { name: string; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<NameToStructureResult> {
  const r = await askChecked(llm, { system: NAME_SYSTEM_PROMPT, user: namePrompt(req.name), schema: NAME_SCHEMA, thinking: req.thinking, signal: req.signal }, checkNameShape);
  if (!r.ok) return r;
  const c = checkNameAnswer(req.name, r.value);
  if ('error' in c) return { ok: false, error: { kind: 'unresolved', message: c.error }, usage: r.usage };
  return { ok: true, ...c, usage: r.usage };
}

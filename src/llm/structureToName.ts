// 構造 → 名前（ChemDraw の Struct=Name に当たるもの）
//
// まず送らずに引く: 手元の辞書（よく使う試薬・溶媒の名前）に同じ構造があれば、その名前。
// 無ければ構造（SMILES）を LLM に送って IUPAC 名を書かせ、**名前から構造に戻して**、元の構造と同じか（立体を含む InChIKey）を確かめる。
// 戻すのは、まず OPSIN（規則で変換する。このサイトのサーバー）。OPSIN に届かないか、OPSIN が読めない名前のときだけ、別の LLM の呼び出し（nameToStructure）で戻す。同じなら「確かめ済み」、違えば要確認として、戻した構造の違いを見せる。
// 名前を作る規則の部品（ChemDraw・OpenEye など）はブラウザで動く自由な版が無いので、今は LLM と確かめの組み合わせ
import { commonNameEntries } from '../chem/commonNames';
import { opsinName } from '../chem/opsin';
import { getRDKit } from '../chem/rdkit';
import { askChecked } from './ask';
import { formulaOfSmiles, nameToStructure } from './nameToStructure';
import { addUsage, type JsonSchema, type LlmError, type LlmProvider, type LlmUsage, type ThinkingLevel } from './types';

/** 立体を含む InChIKey（読めなければ null） */
export function inchikeyOf(smiles: string): string | null {
  const R = getRDKit();
  const m = R.get_mol(smiles);
  if (!m) return null;
  try {
    const inchi = m.get_inchi();
    return inchi ? R.get_inchikey_for_inchi(inchi) : null;
  } finally {
    m.delete();
  }
}

let dictByKey: Map<string, string[]> | null = null;

/** 手元の辞書で、同じ構造の名前を探す（送らない）。英語の名前を先に返す */
export function nameLocally(smiles: string): string[] {
  const key = inchikeyOf(smiles);
  if (!key) return [];
  if (!dictByKey) {
    dictByKey = new Map();
    for (const [s, ...names] of commonNameEntries()) {
      const k = inchikeyOf(s);
      if (k && !dictByKey.has(k)) dictByKey.set(k, names);
    }
  }
  return dictByKey.get(key) ?? [];
}

export const STRUCT_NAME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'IUPAC name in English, with the stereodescriptors (R/S, E/Z) of the structure' },
    note: { type: 'string', description: 'Anything the chemist should check (Japanese). Omit when there is nothing' },
  },
};

export const STRUCT_NAME_SYSTEM_PROMPT = `You give the IUPAC name (English) of one structure written as SMILES.
- Name exactly the structure in the SMILES. Include every stereodescriptor the SMILES defines (R/S, E/Z) and no others.
- Prefer the preferred IUPAC name. Do not give a trade name or an abbreviation.
- If you cannot name it with confidence, still give your best name and say what is uncertain in "note" (Japanese).`;

export type StructNameAnswer = { name?: string; note?: string };

export function checkStructNameShape(raw: unknown): { value: StructNameAnswer } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the answer must be a JSON object' };
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : undefined;
  if (!name) return { error: '"name" is required' };
  return { value: { name, note: typeof o.note === 'string' && o.note.trim() ? o.note.trim() : undefined } };
}

/** 送る本文。構造の SMILES のほかは送らない */
export const structNamePrompt = (smiles: string) => `SMILES: ${smiles}`;

export type StructureToNameResult =
  | {
      ok: true;
      name: string;
      /** 名前から戻した構造が、元の構造と同じ（立体を含む） */
      verified: boolean;
      /** 名前から戻した構造（戻せなければ undefined） */
      back?: string;
      /** 名前から構造に戻したもの: OPSIN（規則）か LLM。戻せなければ undefined */
      checkedBy?: 'opsin' | 'llm';
      warnings: string[];
      usage?: LlmUsage;
    }
  | { ok: false; error: LlmError; usage?: LlmUsage };

/** 構造の名前を LLM に書かせ、名前から構造に戻して確かめる（LLM の呼び出しは、OPSIN で戻せれば 1 回、戻せなければ 2 回） */
export async function structureToName(
  llm: LlmProvider,
  req: { smiles: string; thinking?: ThinkingLevel; signal?: AbortSignal; opsin?: typeof opsinName },
): Promise<StructureToNameResult> {
  const r = await askChecked(
    llm,
    { system: STRUCT_NAME_SYSTEM_PROMPT, user: structNamePrompt(req.smiles), schema: STRUCT_NAME_SCHEMA, thinking: req.thinking, signal: req.signal },
    checkStructNameShape,
  );
  if (!r.ok) return r;
  const name = r.value.name!;
  const warnings = r.value.note ? [r.value.note] : [];
  let backSmiles: string;
  let checkedBy: 'opsin' | 'llm';
  let usage = r.usage;
  const op = await (req.opsin ?? opsinName)(name, req.signal);
  if (req.signal?.aborted) return { ok: false, error: { kind: 'aborted', message: 'やめました' }, usage };
  if (op) {
    backSmiles = op.smiles;
    checkedBy = 'opsin';
    if (op.warning) warnings.push(op.warning);
  } else {
    const back = await nameToStructure(llm, { name, thinking: req.thinking, signal: req.signal });
    usage = addUsage(r.usage, back.usage);
    if (!back.ok) {
      if (back.error.kind === 'aborted') return { ok: false, error: back.error, usage };
      warnings.unshift('名前から構造に戻せなかったので、名前が合っているか確かめられませんでした');
      return { ok: true, name, verified: false, warnings, usage };
    }
    backSmiles = back.smiles;
    checkedBy = 'llm';
  }
  const want = inchikeyOf(req.smiles);
  const got = inchikeyOf(backSmiles);
  const verified = !!want && want === got;
  if (!verified) {
    // 骨格は同じで立体だけ違うのか、構造が違うのかを分けて知らせる
    const sameSkeleton = want && got && want.slice(0, 14) === got.slice(0, 14);
    const f1 = formulaOfSmiles(req.smiles);
    const f2 = formulaOfSmiles(backSmiles);
    warnings.unshift(
      sameSkeleton
        ? '名前から戻した構造は、立体が元と違います。名前の R/S・E/Z を確かめてください'
        : `名前から戻した構造（${f2 ?? backSmiles}）が元（${f1 ?? req.smiles}）と違います。名前を確かめてください`,
    );
  }
  return { ok: true, name, verified, back: backSmiles, checkedBy, warnings, usage };
}

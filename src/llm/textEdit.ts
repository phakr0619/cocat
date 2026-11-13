// 言葉での編集（M3-4）
//
// 文章 → LLM に「操作の並び」を決まった形の JSON で返させる（文書は直接書き換えさせない）
// → 形と指す先（段・試薬・化合物・書式があるか）を確かめる → M2 の関数で、今の文書の写しに当てる
// → 前と後の差を一覧で見せる → 確定で今の文書に入れる（元に戻す1回で戻る）
// 段1: 構造を変えない操作（試薬・条件・番号・呼び名・書式）。段2: 構造の書き換え（「Boc を Cbz に」）。
// 構造は LLM に直した後の SMILES を返させ、RDKit で読めるか・分子式の差が言った基の入れ替えと合うか・
// 不斉中心の数が変わらないかを確かめる。合わなければ要確認を付ける（確定はできる）。
// 書き換えるのは、指示で指したか選んだ化合物だけ。スキーム全体は、指示ではっきり頼まれたときだけ

import type { Doc } from '../chem/model';
import { emptyDoc } from '../chem/model';
import { ABBREVIATIONS } from '../chem/abbreviations';
import { analyzeFragment } from '../chem/analysis';
import { identify } from '../project/library';
import type { Reagent, Scheme, Step, Structure } from '../scheme/model';
import { numberCompounds, replaceCompoundStructure, setSchemeStyle, updateCompound, updateStep } from '../scheme/ops';
import { STYLE_PRESETS, getStyle } from '../scheme/style';
import { askChecked } from './ask';
import { cipOf, structureFromSmiles } from './textToScheme';
import type { JsonSchema, LlmError, LlmProvider, LlmUsage, ThinkingLevel } from './types';

// ---- LLM に返させる形 ----

export const EDIT_OPS = ['replace_reagent', 'add_reagent', 'remove_reagent', 'set_condition', 'renumber', 'set_style', 'set_compound', 'replace_structure'] as const;
export const CONDITION_FIELDS = ['solvent', 'temp', 'time', 'yield'] as const;
type ConditionKey = (typeof CONDITION_FIELDS)[number];

/** 確かめた後の操作。段は 0 から、化合物は id で指す */
export type EditOp =
  | { op: 'replace_reagent'; step: number; index: number; to: Reagent }
  | { op: 'add_reagent'; step: number; reagent: Reagent }
  | { op: 'remove_reagent'; step: number; index: number }
  | { op: 'set_condition'; step: number; field: ConditionKey; value: string }
  | { op: 'renumber'; start: number; prefix: string }
  | { op: 'set_style'; styleId: string }
  | { op: 'set_compound'; compoundId: string; number?: string; nickname?: string }
  | { op: 'replace_structure'; compoundId: string; structure: Structure };

const str = { type: 'string' };
export const EDIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: [...EDIT_OPS] },
          step: { type: 'integer', description: 'Step number, starting at 1' },
          reagent: { ...str, description: 'The current reagent text to replace or remove' },
          text: { ...str, description: 'New reagent text' },
          equiv: { type: 'number' },
          field: { type: 'string', enum: [...CONDITION_FIELDS] },
          value: { ...str, description: 'New value. Empty string clears it' },
          start: { type: 'integer' },
          prefix: str,
          style: { ...str, description: 'Style id from STYLES' },
          compound: { ...str, description: 'Key of the compound from COMPOUNDS' },
          number: str,
          nickname: str,
          smiles: { ...str, description: 'The whole new structure of the compound' },
          from_group: { ...str, description: 'Group taken out, such as Boc' },
          to_group: { ...str, description: 'Group put in, such as Cbz' },
        },
        required: ['op'],
      },
    },
    whole_scheme: { type: 'boolean', description: 'true only when the instruction explicitly asks to change the whole scheme' },
    questions: { type: 'array', items: str },
  },
  required: ['ops'],
};

export const EDIT_SYSTEM_PROMPT = `You edit an existing reaction scheme following a chemist's instruction (Japanese or English).
Do not rewrite the scheme. Return only JSON with a list of operations that matches the schema.

Operations (use only these):
- replace_reagent: step, reagent (the current text, as listed), text (new reagent), equiv (repeat the old value if it should stay; omit to drop it).
- add_reagent: step, text, equiv (optional).
- remove_reagent: step, reagent.
- set_condition: step, field (solvent, temp, time or yield), value. An empty value clears it. yield is a number in percent or text such as "quant.".
- renumber: renumber the compounds in the order they appear. start (default 1), prefix (default empty).
- set_style: style (an id from STYLES).
- set_compound: compound (a key from COMPOUNDS), number and/or nickname. An empty value clears it.
- replace_structure: compound (a key from COMPOUNDS), smiles (required: the whole new structure; keep every other part and all stereochemistry unchanged), from_group and to_group (abbreviations such as Boc, Cbz, Fmoc, Bn, TBS, Me when the change swaps one group for another).

Rules:
- Steps are numbered from 1 as in SCHEME. Refer to compounds by their key.
- Solvents go in set_condition with field solvent, not in reagents.
- Structure changes: change only the compounds the instruction names (by number or nickname) or the SELECTED compounds, and do not change reagents for them. Only when the instruction explicitly asks to change the whole scheme (for example "スキーム全体で", "throughout the scheme"), set whole_scheme to true: then change every compound that has the group, and the reagents and conditions that depend on it (for example the deprotection step). If it is unclear which compounds to change, return no structure operation and ask in questions.
- If the instruction is unclear or refers to something not in the scheme, return no operation for it and ask in questions, in the language of the instruction. Leave questions empty when there are none.`;

// ---- 送る内容 ----

const reagentText = (r: Reagent) => (r.equiv !== undefined ? `${r.text} (${r.equiv} equiv)` : r.text);
const structureDoc = (c: NonNullable<Doc['compounds']>[string]): Doc => ({ ...emptyDoc(), atoms: c.structure.atoms, bonds: c.structure.bonds, groups: c.structure.groups });

/** スキームに出てくる化合物（出てくる順） */
function schemeCompounds(s: Scheme): string[] {
  const out: string[] = [];
  for (const st of s.steps) for (const c of [...st.from, ...st.to]) if (!out.includes(c)) out.push(c);
  return out;
}

const smilesOf = (c: NonNullable<Doc['compounds']>[string]) => identify(structureDoc(c), Object.keys(c.structure.atoms))?.smiles ?? '';

export interface EditContext {
  answers?: { question: string; answer: string }[];
  /** 選んでいる化合物（このスキームの化合物 id） */
  selected?: string[];
}

/** LLM に送る本文（指示と、直すスキームの化合物・段・書式・選んでいる化合物。ほかは送らない） */
export function editPrompt(doc: Doc, schemeId: string, text: string, ctx: EditContext = {}): string {
  const s = doc.schemes![schemeId];
  const answers = ctx.answers;
  const compounds = schemeCompounds(s).map((id) => {
    const c = doc.compounds![id];
    return `- key=${id}; number=${c.number ?? ''}; nickname=${c.nickname ?? ''}; smiles=${smilesOf(c)}`;
  });
  const selected = (ctx.selected ?? []).filter((id) => compounds.some((l) => l.startsWith(`- key=${id};`)));
  const steps = s.steps.map((st, i) =>
    [
      `- step ${i + 1}: from=${st.from.join(',')}; to=${st.to.join(',')}`,
      `reagents=${st.reagents.map(reagentText).join(' | ')}`,
      `solvent=${st.solvent ?? ''}; temp=${st.temp ?? ''}; time=${st.time ?? ''}; yield=${st.yield ?? ''}`,
    ].join('; '),
  );
  const styles = [...STYLE_PRESETS, ...Object.values(doc.styles ?? {})].map((x) => `- id=${x.id}; name=${x.name}${x.id === s.styleId ? ' (current)' : ''}`);
  const qa = (answers ?? []).filter((a) => a.answer.trim());
  return [
    'COMPOUNDS:',
    compounds.join('\n') || '(none)',
    '',
    'SCHEME:',
    steps.join('\n'),
    '',
    'STYLES:',
    styles.join('\n'),
    '',
    `SELECTED: ${selected.join(', ') || '(none)'}`,
    '',
    'INSTRUCTION:',
    text.trim(),
    ...(qa.length ? ['', 'ANSWERS to your earlier questions:', ...qa.map((a) => `- Q: ${a.question}\n  A: ${a.answer.trim()}`)] : []),
  ].join('\n');
}

// ---- 形と指す先の確かめ ----

export interface CheckedEdit {
  ops: EditOp[];
  /** 使えなかった操作と理由（利用者に見せる） */
  rejected: string[];
  /** 要確認（当てるが、人が確かめるべきこと。構造の書き換えの確かめに合わなかったもの） */
  warnings: string[];
  /** 指示でスキーム全体の書き換えを頼まれた（LLM の判断） */
  wholeScheme: boolean;
  questions: string[];
}

type RawEdit = { ops: Record<string, unknown>[]; questions: string[]; wholeScheme?: boolean };

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): string | undefined => (isStr(v) && v.trim() ? v.trim() : undefined);
const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase();

/** JSON の形を確かめる。崩れていれば理由（直させる） */
export function checkEditShape(raw: unknown): { value: RawEdit } | { error: string } {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { ops?: unknown }).ops)) return { error: 'ops must be an array' };
  const r = raw as { ops: unknown[]; questions?: unknown; whole_scheme?: unknown };
  const ops = r.ops.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object');
  const questions = Array.isArray(r.questions) ? r.questions.map(optStr).filter((q): q is string => !!q) : [];
  if (!ops.length && !questions.length) return { error: 'no operations and no questions' };
  // 構造の書き換えで SMILES を書き忘れることがある（2026-10-25、本物の Gemini で）。形の崩れとして直させる
  if (ops.some((o) => o.op === 'replace_structure' && !optStr(o.smiles))) return { error: 'replace_structure needs smiles (the whole new structure)' };
  return { value: { ops, questions, wholeScheme: r.whole_scheme === true } };
}

// ---- 構造の書き換えの確かめ ----

type Counts = Map<string, number>;

/** SMILES の元素の数（水素を含む）。読めなければ null */
export function elementCounts(smiles: string): Counts | null {
  const s = structureFromSmiles(smiles);
  if (!s) return null;
  const r = analyzeFragment({ ...emptyDoc(), atoms: s.atoms, bonds: s.bonds, groups: s.groups }, Object.keys(s.atoms));
  if (!('formula' in r) || !r.formula) return null;
  const out: Counts = new Map();
  for (const m of r.formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) out.set(m[1], (out.get(m[1]) ?? 0) + (m[2] ? Number(m[2]) : 1));
  return out;
}

/** 略号の表の基を、水素の代わりに付けたときに増える元素の数（Boc なら C5H8O2）。表に無ければ null */
function groupCounts(name: string): Counts | null {
  const key = Object.keys(ABBREVIATIONS).find((k) => k.toLowerCase() === name.trim().toLowerCase());
  if (!key) return null;
  const withH = elementCounts(ABBREVIATIONS[key].smiles.replace('*', ''));
  if (!withH) return null;
  withH.set('H', (withH.get('H') ?? 0) - 1);
  return withH;
}

const diff = (a: Counts, b: Counts): Counts => {
  const out: Counts = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const v = (a.get(k) ?? 0) - (b.get(k) ?? 0);
    if (v) out.set(k, v);
  }
  return out;
};
const countsText = (c: Counts) => (c.size ? [...c].map(([k, v]) => `${v > 0 ? '+' : '−'}${k}${Math.abs(v) === 1 ? '' : Math.abs(v)}`).join(' ') : '差なし');

/** 分子式の差（後 − 前）が、基の入れ替え（to − from）の n 倍（n ≥ 1）になっているか */
function swapMatches(change: Counts, from: Counts, to: Counts): boolean {
  const g = diff(to, from);
  if (!g.size) return !change.size;
  const [k, v] = [...g][0];
  const n = (change.get(k) ?? 0) / v;
  if (!Number.isInteger(n) || n < 1) return false;
  return [...new Set([...g.keys(), ...change.keys()])].every((e) => (change.get(e) ?? 0) === n * (g.get(e) ?? 0));
}

const cipCount = (smiles: string) => {
  const c = cipOf(smiles);
  return c ? c.R + c.S : null;
};

/** 化合物を、指示の文章が番号か呼び名で指しているか */
function named(c: { number?: string; nickname?: string }, text: string): boolean {
  const n = c.number?.trim();
  if (n && new RegExp(`(?<![0-9A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`).test(text)) return true;
  const nick = c.nickname?.trim();
  return !!nick && text.toLowerCase().includes(nick.toLowerCase());
}

/** 操作が指す段・試薬・化合物・書式が、今のスキームにあるかを確かめる。無いものは理由を付けて外す */
export function checkEdit(doc: Doc, schemeId: string, raw: RawEdit, ctx: { text?: string; selected?: string[] } = {}): CheckedEdit {
  const s = doc.schemes![schemeId];
  const warnings: string[] = [];
  const wholeScheme = raw.wholeScheme === true;
  const used = schemeCompounds(s);
  const styleIds = new Set([...STYLE_PRESETS, ...Object.values(doc.styles ?? {})].map((x) => x.id));
  const ops: EditOp[] = [];
  const rejected: string[] = [];
  const equivOf = (v: unknown) => (typeof v === 'number' && v > 0 ? { equiv: v } : {});
  // 試薬の操作は順に当てるので、位置は前の操作を当てた後の並びで決める（同じ段の試薬を2つ消すとき、2つ目の位置がずれる）
  const reagents = s.steps.map((st) => [...st.reagents]);

  for (const o of raw.ops) {
    const kind = o.op;
    const n = typeof o.step === 'number' ? o.step : NaN;
    const step = Number.isInteger(n) && n >= 1 && n <= s.steps.length ? n - 1 : null;
    const needStep = () => {
      if (step === null) rejected.push(`${kind}: ${Number.isFinite(n) ? `${n} 段目` : '段の指定'}がありません（このスキームは ${s.steps.length} 段）`);
      return step;
    };
    /** 段の中の試薬を、書き方で探す（大文字小文字と空白は問わない） */
    const findReagent = (st: number) => {
      const t = optStr(o.reagent);
      const i = t ? reagents[st].findIndex((r) => norm(r.text) === norm(t) || norm(reagentText(r)) === norm(t)) : -1;
      if (i < 0) rejected.push(`${kind}: ${st + 1} 段目に試薬「${t ?? ''}」がありません`);
      return i < 0 ? null : i;
    };
    switch (kind) {
      case 'replace_reagent':
      case 'remove_reagent': {
        const st = needStep();
        if (st === null) break;
        const i = findReagent(st);
        if (i === null) break;
        if (kind === 'remove_reagent') {
          ops.push({ op: kind, step: st, index: i });
          reagents[st].splice(i, 1);
        } else if (!optStr(o.text)) rejected.push(`${kind}: 新しい試薬がありません`);
        else {
          const to = { text: optStr(o.text)!, ...equivOf(o.equiv) };
          ops.push({ op: kind, step: st, index: i, to });
          reagents[st][i] = to;
        }
        break;
      }
      case 'add_reagent': {
        const st = needStep();
        if (st === null) break;
        if (!optStr(o.text)) rejected.push(`${kind}: 試薬がありません`);
        else {
          const reagent = { text: optStr(o.text)!, ...equivOf(o.equiv) };
          ops.push({ op: kind, step: st, reagent });
          reagents[st].push(reagent);
        }
        break;
      }
      case 'set_condition': {
        const st = needStep();
        if (st === null) break;
        const field = CONDITION_FIELDS.find((f) => f === o.field);
        if (!field) rejected.push(`${kind}: 項目「${String(o.field ?? '')}」は直せません`);
        else ops.push({ op: kind, step: st, field, value: isStr(o.value) ? o.value.trim() : typeof o.value === 'number' ? String(o.value) : '' });
        break;
      }
      case 'renumber': {
        const start = typeof o.start === 'number' && Number.isInteger(o.start) && o.start >= 0 ? o.start : 1;
        ops.push({ op: kind, start, prefix: isStr(o.prefix) ? o.prefix.trim() : '' });
        break;
      }
      case 'set_style': {
        const id = optStr(o.style);
        if (!id || !styleIds.has(id)) rejected.push(`${kind}: 書式「${id ?? ''}」がありません`);
        else ops.push({ op: kind, styleId: id });
        break;
      }
      case 'set_compound': {
        const key = optStr(o.compound);
        if (!key || !used.includes(key)) {
          rejected.push(`${kind}: 化合物「${key ?? ''}」がこのスキームにありません`);
          break;
        }
        const patch: { number?: string; nickname?: string } = {};
        if (isStr(o.number)) patch.number = o.number.trim();
        if (isStr(o.nickname)) patch.nickname = o.nickname.trim();
        if (!('number' in patch) && !('nickname' in patch)) rejected.push(`${kind}: 番号も呼び名もありません`);
        else ops.push({ op: kind, compoundId: key, ...patch });
        break;
      }
      case 'replace_structure': {
        const key = optStr(o.compound);
        const c = key && used.includes(key) ? doc.compounds![key] : undefined;
        if (!c) {
          rejected.push(`${kind}: 化合物「${key ?? ''}」がこのスキームにありません`);
          break;
        }
        const name = c.number || c.nickname || key!;
        // 書き換えるのは、指示で指したか選んだ化合物だけ（スキーム全体は、指示ではっきり頼まれたときだけ）
        if (!wholeScheme && !(ctx.selected ?? []).includes(key!) && !named(c, ctx.text ?? '')) {
          rejected.push(`${kind}: ${name} は指示でも選択でも指していないので、構造を書き換えません（スキーム全体なら、そう書いてください）`);
          break;
        }
        const smiles = optStr(o.smiles);
        const structure = smiles ? structureFromSmiles(smiles) : null;
        const after = smiles && structure ? elementCounts(smiles) : null;
        if (!smiles || !structure || !after) {
          rejected.push(`${kind}: ${name} の新しい構造（SMILES）が${smiles ? '読めません' : 'ありません'}`);
          break;
        }
        const oldSmiles = smilesOf(c);
        const before = oldSmiles ? elementCounts(oldSmiles) : null;
        const fromG = optStr(o.from_group);
        const toG = optStr(o.to_group);
        const swap = fromG && toG ? `${fromG} → ${toG}` : '構造の書き換え';
        if (before) {
          const change = diff(after, before);
          const gf = fromG ? groupCounts(fromG) : null;
          const gt = toG ? groupCounts(toG) : null;
          if (!fromG || !toG) warnings.push(`${name}: どの基を入れ替えたかが分からないので、分子式の差（${countsText(change)}）を確かめられません。構造を確かめてください`);
          else if (!gf || !gt) warnings.push(`${name}: ${swap} は略号の表に無いので、分子式の差（${countsText(change)}）を確かめられません。構造を確かめてください`);
          else if (!swapMatches(change, gf, gt))
            warnings.push(`${name}: 分子式の差（${countsText(change)}）が ${swap}（${countsText(diff(gt, gf))}）と合いません。構造を確かめてください`);
          const sb = cipCount(oldSmiles);
          const sa = cipCount(smiles);
          if (sb !== null && sa !== null && sb !== sa) warnings.push(`${name}: 立体の決まった不斉中心の数が ${sb} → ${sa} に変わりました。立体を確かめてください`);
        }
        ops.push({ op: kind, compoundId: key!, structure });
        break;
      }
      default:
        rejected.push(`知らない操作「${String(kind ?? '')}」は使えません`);
    }
  }
  return { ops, rejected, warnings, wholeScheme, questions: raw.questions };
}

// ---- 当てる ----

/** 操作を順に当てた文書を返す（元の文書は変えない）。操作はすべて M2 の関数で行う */
export function applyEdit(doc: Doc, schemeId: string, ops: EditOp[]): Doc {
  let d = doc;
  const step = (i: number) => d.schemes![schemeId].steps[i];
  for (const o of ops) {
    switch (o.op) {
      case 'replace_reagent':
        d = updateStep(d, schemeId, o.step, { reagents: step(o.step).reagents.map((r, i) => (i === o.index ? { ...o.to } : r)) });
        break;
      case 'add_reagent':
        d = updateStep(d, schemeId, o.step, { reagents: [...step(o.step).reagents, { ...o.reagent }] });
        break;
      case 'remove_reagent':
        d = updateStep(d, schemeId, o.step, { reagents: step(o.step).reagents.filter((_, i) => i !== o.index) });
        break;
      case 'set_condition': {
        // 収率は「92」「92%」「92 %」なら数にする（「92%」の文字のままだと、書式の「{y}%」で「92%%」になる。2026-10-25、本物の Gemini で）
        const y = o.field === 'yield' ? /^(\d+(?:\.\d+)?)\s*%?$/.exec(o.value) : null;
        const v = y ? Number(y[1]) : o.value;
        d = updateStep(d, schemeId, o.step, { [o.field]: v === '' ? undefined : v });
        break;
      }
      case 'renumber':
        d = numberCompounds(d, schemeId, o.start, o.prefix);
        break;
      case 'set_style':
        d = setSchemeStyle(d, schemeId, o.styleId);
        break;
      case 'set_compound': {
        const patch: { number?: string; nickname?: string } = {};
        if (o.number !== undefined) patch.number = o.number || undefined;
        if (o.nickname !== undefined) patch.nickname = o.nickname || undefined;
        d = updateCompound(d, o.compoundId, patch);
        break;
      }
      case 'replace_structure':
        d = replaceCompoundStructure(d, o.compoundId, o.structure);
        break;
    }
  }
  return d;
}

// ---- 差の一覧 ----

const CONDITION_NAMES: Record<ConditionKey, string> = { solvent: '溶媒', temp: '温度', time: '時間', yield: '収率' };
const formulaOf = (c: NonNullable<Doc['compounds']>[string]) => {
  const r = analyzeFragment(structureDoc(c), Object.keys(c.structure.atoms));
  return 'formula' in r && r.formula ? r.formula : '?';
};
const shown = (v: unknown) => (v === undefined || v === '' ? '（なし）' : String(v));

/** 前と後のスキームの差を、人が読める一覧にする（何が実際に変わったかを、操作でなく結果から出す） */
export function editChanges(before: Doc, after: Doc, schemeId: string): string[] {
  const a = before.schemes![schemeId];
  const b = after.schemes![schemeId];
  const out: string[] = [];
  if (a.styleId !== b.styleId) out.push(`書式: ${getStyle(a.styleId, before.styles).name} → ${getStyle(b.styleId, after.styles).name}`);
  a.steps.forEach((sa, i) => {
    const sb: Step = b.steps[i];
    const ra = sa.reagents.map(reagentText).join(', ');
    const rb = sb.reagents.map(reagentText).join(', ');
    if (ra !== rb) out.push(`${i + 1} 段目の試薬: ${shown(ra)} → ${shown(rb)}`);
    for (const f of CONDITION_FIELDS) if (sa[f] !== sb[f]) out.push(`${i + 1} 段目の${CONDITION_NAMES[f]}: ${shown(sa[f])} → ${shown(sb[f])}`);
  });
  const nums: string[] = [];
  for (const id of schemeCompounds(a)) {
    const ca = before.compounds![id];
    const cb = after.compounds![id];
    const name = ca.number || ca.nickname || '番号なしの化合物';
    if ((ca.number ?? '') !== (cb.number ?? '')) nums.push(`${shown(ca.number)} → ${shown(cb.number)}`);
    if ((ca.nickname ?? '') !== (cb.nickname ?? '')) out.push(`${name} の呼び名: ${shown(ca.nickname)} → ${shown(cb.nickname)}`);
    if (ca.structure !== cb.structure) {
      const sa = smilesOf(ca);
      const sb = smilesOf(cb);
      if (sa !== sb) out.push(`${name} の構造: ${formulaOf(ca)} → ${formulaOf(cb)}（${sb}）`);
    }
  }
  if (nums.length) out.push(`化合物番号: ${nums.join(', ')}`);
  return out;
}

// ---- まとめて ----

export type TextEditResult = { ok: true; checked: CheckedEdit; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage };

/** LLM に送り、形が崩れていたら1回だけ直させ、指す先を確かめた操作を返す */
export async function textEdit(
  llm: LlmProvider,
  req: { doc: Doc; schemeId: string; text: string; thinking?: ThinkingLevel; signal?: AbortSignal } & EditContext,
): Promise<TextEditResult> {
  const r = await askChecked(
    llm,
    { system: EDIT_SYSTEM_PROMPT, user: editPrompt(req.doc, req.schemeId, req.text, req), schema: EDIT_SCHEMA, thinking: req.thinking, signal: req.signal },
    checkEditShape,
  );
  if (!r.ok) return r;
  // 指示で指したかの確かめには、聞き返しへの答えも含める
  const text = [req.text, ...(req.answers ?? []).map((a) => a.answer)].join('\n');
  return { ok: true, checked: checkEdit(req.doc, req.schemeId, r.value, { text, selected: req.selected }), usage: r.usage };
}

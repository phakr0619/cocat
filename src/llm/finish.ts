// 仕上げの一括の指示
//
// 「ACS の書式に揃えて投稿用に」のように、文書のスキームをまとめて投稿や発表の形に整える。
// 言葉での編集（textEdit.ts）と同じく、LLM には操作の並びだけを返させ、M2 の関数で写しに当て、差の一覧を見せてから確定する。
// 直せるのは見た目と書き方だけで、化学の中身（試薬の足し・外し、収率、構造）は変えない。
// どのスキームを直すか（範囲）は画面で人が選ぶ。LLM には決めさせない

import type { Doc } from '../chem/model';
import type { Scheme } from '../scheme/model';
import { applyStyle, numberSchemesCompounds, setSchemeStyle, updateStep } from '../scheme/ops';
import { STYLE_PRESETS, getStyle, type SchemeStyle } from '../scheme/style';
import { askChecked } from './ask';
import { editChanges } from './textEdit';
import type { JsonSchema, LlmError, LlmProvider, LlmUsage, ThinkingLevel } from './types';

// ---- 範囲 ----

/** 仕上げで直せるスキーム（下書きと固定した図は入れない）を、図の上から下、同じ高さなら左から右に並べる */
export function finishableSchemes(doc: Doc): Scheme[] {
  return Object.values(doc.schemes ?? {})
    .filter((s) => !s.draft && !s.pinned)
    .sort((a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x);
}

/** 範囲のスキームの id（all: 文書のすべて / active: そのスキームだけ） */
export function finishTargets(doc: Doc, scope: 'all' | 'active', activeId: string | null): string[] {
  const all = finishableSchemes(doc).map((s) => s.id);
  if (scope === 'all') return all;
  return activeId && all.includes(activeId) ? [activeId] : [];
}

/** スキームの呼び方（差の一覧と送る内容で同じにする） */
export function schemeLabel(doc: Doc, schemeIds: string[], sid: string): string {
  const t = doc.schemes?.[sid]?.title?.trim();
  return `スキーム ${schemeIds.indexOf(sid) + 1}${t ? `「${t}」` : ''}`;
}

// ---- LLM に返させる形 ----

export const FINISH_OPS = ['set_style', 'set_style_option', 'renumber', 'rename_reagent', 'set_condition'] as const;
/** 書式の項目のうち、仕上げで直せるもの */
export const STYLE_OPTIONS = ['equivFormat', 'yieldFormat', 'yieldPosition', 'conditions', 'stepMarks', 'boldNumber', 'showNickname', 'showNotebook', 'separator'] as const;
export type StyleOption = (typeof STYLE_OPTIONS)[number];
/** 書き方を直せる条件（収率は中身なので入れない。収率の書き方は書式で） */
const FINISH_FIELDS = ['solvent', 'temp', 'time'] as const;
type FinishField = (typeof FINISH_FIELDS)[number];
/** 言葉での編集にはあるが、仕上げでは使わない操作（化学の中身を変える） */
const CONTENT_OPS = ['add_reagent', 'remove_reagent', 'replace_reagent', 'replace_structure', 'set_compound'];

/** 確かめた後の操作。スキームは id、段は 0 から */
export type FinishOp =
  | { op: 'set_style'; styleId: string }
  | { op: 'set_style_option'; option: StyleOption; value: string | boolean }
  | { op: 'renumber'; start: number; prefix: string }
  | { op: 'rename_reagent'; schemeId: string; step: number; index: number; text: string }
  | { op: 'set_condition'; schemeId: string; step: number; field: FinishField; value: string };

const str = { type: 'string' };
export const FINISH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: [...FINISH_OPS] },
          scheme: { type: 'integer', description: 'Scheme number, starting at 1' },
          step: { type: 'integer', description: 'Step number, starting at 1' },
          reagent: { ...str, description: 'The current reagent text' },
          text: { ...str, description: 'The same reagent, written differently' },
          field: { type: 'string', enum: [...FINISH_FIELDS] },
          style: { ...str, description: 'Style id from STYLES' },
          // Gemini は項目をこの順に書くので、value より前に、それを決める field と option を置く（後ろにあると value を書かずに閉じた）
          option: { type: 'string', enum: [...STYLE_OPTIONS] },
          value: { ...str, description: 'New value' },
          start: { type: 'integer' },
          prefix: str,
        },
        required: ['op'],
      },
    },
    cannot: { type: 'array', items: str, description: 'Requests these operations cannot do' },
    questions: { type: 'array', items: str },
  },
  required: ['ops'],
};

export const FINISH_SYSTEM_PROMPT = `You finish reaction schemes for publication or presentation, following a chemist's instruction (Japanese or English).
Change only how the schemes look and how reagents and conditions are written. Never change the chemistry.
Return only JSON with a list of operations that matches the schema.

Operations (use only these):
- set_style: style (an id from STYLES). Applies to every scheme in SCHEMES.
- set_style_option: option and value (always give both). Applies to every scheme in SCHEMES, on top of the chosen style. Use it only for values the chosen style does not already have (see STYLES). Options:
  - equivFormat: how equivalents are written; must contain {n} (for example "{n} equiv", "({n} equiv)", "{n} eq.").
  - yieldFormat: must contain {y} (for example "{y}%", "({y}%)").
  - yieldPosition: below-arrow, after-label or none.
  - conditions: on-arrow (reagents and conditions above and below the arrow) or footnote (step marks on the arrow, conditions in a footnote).
  - stepMarks: alpha (a, b, c), roman (i, ii, iii) or number (1, 2, 3).
  - boldNumber, showNickname, showNotebook: true or false.
  - separator: the text between reagents and conditions, such as ", ".
- renumber: only when the instruction asks to renumber the compounds (naming a journal or a style is not such a request). Renumbers the compounds of all SCHEMES in order of appearance, continuing from one scheme to the next. start (default 1), prefix (default empty).
- rename_reagent: scheme, step, reagent (the current text, as listed), text (the same reagent written differently, for example "TEA" to "Et3N"). Equivalents stay.
- set_condition: scheme, step, field (solvent, temp or time), value (always give it; the same condition written differently, for example "室温" to "rt", "2 時間" to "2 h", "0度" to "0 °C").

Rules:
- Schemes and steps are numbered from 1 as in SCHEMES.
- When the instruction names a journal or publisher (ACS, RSC, Wiley, Elsevier and so on), choose the closest style and set the options and the notation that journal usually uses in schemes. Change only what differs.
- Do not add or remove reagents, do not replace a reagent with a different one, and do not change yields, compound names or structures. If the instruction asks for such a change, return no operation for it and list it in cannot.
- If the instruction (or the rules of the journal it names) asks for something these operations cannot do (fonts, line widths, figure size, colors, compound names, text outside the scheme), list each item briefly in cannot, in the language of the instruction. Do not invent operations.
- If the instruction is unclear, return no operation for it and ask in questions, in the language of the instruction. Leave cannot and questions empty when there are none.`;

// ---- 送る内容 ----

const reagentLine = (r: { text: string; equiv?: number }) => (r.equiv !== undefined ? `${r.text} (${r.equiv} equiv)` : r.text);

/** 選べる書式: プリセット・文書の書式・自分のテンプレート（文書に同じ id があれば文書の方） */
function styleChoices(doc: Doc, myStyles: SchemeStyle[]): SchemeStyle[] {
  const out = [...STYLE_PRESETS, ...Object.values(doc.styles ?? {})];
  for (const m of myStyles) if (!out.some((x) => x.id === m.id)) out.push(m);
  return out;
}

const styleLine = (x: SchemeStyle) =>
  `- id=${x.id}; name=${x.name}; ` + STYLE_OPTIONS.map((k) => `${k}=${k === 'separator' ? JSON.stringify(x[k]) : String(x[k])}`).join('; ');

export interface FinishContext {
  answers?: { question: string; answer: string }[];
  /** ブラウザに保存した自分のテンプレート */
  myStyles?: SchemeStyle[];
}

/** LLM に送る本文（範囲のスキームの段と書式、化合物の番号・呼び名。構造は送らない） */
export function finishPrompt(doc: Doc, schemeIds: string[], text: string, ctx: FinishContext = {}): string {
  const used: string[] = [];
  const schemes = schemeIds.map((sid, n) => {
    const s = doc.schemes![sid];
    const steps = s.steps.map((st, i) => {
      for (const c of [...st.from, ...st.to]) if (!used.includes(c)) used.push(c);
      return [
        `  - step ${i + 1}: from=${st.from.join(',')}; to=${st.to.join(',')}`,
        `reagents=${st.reagents.map(reagentLine).join(' | ')}`,
        `solvent=${st.solvent ?? ''}; temp=${st.temp ?? ''}; time=${st.time ?? ''}; yield=${st.yield ?? ''}`,
      ].join('; ');
    });
    return [`- scheme ${n + 1}${s.title ? ` (${s.title})` : ''}: style=${s.styleId}`, ...steps].join('\n');
  });
  const compounds = used.map((id) => {
    const c = doc.compounds![id];
    return `- key=${id}; number=${c.number ?? ''}; nickname=${c.nickname ?? ''}`;
  });
  const qa = (ctx.answers ?? []).filter((a) => a.answer.trim());
  return [
    'SCHEMES (top to bottom):',
    schemes.join('\n') || '(none)',
    '',
    'COMPOUNDS:',
    compounds.join('\n') || '(none)',
    '',
    'STYLES:',
    styleChoices(doc, ctx.myStyles ?? []).map(styleLine).join('\n'),
    '',
    'INSTRUCTION:',
    text.trim(),
    ...(qa.length ? ['', 'ANSWERS to your earlier questions:', ...qa.map((a) => `- Q: ${a.question}\n  A: ${a.answer.trim()}`)] : []),
  ].join('\n');
}

// ---- 形と指す先の確かめ ----

export interface CheckedFinish {
  ops: FinishOp[];
  /** 使えなかった操作と理由 */
  rejected: string[];
  /** 要確認（当てるが、人が確かめるべきこと） */
  warnings: string[];
  /** この道具ではできないこと（LLM が挙げたもの） */
  cannot: string[];
  questions: string[];
}

type RawFinish = { ops: Record<string, unknown>[]; questions: string[]; cannot: string[] };

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): string | undefined => (isStr(v) && v.trim() ? v.trim() : undefined);
const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase();
const strList = (v: unknown) => (Array.isArray(v) ? v.map(optStr).filter((q): q is string => !!q) : []);

/** 操作ごとに書かなければならない項目（書き落としは形の崩れとして直させる。スキームの番号は、範囲が 1 つなら省けるので入れない） */
const OP_FIELDS: Record<(typeof FINISH_OPS)[number], string[]> = {
  set_style: ['style'],
  set_style_option: ['option', 'value'],
  renumber: [],
  rename_reagent: ['step', 'reagent', 'text'],
  set_condition: ['step', 'field', 'value'],
};

/** JSON の形を確かめる。崩れていれば理由（直させる） */
export function checkFinishShape(raw: unknown): { value: RawFinish } | { error: string } {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { ops?: unknown }).ops)) return { error: 'ops must be an array' };
  const r = raw as { ops: unknown[]; questions?: unknown; cannot?: unknown };
  const ops = r.ops.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object');
  const questions = strList(r.questions);
  const cannot = strList(r.cannot);
  if (!ops.length && !questions.length && !cannot.length) return { error: 'no operations, no cannot and no questions' };
  const missing = ops.flatMap((o, i) => {
    const need = OP_FIELDS[o.op as (typeof FINISH_OPS)[number]] ?? [];
    const lack = need.filter((k) => o[k] === undefined || o[k] === null);
    return lack.length ? [`ops[${i}] (${String(o.op)}) needs ${lack.join(', ')}`] : [];
  });
  if (missing.length) return { error: missing.join('; ') };
  return { value: { ops, questions, cannot } };
}

/** 書式の項目の値を確かめる。決めた形でなければ理由 */
export function styleOptionValue(option: StyleOption, v: unknown): { value: string | boolean } | { error: string } {
  const s = typeof v === 'boolean' ? String(v) : isStr(v) ? v : typeof v === 'number' ? String(v) : '';
  const t = s.trim();
  const oneOf = (xs: string[]) => (xs.includes(t) ? { value: t } : { error: `${xs.join('・')} のどれかにしてください（「${t}」）` });
  switch (option) {
    case 'equivFormat':
      return t.includes('{n}') && t.length <= 20 ? { value: t } : { error: `{n} を含む短い書き方にしてください（「${t}」）` };
    case 'yieldFormat':
      return t.includes('{y}') && t.length <= 20 ? { value: t } : { error: `{y} を含む短い書き方にしてください（「${t}」）` };
    case 'yieldPosition':
      return oneOf(['below-arrow', 'after-label', 'none']);
    case 'conditions':
      return oneOf(['on-arrow', 'footnote']);
    case 'stepMarks':
      return oneOf(['alpha', 'roman', 'number']);
    case 'boldNumber':
    case 'showNickname':
    case 'showNotebook':
      return t === 'true' || t === 'false' ? { value: t === 'true' } : { error: `true か false にしてください（「${t}」）` };
    case 'separator':
      // 区切りは空白を含めてそのまま使う（「, 」）
      return s && s.length <= 5 ? { value: s } : { error: `5 文字までの区切りにしてください（「${s}」）` };
  }
}

/** 操作が指すスキーム・段・試薬・書式があり、値が決めた形かを確かめる。合わないものは理由を付けて外す */
export function checkFinish(doc: Doc, schemeIds: string[], raw: RawFinish, ctx: { myStyles?: SchemeStyle[] } = {}): CheckedFinish {
  const ops: FinishOp[] = [];
  const rejected: string[] = [];
  const warnings: string[] = [];
  const styleIds = new Set(styleChoices(doc, ctx.myStyles ?? []).map((x) => x.id));
  // 書き方を直した後の試薬で探す（同じ試薬を続けて直すとき）
  const reagents = new Map(schemeIds.map((sid) => [sid, doc.schemes![sid].steps.map((st) => st.reagents.map((r) => r.text))]));

  for (const o of raw.ops) {
    const kind = String(o.op ?? '');
    /** スキームと段。スキームが 1 つなら、スキームの番号は無くてよい */
    const where = (): { sid: string; step: number } | null => {
      const n = typeof o.scheme === 'number' ? o.scheme : schemeIds.length === 1 ? 1 : NaN;
      if (!(Number.isInteger(n) && n >= 1 && n <= schemeIds.length)) {
        rejected.push(`${kind}: ${Number.isFinite(n) ? `スキーム ${n}` : 'スキームの指定'}がありません（範囲のスキームは ${schemeIds.length} つ）`);
        return null;
      }
      const sid = schemeIds[n - 1];
      const m = typeof o.step === 'number' ? o.step : NaN;
      const steps = doc.schemes![sid].steps.length;
      if (!(Number.isInteger(m) && m >= 1 && m <= steps)) {
        rejected.push(`${kind}: スキーム ${n} に${Number.isFinite(m) ? ` ${m} 段目` : '段の指定'}がありません（${steps} 段）`);
        return null;
      }
      return { sid, step: m - 1 };
    };
    if (CONTENT_OPS.includes(kind)) {
      rejected.push(`${kind}: 仕上げでは、試薬の足し・外し・入れ替え、収率、構造、呼び名は変えません。直すときは「直す」を使ってください`);
      continue;
    }
    switch (kind) {
      case 'set_style': {
        const id = optStr(o.style);
        if (!id || !styleIds.has(id)) rejected.push(`${kind}: 書式「${id ?? ''}」がありません`);
        else ops.push({ op: kind, styleId: id });
        break;
      }
      case 'set_style_option': {
        const option = STYLE_OPTIONS.find((x) => x === o.option);
        if (!option) {
          rejected.push(`${kind}: 書式の項目「${String(o.option ?? '')}」は直せません`);
          break;
        }
        const v = styleOptionValue(option, o.value);
        if ('error' in v) rejected.push(`${kind}: ${OPTION_NAMES[option]}: ${v.error}`);
        else ops.push({ op: kind, option, value: v.value });
        break;
      }
      case 'renumber': {
        const start = typeof o.start === 'number' && Number.isInteger(o.start) && o.start >= 0 ? o.start : 1;
        const prefix = isStr(o.prefix) ? o.prefix.trim() : '';
        ops.push({ op: kind, start, prefix });
        // 範囲の外のスキームにも出てくる化合物は、そちらの番号も変わる（化合物は文書に 1 つなので）
        const inScope = new Set(schemeIds.flatMap((sid) => doc.schemes![sid].steps.flatMap((st) => [...st.from, ...st.to])));
        const others = Object.values(doc.schemes ?? {}).filter((s) => !schemeIds.includes(s.id));
        // 固定した図は番号も変わらないので、数えない
        const outside = others.filter((s) => !s.pinned && s.steps.some((st) => [...st.from, ...st.to].some((c) => inScope.has(c))));
        if (outside.length) warnings.push(`範囲の外の ${outside.length} つのスキームにも出てくる化合物があり、そちらの番号も変わります`);
        // 範囲の外の化合物の番号と、新しい番号が重なれば知らせる
        const fresh = new Set([...inScope].map((_, i) => `${prefix}${start + i}`));
        const clash = [...new Set(others.flatMap((s) => s.steps.flatMap((st) => [...st.from, ...st.to])))]
          .filter((c) => !inScope.has(c))
          .map((c) => doc.compounds![c].number ?? '')
          .filter((n) => fresh.has(n));
        if (clash.length) warnings.push(`範囲の外の化合物と番号が重なります（${[...new Set(clash)].join(', ')}）。番号を確かめてください`);
        break;
      }
      case 'rename_reagent': {
        const w = where();
        if (!w) break;
        const t = optStr(o.reagent);
        const list = reagents.get(w.sid)![w.step];
        const i = t ? list.findIndex((r) => norm(r) === norm(t) || norm(r) === norm(t.replace(/\s*\(.*equiv.*\)\s*$/i, ''))) : -1;
        const label = schemeLabel(doc, schemeIds, w.sid);
        if (i < 0) rejected.push(`${kind}: ${label} の ${w.step + 1} 段目に試薬「${t ?? ''}」がありません`);
        else if (!optStr(o.text)) rejected.push(`${kind}: 新しい書き方がありません`);
        else {
          ops.push({ op: kind, schemeId: w.sid, step: w.step, index: i, text: optStr(o.text)! });
          list[i] = optStr(o.text)!;
        }
        break;
      }
      case 'set_condition': {
        if (o.field === 'yield') {
          rejected.push(`${kind}: 仕上げでは収率は変えません（収率の書き方は書式で直します）`);
          break;
        }
        const w = where();
        if (!w) break;
        const field = FINISH_FIELDS.find((f) => f === o.field);
        const value = isStr(o.value) ? o.value.trim() : '';
        if (!field) rejected.push(`${kind}: 項目「${String(o.field ?? '')}」は直せません`);
        // 消すのは中身を変えることなので、仕上げではしない
        else if (!value) rejected.push(`${kind}: ${schemeLabel(doc, schemeIds, w.sid)} の ${w.step + 1} 段目の${FIELD_NAMES[field]}を消す指示は、仕上げでは使えません`);
        else {
          ops.push({ op: kind, schemeId: w.sid, step: w.step, field, value });
          // もとが空の項目に書き足すのは、書き方の直しでなく中身を足すこと。当てるが、人に確かめてもらう
          if (!doc.schemes![w.sid].steps[w.step][field]?.trim())
            warnings.push(`${schemeLabel(doc, schemeIds, w.sid)} の ${w.step + 1} 段目の${FIELD_NAMES[field]}はもとは空でした。書き足した「${value}」を確かめてください`);
        }
        break;
      }
      default:
        rejected.push(`知らない操作「${kind}」は使えません`);
    }
  }
  return { ops, rejected, warnings, cannot: raw.cannot, questions: raw.questions };
}

// ---- 当てる ----

/** 写しの書式の id（文書に無く、この当て方の中でも使っていないもの） */
function freshStyleId(doc: Doc, taken: Set<string>): string {
  for (let k = 1; ; k++) {
    const id = `finish-${k}`;
    if (!doc.styles?.[id] && !taken.has(id)) return id;
  }
}

/** 操作を当てた文書を返す（元の文書は変えない）。操作はすべて M2 の関数で行う */
export function applyFinish(doc: Doc, schemeIds: string[], ops: FinishOp[], myStyles: SchemeStyle[] = []): Doc {
  let d = doc;
  let chosen: string | undefined;
  const patch: Partial<SchemeStyle> = {};
  for (const o of ops) {
    switch (o.op) {
      case 'rename_reagent':
        d = updateStep(d, o.schemeId, o.step, { reagents: d.schemes![o.schemeId].steps[o.step].reagents.map((r, i) => (i === o.index ? { ...r, text: o.text } : r)) });
        break;
      case 'set_condition':
        d = updateStep(d, o.schemeId, o.step, { [o.field]: o.value });
        break;
      case 'renumber':
        d = numberSchemesCompounds(d, schemeIds, o.start, o.prefix);
        break;
      case 'set_style':
        chosen = o.styleId;
        break;
      case 'set_style_option':
        (patch as Record<string, unknown>)[o.option] = o.value;
        break;
    }
  }
  if (!chosen && !Object.keys(patch).length) return d;
  // 書式は範囲のスキームに同じに当てる。項目を直すときは元の書式の写しを作り、同じ元からの写しは共有する
  const copies = new Map<string, SchemeStyle>();
  const taken = new Set<string>();
  for (const sid of schemeIds) {
    const baseId = chosen ?? d.schemes![sid].styleId;
    const base = d.styles?.[baseId] ?? STYLE_PRESETS.find((x) => x.id === baseId) ?? myStyles.find((x) => x.id === baseId) ?? getStyle(baseId, d.styles);
    const diff = Object.fromEntries(Object.entries(patch).filter(([k, v]) => base[k as keyof SchemeStyle] !== v));
    if (!Object.keys(diff).length) {
      if (d.styles?.[baseId] || STYLE_PRESETS.some((x) => x.id === baseId)) {
        if (d.schemes![sid].styleId !== baseId) d = setSchemeStyle(d, sid, baseId);
      } else d = applyStyle(d, sid, base);
      continue;
    }
    let copy = copies.get(baseId);
    if (!copy) {
      const id = freshStyleId(d, taken);
      taken.add(id);
      copy = { ...base, ...diff, id, name: `${base.name.replace(/（.*$/, '')}（仕上げ）` };
      copies.set(baseId, copy);
    }
    d = applyStyle(d, sid, copy);
  }
  return d;
}

// ---- 差の一覧 ----

const OPTION_NAMES: Record<StyleOption, string> = {
  equivFormat: '当量の書き方',
  yieldFormat: '収率の書き方',
  yieldPosition: '収率の場所',
  conditions: '条件の置き方',
  stepMarks: '段の記号',
  boldNumber: '番号の太字',
  showNickname: '呼び名を出す',
  showNotebook: 'ノート番号を出す',
  separator: '区切り',
};
const FIELD_NAMES: Record<FinishField, string> = { solvent: '溶媒', temp: '温度', time: '時間' };
const OPTION_VALUES: Record<string, string> = {
  'below-arrow': '矢印の下',
  'after-label': '番号の横',
  none: '書かない',
  'on-arrow': '矢印の上下',
  footnote: '脚注',
  alpha: 'a, b, c',
  roman: 'i, ii, iii',
  number: '1, 2, 3',
  true: 'する',
  false: 'しない',
};
const optionText = (k: StyleOption, v: unknown) => (k === 'separator' ? `「${String(v)}」` : OPTION_VALUES[String(v)] ?? String(v));

export interface FinishChangeGroup {
  /** 「スキーム 1」「文書全体」 */
  title: string;
  changes: string[];
}

/** 前と後の文書の差を、スキームごとの一覧にする（操作でなく結果から出す。番号は文書全体で 1 つ） */
export function finishChanges(before: Doc, after: Doc, schemeIds: string[]): FinishChangeGroup[] {
  const groups: FinishChangeGroup[] = [];
  for (const sid of schemeIds) {
    const a = getStyle(before.schemes![sid].styleId, before.styles);
    const b = getStyle(after.schemes![sid].styleId, after.styles);
    const out: string[] = [];
    if (a.id !== b.id) out.push(`書式: ${a.name} → ${b.name}`);
    for (const k of STYLE_OPTIONS) if (a[k] !== b[k]) out.push(`${OPTION_NAMES[k]}: ${optionText(k, a[k])} → ${optionText(k, b[k])}`);
    // 段の差は言葉での編集と同じ出し方。書式と番号はここで別に出す
    out.push(...editChanges(before, after, sid).filter((l) => !l.startsWith('書式:') && !l.startsWith('化合物番号:')));
    if (out.length) groups.push({ title: schemeLabel(before, schemeIds, sid), changes: out });
  }
  const nums = Object.keys(after.compounds ?? {})
    .filter((id) => (before.compounds?.[id]?.number ?? '') !== (after.compounds![id].number ?? ''))
    .sort((x, y) => (after.compounds![x].number ?? '').localeCompare(after.compounds![y].number ?? '', undefined, { numeric: true }))
    .map((id) => `${before.compounds?.[id]?.number || '（なし）'} → ${after.compounds![id].number || '（なし）'}`);
  if (nums.length) groups.push({ title: '文書全体', changes: [`化合物番号: ${nums.join(', ')}`] });
  return groups;
}

/** 作った後に範囲のスキーム・その化合物・書式が変わっていないかを比べるための鍵 */
export function finishKey(doc: Doc, schemeIds: string[]): string {
  const ids = [...new Set(schemeIds.flatMap((sid) => doc.schemes?.[sid]?.steps.flatMap((st) => [...st.from, ...st.to]) ?? []))];
  return JSON.stringify([schemeIds.map((sid) => doc.schemes?.[sid] ?? null), ids.map((id) => doc.compounds?.[id] ?? null), doc.styles ?? null]);
}

// ---- まとめて ----

export type FinishResult = { ok: true; checked: CheckedFinish; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage };

/** LLM に送り、形が崩れていたら 1 回だけ直させ、指す先と値を確かめた操作を返す */
export async function finishSchemes(
  llm: LlmProvider,
  req: { doc: Doc; schemeIds: string[]; text: string; thinking?: ThinkingLevel; signal?: AbortSignal } & FinishContext,
): Promise<FinishResult> {
  const r = await askChecked(
    llm,
    { system: FINISH_SYSTEM_PROMPT, user: finishPrompt(req.doc, req.schemeIds, req.text, req), schema: FINISH_SCHEMA, thinking: req.thinking, signal: req.signal },
    checkFinishShape,
  );
  if (!r.ok) return r;
  return { ok: true, checked: checkFinish(req.doc, req.schemeIds, r.value, req), usage: r.usage };
}

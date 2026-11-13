// ② 文字 → 事実。
// 本文・SI から集めた文字（pdfText.ts の collectText）を送り、図の化合物番号ごとに、系統名と、段ごとの試薬・溶媒・温度・時間・収率を、
// 出所（ページ）と抜き書き（quote）つきで返させる。画像は送らない（①の画像の読みと独立にして、食い違いをアプリが見つけるため）。
// quote が送った文字の中に無い項目は捨てる（作り話の出所を使わない）
import { askChecked } from './ask';
import type { JsonSchema, LlmProvider, LlmUsage, ThinkingLevel } from './types';

export interface FactReagent {
  text: string;
  equiv?: number;
}

export interface FactCompound {
  label: string;
  /** 文字に書いてある系統名（IUPAC 名など）。番号や略称だけなら空 */
  names: string[];
  page: string;
  quote: string;
}

export interface FactStep {
  /** 生成物の番号 */
  to: string[];
  from: string[];
  reagents: FactReagent[];
  solvent?: string;
  temp?: string;
  time?: string;
  yield?: number | string;
  page: string;
  quote: string;
}

export interface Facts {
  compounds: FactCompound[];
  steps: FactStep[];
}

const str = { type: 'string' };
export const FACTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    compounds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { ...str, description: 'Compound number exactly as in the figure list, e.g. "4", "(R)-4", "S12"' },
          names: { type: 'array', items: str, description: 'Systematic (IUPAC-style) names written for this compound in the text, copied exactly. Empty if none' },
          page: { ...str, description: 'The header label of the excerpt used, e.g. "SI p.12"' },
          quote: { ...str, description: 'Short verbatim excerpt (30-200 characters) from the text that states the name' },
        },
        required: ['label', 'names', 'page', 'quote'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          to: { type: 'array', items: str, description: 'Product numbers of the step, as in the figure list' },
          from: { type: 'array', items: str, description: 'Substrate numbers of the step' },
          reagents: { type: 'array', items: { type: 'object', properties: { text: str, equiv: { type: 'number' } }, required: ['text'] } },
          solvent: str,
          temp: { ...str, description: 'e.g. "rt", "0 °C", "−78 °C to rt", "reflux"' },
          time: { ...str, description: 'e.g. "2 h", "30 min", "overnight"' },
          yield: { type: 'number', description: 'Isolated yield in % of this step' },
          page: { ...str, description: 'The header label of the excerpt used, e.g. "SI p.12"' },
          quote: { ...str, description: 'Short verbatim excerpt (30-200 characters) that states the conditions or the yield' },
        },
        required: ['to', 'from', 'page', 'quote'],
      },
    },
  },
  required: ['compounds', 'steps'],
};

export const FACTS_SYSTEM_PROMPT = `You read excerpts from a chemistry paper and its Supporting Information, and report what the TEXT says about the compounds and steps of one reaction scheme.
Return only JSON that matches the schema.

Rules:
- Use only the given excerpts. Do not use the figure, your own knowledge, or guesses. If something is not written, leave it out.
- compounds: for each compound number in the list, the systematic names written for it in the text (usually the heading of its experimental procedure, e.g. "(R)-Hex-5-en-2-ol ((R)-4)" gives the name "(R)-Hex-5-en-2-ol"). Copy names exactly, without the number. Skip compounds that have no name in the text.
- steps: for each step in the list, the reagents (with equiv when given), solvent, temperature, time and isolated yield that the text states for that step (the procedure that makes the product, or the scheme footnote "Reagents and conditions").
- page: the "source p.N" part of the header of the excerpt you used, e.g. "SI p.12" for the header "[SI p.12 — compound 4]".
- quote: copy 30-200 characters exactly from that excerpt, showing the name or the conditions. Do not paraphrase.
- A superscript in the excerpts is written with "^" (e.g. "15^3" is compound 15 with reference 3; "^1H NMR").
- Numbers written with stereodescriptors, e.g. "(R)-4" and "(S)-4", are different compounds. Match them exactly to the list.`;

/** 送る文: 図の化合物と段の一覧と、集めた文字 */
export function factsPrompt(figure: { compounds: string[]; steps: { from: string[]; to: string[] }[] }, text: string): string {
  return [
    `Compounds in the figure: ${figure.compounds.join(', ')}`,
    'Steps in the figure:',
    ...figure.steps.map((s, i) => `${i + 1}. ${s.from.join(' + ') || '?'} → ${s.to.join(' + ') || '?'}`),
    '',
    'Excerpts:',
    text,
  ].join('\n');
}

/** 比べるときのならし: 空白・上付きの印・引用符・ダッシュの違いを無くし、小文字にする */
export function looseText(s: string): string {
  return s
    .replace(/\^/g, '')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[’′‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 抜き書きが、送った文字の中に本当にあるか（短すぎるものは出所にならない） */
export function quoteFound(quote: string, sent: string): boolean {
  const q = looseText(quote);
  return q.length >= 12 && looseText(sent).includes(q);
}

const asStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 答えの形を確かめる。抜き書きが送った文字に無い項目、一覧に無い番号の項目は捨て、捨てた数を返す */
export function checkFacts(raw: unknown, sent: string, figureLabels: readonly string[]): { value: Facts; dropped: number } | { error: string } {
  const r = raw as { compounds?: unknown; steps?: unknown };
  if (!r || typeof r !== 'object' || !Array.isArray(r.compounds) || !Array.isArray(r.steps)) return { error: 'compounds と steps の配列が必要です' };
  const known = new Set(figureLabels);
  let dropped = 0;
  const compounds: FactCompound[] = [];
  for (const c of r.compounds as Record<string, unknown>[]) {
    const label = asStr(c?.label);
    const quote = asStr(c?.quote) ?? '';
    const names = Array.isArray(c?.names) ? (c.names as unknown[]).map(asStr).filter((x): x is string => !!x) : [];
    if (!label || !names.length) continue;
    if (!known.has(label) || !quoteFound(quote, sent)) {
      dropped++;
      continue;
    }
    // 名前そのものも送った文字にあること（AI が名前を作らないように）
    const real = names.filter((n) => looseText(sent).includes(looseText(n)));
    if (!real.length) {
      dropped++;
      continue;
    }
    compounds.push({ label, names: real, page: asStr(c.page) ?? '', quote });
  }
  const steps: FactStep[] = [];
  for (const s of r.steps as Record<string, unknown>[]) {
    const to = Array.isArray(s?.to) ? (s.to as unknown[]).map(asStr).filter((x): x is string => !!x) : [];
    const from = Array.isArray(s?.from) ? (s.from as unknown[]).map(asStr).filter((x): x is string => !!x) : [];
    const quote = asStr(s?.quote) ?? '';
    if (!to.length) continue;
    if (!to.every((x) => known.has(x)) || !quoteFound(quote, sent)) {
      dropped++;
      continue;
    }
    const reagents = Array.isArray(s.reagents)
      ? (s.reagents as Record<string, unknown>[]).flatMap((x) => {
          const text = asStr(x?.text);
          return text ? [{ text, ...(typeof x.equiv === 'number' && x.equiv > 0 ? { equiv: x.equiv } : {}) }] : [];
        })
      : [];
    const y = typeof s.yield === 'number' && s.yield > 0 && s.yield <= 100 ? s.yield : asStr(s.yield);
    steps.push({ to, from, reagents, solvent: asStr(s.solvent), temp: asStr(s.temp), time: asStr(s.time), ...(y !== undefined ? { yield: y } : {}), page: asStr(s.page) ?? '', quote });
  }
  return { value: { compounds, steps }, dropped };
}

export type TextFactsResult = { ok: true; facts: Facts; dropped: number; usage?: LlmUsage } | { ok: false; error: import('./types').LlmError; usage?: LlmUsage };

/** ②を呼ぶ。形が崩れていたら 1 回だけ直させる */
export async function textFacts(
  llm: LlmProvider,
  req: { figure: { compounds: string[]; steps: { from: string[]; to: string[] }[] }; text: string; thinking?: ThinkingLevel; signal?: AbortSignal },
): Promise<TextFactsResult> {
  let dropped = 0;
  const r = await askChecked(
    llm,
    { system: FACTS_SYSTEM_PROMPT, user: factsPrompt(req.figure, req.text), schema: FACTS_SCHEMA, thinking: req.thinking, signal: req.signal },
    (raw) => {
      const c = checkFacts(raw, req.text, req.figure.compounds);
      if ('error' in c) return c;
      dropped = c.dropped;
      return { value: c.value };
    },
  );
  if (!r.ok) return r;
  return { ok: true, facts: r.value, dropped, usage: r.usage };
}

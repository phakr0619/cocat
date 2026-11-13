// スキームから文章と表を作る
//
// 数字（分子量・mmol・量・当量・収率・番号・条件）は LLM に作らせない。アプリの化学量論表と RDKit で出し、
// LLM には {{s1.R1.mg}} のような差し込みの印の入った文の組み立てだけを任せる。
// 返ってきた文は、知らない印・値の無い印・印でない数字・出てこない化合物や試薬・量の取り違えを確かめ、合わなければ要確認にする。
// 化学量論表は LLM を呼ばずにアプリだけで作る

import type { Doc } from '../chem/model';
import { emptyDoc } from '../chem/model';
import { analyzeFragment } from '../chem/analysis';
import { compoundName, formatNumber as fmt, stoichMarkdown, stoichTable, stoichTsv, type StoichRow } from '../scheme/stoich';
import { askChecked } from './ask';
import type { JsonSchema, LlmError, LlmProvider, LlmUsage, ThinkingLevel } from './types';

// ---- 差し込みの一覧 ----

/** name: 化合物・試薬の名前 / quantity: 量・当量・分子量 / condition: 溶媒・温度・時間・収率 / info: 分子式 */
export type FactKind = 'name' | 'quantity' | 'condition' | 'info';
export interface WriteFact {
  key: string;
  /** 単位を付けた値。無ければ null（why に理由） */
  value: string | null;
  why?: string;
  kind: FactKind;
  /** 量のときは、それが属する名前の印（C1・s1.R1） */
  entity?: string;
  /** 一覧に出す説明（「1 段目の HATU の mg」） */
  label: string;
}
export interface WriteFacts {
  facts: Map<string, WriteFact>;
  /** 名前の印 → そのまま書いてもよい書き方（呼び名など。数字だけの番号は含めない） */
  literals: Map<string, string[]>;
  /** 段ごとに、文章に出てくるべき名前の印と、化学量論表の行の順の名前の印 */
  steps: { title: string; entities: string[]; rows: { entity: string; kind: StoichRow['kind']; name: string }[] }[];
}

const QTY_UNITS: Record<string, string> = { mg: 'mg', mmol: 'mmol', equiv: 'equiv', uL: 'µL', mw: '' };

function compoundInfo(doc: Doc, id: string): { formula?: string; mw?: number } {
  const c = doc.compounds?.[id];
  if (!c || !Object.keys(c.structure.atoms).length) return {};
  const d = { ...emptyDoc(), atoms: c.structure.atoms, bonds: c.structure.bonds, groups: c.structure.groups };
  const r = analyzeFragment(d, Object.keys(d.atoms));
  return 'error' in r ? {} : { formula: r.formula, mw: r.mw };
}

/** 当量は末尾の 0 を落とす（1.20 → 1.2） */
const equivText = (v: number) => `${String(Number(v.toFixed(2)))} equiv`;
const mmolText = (v: number) => `${v.toFixed(v < 0.1 ? 3 : 2)} mmol`;
const yieldValue = (y: number | string | undefined): number | undefined => {
  if (typeof y === 'number') return y;
  const m = typeof y === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(y) : null;
  return m ? Number(m[1]) : undefined;
};
/** 名前としてそのまま書いてよいか（「3」「12a」のような番号は、ほかの数字と見分けられないので印で書かせる） */
const literalName = (s: string | undefined): s is string => !!s && s.trim().length >= 3 && /[A-Za-z぀-鿿]/.test(s);

/** スキームから、差し込みの印と値の一覧を作る */
export function writeFacts(doc: Doc, schemeId: string): WriteFacts {
  const scheme = doc.schemes?.[schemeId];
  const facts = new Map<string, WriteFact>();
  const literals = new Map<string, string[]>();
  const steps: WriteFacts['steps'] = [];
  if (!scheme) return { facts, literals, steps };
  const set = (f: WriteFact) => facts.set(f.key, f);

  const cKey = new Map<string, string>();
  for (const st of scheme.steps) for (const id of [...st.from, ...st.to]) if (!cKey.has(id)) cKey.set(id, `C${cKey.size + 1}`);
  const nameOf = (id: string) => compoundName(doc, id, cKey.get(id)!);
  for (const [id, k] of cKey) {
    const c = doc.compounds?.[id];
    const label = c?.number?.trim() || c?.nickname?.trim() || null;
    const info = compoundInfo(doc, id);
    set({ key: k, value: label, why: label ? undefined : '番号も呼び名もありません', kind: 'name', label: `${k} の名前` });
    set({ key: `${k}.formula`, value: info.formula ?? null, why: info.formula ? undefined : '構造がありません', kind: 'info', entity: k, label: `${nameOf(id)} の分子式` });
    set({ key: `${k}.mw`, value: info.mw ? fmt(info.mw, 2) : null, why: info.mw ? undefined : '構造がありません', kind: 'quantity', entity: k, label: `${nameOf(id)} の分子量` });
    literals.set(k, [c?.nickname, c?.number].filter(literalName).map((s) => s.trim()));
  }

  scheme.steps.forEach((st, i) => {
    const n = i + 1;
    const p = `s${n}`;
    const rows = stoichTable(doc, st);
    const noBase = !st.scale || !(st.scale.value > 0) ? '最初の基質の量が入っていません（化学量論表で入れてください）' : '最初の基質の分子量が分からないので、量を出せません';
    const stepName = `${n} 段目`;
    const y = yieldValue(st.yield);
    const entities: string[] = [];
    const order: WriteFacts['steps'][number]['rows'] = [];
    for (const r of rows) {
      const ent = r.kind === 'reagent' ? `${p}.R${(r.ref as number) + 1}` : cKey.get(r.ref as string)!;
      entities.push(ent);
      order.push({ entity: ent, kind: r.kind, name: r.name });
      const who = `${stepName}の ${r.name}`;
      if (r.kind === 'reagent') {
        set({ key: ent, value: r.name.trim() || null, why: '試薬の書き方が空です', kind: 'name', label: `${stepName}の試薬 ${(r.ref as number) + 1}` });
        literals.set(ent, [r.name.trim()].filter((s) => s.length >= 2));
      }
      const q = (field: string, v: number | undefined, text: (v: number) => string, why: string) =>
        set({ key: r.kind === 'reagent' ? `${ent}.${field}` : `${p}.${ent}.${field}`, value: v !== undefined && isFinite(v) ? text(v) : null, why: v !== undefined && isFinite(v) ? undefined : why, kind: 'quantity', entity: ent, label: `${who} の ${QTY_UNITS[field] || field}` });
      if (r.kind === 'product') {
        const mmol = r.mmol !== undefined && y !== undefined ? (r.mmol * y) / 100 : undefined;
        const why = r.mmol === undefined ? noBase : '収率が数でないので、得た量を出せません';
        q('mmol', mmol, mmolText, why);
        q('mg', mmol !== undefined && r.mw ? mmol * r.mw : undefined, (v) => `${fmt(v, 1)} mg`, r.mw ? why : '分子量が分かりません');
        continue;
      }
      q('equiv', r.equiv, equivText, '当量がありません');
      const qWhy = r.equiv === undefined ? '当量がありません' : noBase;
      q('mmol', r.mmol, mmolText, qWhy);
      q('mg', r.mg, (v) => `${fmt(v, 1)} mg`, r.mmol === undefined ? qWhy : '分子量が分かりません（化学量論表で入れてください）');
      if (r.kind === 'reagent') q('uL', r.uL, (v) => `${fmt(v, 1)} µL`, r.mg === undefined ? (r.mmol === undefined ? qWhy : '分子量が分かりません（化学量論表で入れてください）') : '密度がありません（液体なら化学量論表で入れてください）');
    }
    const cond = (field: 'solvent' | 'temp' | 'time', v: string | undefined) =>
      set({ key: `${p}.${field}`, value: v?.trim() || null, why: 'スキームに書いてありません', kind: 'condition', label: `${stepName}の${{ solvent: '溶媒', temp: '温度', time: '時間' }[field]}` });
    cond('solvent', st.solvent);
    cond('temp', st.temp);
    cond('time', st.time);
    set({
      key: `${p}.yield`,
      value: y !== undefined ? `${String(y)}%` : typeof st.yield === 'string' && st.yield.trim() ? st.yield.trim() : null,
      why: 'スキームに書いてありません',
      kind: 'condition',
      label: `${stepName}の収率`,
    });
    steps.push({ title: `${st.from.map(nameOf).join(' + ')} → ${st.to.map(nameOf).join(' + ')}`, entities: [...new Set(entities)], rows: order });
  });
  return { facts, literals, steps };
}

// ---- LLM に返させる形と指示 ----

export type WriteLanguage = 'en' | 'ja';
export const WRITEUP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The procedure with {{placeholders}}. One paragraph per step, separated by a blank line' },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['text'],
};

export const WRITEUP_SYSTEM_PROMPT = `You write the experimental procedure (Experimental section) for a reaction scheme. A chemist checks it and pastes it into a paper or a lab notebook.
Return only JSON that matches the schema: text (the procedure) and questions.

Rules:
- Never type numbers yourself. Every quantity, equivalent, molecular weight, yield, compound number, temperature and time comes from PLACEHOLDERS: write {{key}} exactly as listed, and the app fills in the value with its unit. Do not write a unit after a placeholder.
- Refer to compounds and reagents with their placeholders ({{C1}}, {{s1.R1}}). Do not write IUPAC names, SMILES or formulas of your own.
- Put quantities right after the name they belong to, for example {{s1.R1}} ({{s1.R1.mg}}, {{s1.R1.mmol}}, {{s1.R1.equiv}}). For a liquid reagent that has a .uL value, you may give the volume instead of the mass.
- If a value is "(not available)", still write its placeholder; the app marks it for the chemist.
- Use only the facts in PLACEHOLDERS and INSTRUCTION. Do not invent work-up, purification, appearance, analytical data, atmosphere or apparatus. Where such a sentence is normally needed and INSTRUCTION does not give it, write a short note in double square brackets, for example [[work-up]] or [[purification]], for the chemist to fill in. Numbers in INSTRUCTION may be copied as written.
- INSTRUCTION may be dictated or casual Japanese lab speech. Write it in the standard terms of an experimental section, for example 重曹水 = saturated aqueous NaHCO3, 芒硝 or 硫酸ナトリウム = Na2SO4, 硫マグ = MgSO4, 食塩水 or ブライン = brine, ヘキサク or ヘキ酢 = hexane/EtOAc, 酢エチ = EtOAc, ジクロロ or 塩メチ = CH2Cl2, 濃縮 or エバポ = concentrated under reduced pressure, カラム = silica gel column chromatography, 3対1 or 三対一 = 3:1. Do not add steps that INSTRUCTION does not say.
- Write one paragraph per step, in step order, separated by a blank line. Mention every substrate, reagent and product of each step.
- Write in LANGUAGE, in the usual style of experimental sections (past tense, passive voice in English). Follow INSTRUCTION for style if given.
- If the instruction cannot be followed with these facts, say so in questions.`;

const LANGUAGE_NAME: Record<WriteLanguage, string> = { en: 'English', ja: 'Japanese' };

/** 送る本文: 言語・指示・段ごとの差し込みの一覧（「送る内容を見る」でそのまま見せる） */
export function writeUpPrompt(facts: WriteFacts, text: string, language: WriteLanguage): string {
  const lines = [`LANGUAGE: ${LANGUAGE_NAME[language]}`, `INSTRUCTION: ${text.trim() || '(none)'}`, '', 'PLACEHOLDERS:'];
  const show = (k: string, role?: string) => {
    const f = facts.facts.get(k);
    if (f) lines.push(`  {{${k}}} = ${f.value ?? '(not available)'}${role ? `  [${role}]` : ''}`);
  };
  facts.steps.forEach((st, i) => {
    const p = `s${i + 1}`;
    lines.push(`Step ${i + 1}: ${st.title}`);
    for (const e of st.entities) {
      const isReagent = e.startsWith(`${p}.R`);
      const isProduct = !isReagent && facts.facts.has(`${p}.${e}.mmol`) && !facts.facts.has(`${p}.${e}.equiv`);
      show(e, isReagent ? 'reagent' : isProduct ? 'product' : 'substrate');
      if (!isReagent) {
        show(`${e}.formula`);
        show(`${e}.mw`);
      }
      for (const f of isProduct ? ['mg', 'mmol'] : ['equiv', 'mmol', 'mg', 'uL']) show(isReagent ? `${e}.${f}` : `${p}.${e}.${f}`);
    }
    for (const f of ['solvent', 'temp', 'time', 'yield']) show(`${p}.${f}`);
  });
  return lines.join('\n');
}

export interface RawWriteUp {
  text: string;
  questions: string[];
}

export function checkWriteUpShape(raw: unknown): { value: RawWriteUp } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'the answer is not an object' };
  const o = raw as { text?: unknown; questions?: unknown };
  if (typeof o.text !== 'string' || !o.text.trim()) return { error: '"text" must be a non-empty string' };
  const questions = Array.isArray(o.questions) ? o.questions.filter((q): q is string => typeof q === 'string' && !!q.trim()) : [];
  return { value: { text: o.text, questions } };
}

// ---- 差し込みと確かめ ----

/** unknown: 知らない印 / missing: 値の無い印 / number: 印でない数字 / mention: 出てこない化合物・試薬 / pair: 量の取り違え */
export interface WriteIssue {
  kind: 'unknown' | 'missing' | 'number' | 'mention' | 'pair';
  message: string;
}
export interface CheckedWriteUp {
  /** 差し込みの印の入った文（数字を入れ直すときに使う） */
  template: string;
  /** 値を差し込んだ文 */
  text: string;
  issues: WriteIssue[];
  /** [[…]] の書き足す所 */
  todos: string[];
  questions: string[];
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** 数字のかたまり（「1.2」「3:1」「2/3」） */
const NUMBER = /\d+(?:[.,:/]\d+)*/g;
/** 段の番号（「Step 1」「1 段目」「第 2 段」）は数字として数えない */
const STEP_NUMBER = /\b[Ss]tep\s*\d+|\d+\s*段目|第\s*\d+\s*段/g;
/** 文の終わり。「equiv.」「e.g.」などの略の点では切らない。日本語の句点は後ろに空白が無くても切る */
const SENTENCE_END = /[。！？]|(?<!\d|\b(?:equiv|e\.g|i\.e|vs|approx|aq|sat|ca|cf))[.!?](?=\s|$)|\n/g;
/** {{ }} を付け忘れた印（「s1.R1.mg」「{s1.R1.mg}」「C2」） */
const BARE_KEY = /(?<![A-Za-z0-9.])\{?(?:s\d+\.(?:R\d+|C\d+)(?:\.\w+)?|s\d+\.(?:solvent|temp|time|yield)|C\d+(?:\.(?:formula|mw))?)\}?(?![A-Za-z0-9])/g;
/** 数字で書かない量（「two hours」「overnight」「二時間」）。値は差し込みで書かせる */
const NUMBER_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|twelve|twice|overnight)\b|[一二三四五六七八九十]+\s*(?:時間|分|日|当量|回)|一晩|一夜/gi;

/** 名前の印か（C1・s1.R1）。量の印なら、属する名前の印を返す */
function entityOf(key: string): { entity: string; isName: boolean } | null {
  let m = /^(C\d+)(?:\.(formula|mw))?$/.exec(key);
  if (m) return { entity: m[1], isName: !m[2] };
  m = /^(s\d+)\.(C\d+)\.\w+$/.exec(key);
  if (m) return { entity: m[2], isName: false };
  m = /^(s\d+\.R\d+)(?:\.\w+)?$/.exec(key);
  if (m) return { entity: m[1], isName: key === m[1] };
  return null;
}

/** 漢数字（「三」「十二」）を算用数字にする。音声入力の指示の数字を拾うため */
const KANJI_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNumber(s: string): string {
  let total = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch === '十' || ch === '百') {
      total += (digit || 1) * (ch === '十' ? 10 : 100);
      digit = 0;
    } else digit = digit * 10 + KANJI_DIGIT[ch];
  }
  return String(total + digit);
}
/** 指示にある数字（全角・漢数字・「3対1」も拾う） */
function givenNumbers(instruction: string): Set<string> {
  const s = instruction
    .normalize('NFKC')
    .replace(/[〇零一二三四五六七八九十百]+/g, kanjiNumber)
    .replace(/(\d)\s*対\s*(\d)/g, '$1:$2');
  return new Set(s.match(NUMBER) ?? []);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 印に値を差し込み、確かめる。instruction は利用者の指示の文（そこにある数字は書いてよい） */
export function fillWriteUp(facts: WriteFacts, raw: RawWriteUp, instruction = ''): CheckedWriteUp {
  const template = raw.text.replace(/\r\n/g, '\n').trim();
  const issues: WriteIssue[] = [];
  const add = (i: WriteIssue) => {
    if (!issues.some((x) => x.message === i.message)) issues.push(i);
  };

  // 差し込む。単位を印の後ろに重ねて書いていたら 1 つにする
  let text = template.replace(PLACEHOLDER, (_m, key: string) => {
    const f = facts.facts.get(key);
    if (!f) {
      add({ kind: 'unknown', message: `知らない差し込みの印 {{${key}}} があります` });
      return `{{${key}}}`;
    }
    if (f.value === null) {
      add({ kind: 'missing', message: `${f.label}: ${f.why}` });
      return '[?]';
    }
    return f.value;
  });
  text = text.replace(/(\d) ?(mg|mmol|equiv|µL|°C|h|min)\s+\2(?![A-Za-z])/g, '$1 $2').replace(/%\s*%/g, '%');

  // 印でない数字。名前・条件の書き方そのもの・指示にある数字・化学式の添字・段の番号は数えない
  // 書き足す所（[[1H NMR]]）は数えない。全角の数字は半角にして数える
  // 段落が段の数と同じなら、条件の書き方（「2 h」）はその段の段落でだけ書いてよい
  const literal = (f: WriteFact) => (f.kind === 'name' || f.kind === 'condition') && !!f.value && /\d/.test(f.value) && /[A-Za-z°぀-鿿]/.test(f.value);
  const longFirst = (a: string, b: string) => b.length - a.length;
  const given = givenNumbers(instruction);
  const paragraphs = template.split(/\n\s*\n/);
  const perStep = paragraphs.length > 1 && paragraphs.length === facts.steps.length;
  paragraphs.forEach((para, i) => {
    let bare = para.replace(PLACEHOLDER, ' ').replace(/\[\[[^\]]*\]\]/g, ' ').normalize('NFKC');
    for (const m of bare.matchAll(BARE_KEY)) add({ kind: 'unknown', message: `「${m[0]}」は {{ }} の無い差し込みの印です。値が差し込まれていません` });
    bare = bare.replace(BARE_KEY, ' ').replace(STEP_NUMBER, ' ');
    for (const m of bare.matchAll(NUMBER_WORDS)) add({ kind: 'number', message: `「${m[0]}」は、スキームの値から差し込んでいない量です。値が合っているか確かめてください` });
    const own = (f: WriteFact) => !perStep || f.kind === 'name' || f.key.startsWith(`s${i + 1}.`);
    const lits = [...facts.facts.values()].filter(literal);
    for (const s of [...new Set(lits.filter(own).map((f) => f.value!))].sort(longFirst)) bare = bare.replace(new RegExp(escapeRe(s), 'g'), ' ');
    for (const f of lits.filter((f) => !own(f)).sort((a, b) => longFirst(a.value!, b.value!))) {
      const re = new RegExp(escapeRe(f.value!), 'g');
      if (re.test(bare)) add({ kind: 'number', message: `${i + 1} 段目の段落にある「${f.value}」は、${f.label}です。この段の値か確かめてください` });
      bare = bare.replace(re, ' ');
    }
    for (const m of bare.matchAll(NUMBER)) {
      const before = bare[m.index! - 1] ?? '';
      if (/[A-Za-z)\]]/.test(before)) continue; // Na2SO4・(PPh3)4 の添字
      if (given.has(m[0]) || m[0].split(/[:/]/).every((n) => given.has(n))) continue;
      add({ kind: 'number', message: `「${m[0]}」は、スキームの値から差し込んでいない数字です。値が合っているか確かめてください` });
    }
  });

  // 名前の出どころ（印か、そのまま書いた呼び名）
  const mentions: { at: number; end: number; entity: string }[] = [];
  const quantities: { at: number; entity: string; key: string }[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const e = entityOf(m[1]);
    if (!e || !facts.facts.has(m[1])) continue;
    if (e.isName) mentions.push({ at: m.index!, end: m.index! + m[0].length, entity: e.entity });
    else if (facts.facts.get(m[1])!.kind === 'quantity') quantities.push({ at: m.index!, entity: e.entity, key: m[1] });
  }
  // 量の印だけで名前の無いもの（「…（456.3 mg）を加えた」）は、出てきたと数えない
  const named = new Set(mentions.map((m) => m.entity));
  for (const [entity, names] of facts.literals)
    for (const name of names)
      for (const m of template.matchAll(new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'g'))) {
        mentions.push({ at: m.index!, end: m.index! + m[0].length, entity });
        named.add(entity);
      }
  mentions.sort((a, b) => a.at - b.at);

  // 段の基質・試薬・生成物がすべて出てくるか
  facts.steps.forEach((st, i) => {
    for (const e of st.entities) if (!named.has(e)) add({ kind: 'mention', message: `${i + 1} 段目の ${facts.facts.get(e)?.value ?? e} が文章にありません` });
  });

  // 量が、同じ文の中で直前（無ければ直後）にある名前のものか
  const ends = [0, ...[...template.matchAll(SENTENCE_END)].map((m) => m.index! + 1), template.length + 1];
  const sentenceOf = (at: number) => ends.findIndex((e, k) => k > 0 && at < e);
  // 名前を並べてから同じ順で量を並べた書き方（「A と B（x mg と y mg）」「A and B (x and y mg, respectively)」）は、並べた順で合っていればよい
  const listed = new Set<(typeof quantities)[number]>();
  const tokens = [...mentions.map((m) => ({ at: m.at, entity: m.entity, q: null })), ...quantities.map((q) => ({ at: q.at, entity: q.entity, q }))].sort((a, b) => a.at - b.at);
  const order = (run: typeof tokens) => run.map((t) => t.entity).filter((e, k, a) => k === 0 || a[k - 1] !== e);
  for (let k = 0; k < tokens.length; ) {
    let m = k;
    while (m < tokens.length && !tokens[m].q && sentenceOf(tokens[m].at) === sentenceOf(tokens[k].at)) m++;
    let n = m;
    while (n < tokens.length && tokens[n].q && sentenceOf(tokens[n].at) === sentenceOf(tokens[k].at)) n++;
    const names = order(tokens.slice(k, m));
    if (names.length > 1 && order(tokens.slice(m, n)).join() === names.join()) for (const t of tokens.slice(m, n)) listed.add(t.q!);
    k = n > k ? n : k + 1;
  }
  for (const q of quantities) {
    if (listed.has(q)) continue;
    const sn = sentenceOf(q.at);
    const before = mentions.filter((m) => m.end <= q.at && sentenceOf(m.at) === sn).at(-1);
    const near = before ?? mentions.find((m) => m.at > q.at && sentenceOf(m.at) === sn);
    if (near && near.entity !== q.entity) {
      const f = facts.facts.get(q.key)!;
      add({ kind: 'pair', message: `${facts.facts.get(near.entity)?.value ?? near.entity} の所に、${f.label}（${f.value ?? '?'}）が書かれています。取り違えていないか確かめてください` });
    }
  }

  const todos = [...template.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
  return { template, text, issues, todos, questions: raw.questions };
}

// ---- まとめて ----

export type WriteUpResult = { ok: true; checked: CheckedWriteUp; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage };

/** 実験項の文章を書かせ、差し込んで確かめる */
export async function writeUp(
  llm: LlmProvider,
  req: { doc: Doc; schemeId: string; text: string; language: WriteLanguage; thinking?: ThinkingLevel; signal?: AbortSignal },
): Promise<WriteUpResult> {
  const facts = writeFacts(req.doc, req.schemeId);
  const r = await askChecked(
    llm,
    { system: WRITEUP_SYSTEM_PROMPT, user: writeUpPrompt(facts, req.text, req.language), schema: WRITEUP_SCHEMA, thinking: req.thinking, signal: req.signal },
    checkWriteUpShape,
  );
  if (!r.ok) return r;
  return { ok: true, checked: fillWriteUp(facts, r.value, req.text), usage: r.usage };
}

/** 覚えている印の入った文に、今のスキームの値を差し込み直す（LLM は呼ばない） */
export function refillWriteUp(doc: Doc, schemeId: string, prev: CheckedWriteUp, instruction = ''): CheckedWriteUp {
  return fillWriteUp(writeFacts(doc, schemeId), { text: prev.template, questions: prev.questions }, instruction);
}

/** スキームの全段の化学量論表（LLM は呼ばない）。markdown は見出しつき、tsv は Excel に貼れる形 */
export function schemeStoichTables(doc: Doc, schemeId: string): { markdown: string; tsv: string } {
  const scheme = doc.schemes?.[schemeId];
  if (!scheme) return { markdown: '', tsv: '' };
  const facts = writeFacts(doc, schemeId);
  const md: string[] = [];
  const tsv: string[] = [];
  scheme.steps.forEach((st, i) => {
    const rows = stoichTable(doc, st);
    const title = `${i + 1} 段目: ${facts.steps[i].title}`;
    const cond = [st.solvent, st.temp, st.time].filter((x) => x?.trim()).join(', ');
    md.push(`### ${title}`, '', stoichMarkdown(rows), '');
    if (cond) md.push(`条件: ${cond}`, '');
    tsv.push(title, stoichTsv(rows), '');
  });
  return { markdown: md.join('\n').trim(), tsv: tsv.join('\n').trim() };
}

/**
 * 実験ノート用の図（LLM は呼ばない）: 容器に足していくものを、化学量論表の行の順（基質 → 試薬）に縦に並べる
 * スキームには足した順が無いので、順は手で直してもらう
 */
export function schemeNotebook(doc: Doc, schemeId: string): string {
  const scheme = doc.schemes?.[schemeId];
  if (!scheme) return '';
  const { facts, steps } = writeFacts(doc, schemeId);
  const v = (k: string) => facts.get(k)?.value ?? '[?]';
  const out: string[] = [];
  scheme.steps.forEach((st, i) => {
    const p = `s${i + 1}`;
    const solvent = st.solvent?.trim();
    out.push(`${i + 1} 段目: ${steps[i].title}`, solvent ? `容器（${solvent}）` : '容器', '｜');
    for (const r of steps[i].rows.filter((r) => r.kind !== 'product')) {
      const k = r.kind === 'reagent' ? r.entity : `${p}.${r.entity}`;
      out.push(`｜← ${r.name}  ${facts.get(`${k}.uL`)?.value ?? v(`${k}.mg`)}（${v(`${k}.mmol`)}, ${v(`${k}.equiv`)}）`);
    }
    const cond = [st.temp, st.time].filter((x) => x?.trim()).join(', ');
    if (cond) out.push(`｜  ${cond}`);
    out.push('↓', '（後処理・精製）');
    for (const r of steps[i].rows.filter((r) => r.kind === 'product')) {
      const y = facts.get(`${p}.yield`)?.value;
      out.push(`${r.name}  ${v(`${p}.${r.entity}.mg`)}（${v(`${p}.${r.entity}.mmol`)}${y ? `, ${y}` : ''}）`);
    }
    out.push('');
  });
  return out.join('\n').trim();
}

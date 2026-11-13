// 言葉からスキーム（M3-2）
//
// 文章 → LLM に決まった形の JSON を返させる（座標は描かせない）→ 形・構造（RDKit）・元素のつじつまを確かめる
// → M2 のスキームのデータにして、下書き（scheme.draft）として描く。確定するまで draft が付いたまま

import type { Doc } from '../chem/model';
import { edit, emptyDoc, newId } from '../chem/model';
import { getRDKit } from '../chem/rdkit';
import { isElement } from '../chem/elements';
import { addSmiles } from '../io/smiles';
import { identify } from '../project/library';
import type { LibraryCompound } from '../project/model';
import { renderScheme } from '../scheme/layout';
import type { DraftIssue, Reagent, Step, Structure } from '../scheme/model';
import { structureFrom } from '../scheme/model';
import { askChecked } from './ask';
import { missingAnchors } from './skeleton';
import type { JsonSchema, LlmImage, LlmProvider, LlmUsage, ThinkingLevel } from './types';

// ---- LLM に返させる形 ----

export interface PlanCompound {
  /** LLM が付ける仮の名前（A, B, C…） */
  ref: string;
  name?: string;
  smiles?: string | null;
  /** 今のスキーム・ライブラリの化合物を指すときの key */
  existing?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  /** 画像から読んだ立体中心の CIP（「S」「R,S」）。SMILES の書き違いを見つけるのに使う */
  cip?: string;
}
export interface PlanReagent {
  text: string;
  equiv?: number | null;
  smiles?: string | null;
}
export interface PlanStep {
  from: string[];
  to: string[];
  reagents?: PlanReagent[];
  solvent?: string | null;
  temp?: string | null;
  time?: string | null;
  yield?: number | string | null;
}
export interface Plan {
  compounds: PlanCompound[];
  steps: PlanStep[];
  questions?: string[];
}

const str = { type: 'string' };
export const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    compounds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { ...str, description: 'Short id such as A, B, C' },
          name: { ...str, description: 'Name, number or label as written in the text' },
          smiles: { ...str, description: 'SMILES. Omit when the structure is not certain' },
          existing: { ...str, description: 'Key of an EXISTING compound this refers to' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          cip: { ...str, description: 'CIP descriptors (R/S) of the stereocenters as drawn in the image, e.g. "S" or "R,S". Omit when there are none' },
        },
        required: ['ref'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'array', items: str, description: 'refs of substrates' },
          to: { type: 'array', items: str, description: 'refs of products' },
          reagents: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: str, equiv: { type: 'number' }, smiles: str },
              required: ['text'],
            },
          },
          solvent: str,
          temp: str,
          time: str,
          yield: { type: 'number', description: 'Isolated yield in %' },
        },
        required: ['from', 'to'],
      },
    },
    questions: { type: 'array', items: str },
  },
  required: ['compounds', 'steps'],
};

export const SYSTEM_PROMPT = `You turn a chemist's description of a synthesis (Japanese or English) into data for drawing a reaction scheme.
Return only JSON that matches the schema. Do not draw coordinates and do not explain.

Rules:
- compounds: every substrate, intermediate and product used in steps. Give each a short ref (A, B, C, ...). Put the name, number or label as written in "name".
- smiles: a valid SMILES, with stereochemistry when it is stated or implied by a named enantiomer (e.g. L-amino acids). Three-letter amino acid codes (Ala, Phe, Boc-Ala-OH, H-Phe-OMe, Fmoc-Lys(Boc)-OH) mean the L form unless D-, DL- or rac- is written; write that stereocenter in the SMILES (glycine has none). If you are not sure of the structure (internal code names, unclear names), omit smiles. Never invent a structure.
- existing: if the text refers to a compound in the EXISTING list (by its number, nickname or structure), set "existing" to its key and omit smiles.
- Products not named in the text: give the expected product only for a standard, unambiguous transformation, and set confidence "low" if unsure.
- reagents: reagents, catalysts and additives as chemists write them (HATU, DIPEA, Pd(PPh3)4, TFA). equiv as a number when given. smiles only if certain. Solvents go in "solvent", not in reagents.
- temp like "rt", "0 °C", "80 °C", "reflux"; time like "2 h", "overnight"; yield as a number in percent when given.
- Multi-step sequences: the "from" of each step includes the product of the previous step.
- "from" holds every compound whose atoms end up in the product, including coupling partners (boronic acids, amines, alkynes, azides, acid chlorides). Do not put them in reagents, even when chemists write them above the arrow.
- questions: things you could not decide, in the language of the text. Leave empty when there are none.
- If the text gives no procedure to draw (for example only "the total synthesis of X" or a question), do not guess a route from memory: return empty compounds and steps, and explain in questions what information is needed.

When an IMAGE is attached (a figure, screenshot, whiteboard or handwritten scheme), read the scheme from the image; the TEXT, if any, adds to or corrects it.
- Draw only what the image shows. Compound numbers or labels under structures (1, 2a, 3) go in "name". Conditions above and below arrows go in reagents, solvent, temp, time and yield.
- Read each drawn structure into SMILES, expanding abbreviations (Ph, Me, Boc, Bn, Ts, OTBS).
- Stereochemistry: a solid wedge bond points toward the viewer and a hashed wedge bond points away. For each stereocenter, first decide its CIP descriptor (R or S) from the drawing and write them in "cip" (e.g. "S", or "R,S" for two). Then write SMILES that encodes exactly those descriptors. @ and @@ depend on the order in which the neighbors are written, so never copy @ or @@ from another compound when the order differs. Read each compound from its own drawing; do not assume retention or inversion.
- If a structure is unreadable, cut off, too small, or contains generic groups (R, R1, X, Ar), omit smiles, set confidence "low", and say which one in questions. Never guess a structure the image does not show.
- Arrows give the order of steps; "from" is the start of the arrow and "to" is its end. If the image shows several schemes or the order is unclear, ask in questions.`;

export interface ExistingCompound {
  /** 今のスキームの化合物なら化合物 id、ライブラリなら lib:<id> */
  key: string;
  number?: string;
  nickname?: string;
  smiles?: string;
  inchikey?: string;
  structure: Structure;
}

const structureDoc = (s: Structure): Doc => ({ ...emptyDoc(), atoms: s.atoms, bonds: s.bonds, groups: s.groups });

/** 文章と一緒に送る、今のスキームの化合物とライブラリの化合物（番号か呼び名のあるもの） */
export function existingCompounds(doc: Doc, library: LibraryCompound[] = []): ExistingCompound[] {
  const out: ExistingCompound[] = [];
  const used = new Set(Object.values(doc.schemes ?? {}).flatMap((s) => s.steps.flatMap((st) => [...st.from, ...st.to])));
  for (const c of Object.values(doc.compounds ?? {})) {
    if (!used.has(c.id)) continue;
    const id = identify(structureDoc(c.structure), Object.keys(c.structure.atoms));
    out.push({ key: c.id, number: c.number, nickname: c.nickname, smiles: id?.smiles, inchikey: id?.inchikey, structure: c.structure });
  }
  for (const c of library) {
    if (!c.number && !c.nickname) continue;
    out.push({ key: `lib:${c.id}`, number: c.number, nickname: c.nickname, smiles: c.smiles, inchikey: c.inchikey, structure: c.structure });
  }
  return out;
}

/** LLM に送る本文（文章と、指せる化合物の一覧。ほかは送らない） */
export function userPrompt(text: string, existing: ExistingCompound[], answers?: { question: string; answer: string }[], image?: string): string {
  const lines = existing.slice(0, 60).map((c) => `- key=${c.key}; number=${c.number ?? ''}; nickname=${c.nickname ?? ''}; smiles=${c.smiles ?? ''}`);
  const qa = (answers ?? []).filter((a) => a.answer.trim());
  return [
    'EXISTING compounds:',
    lines.length ? lines.join('\n') : '(none)',
    '',
    ...(image ? [image, ''] : []),
    'TEXT:',
    text.trim() || '(none)',
    ...(qa.length ? ['', 'ANSWERS to your earlier questions:', ...qa.map((a) => `- Q: ${a.question}\n  A: ${a.answer.trim()}`)] : []),
  ].join('\n');
}

// ---- 形の確かめ ----

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): string | undefined => (isStr(v) && v.trim() ? v.trim() : undefined);

/** JSON の形を確かめて、使える形に直す。使えなければ理由を返す */
export function checkShape(raw: unknown): { plan: Plan } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.compounds) || !Array.isArray(r.steps)) return { error: 'compounds and steps must be arrays' };
  const compounds: PlanCompound[] = [];
  const refs = new Set<string>();
  for (const c of r.compounds as Record<string, unknown>[]) {
    const ref = optStr(c?.ref);
    if (!ref || refs.has(ref)) continue;
    refs.add(ref);
    const confidence = c.confidence === 'high' || c.confidence === 'medium' || c.confidence === 'low' ? c.confidence : undefined;
    const cip = optStr(c.cip);
    compounds.push({ ref, name: optStr(c.name), smiles: optStr(c.smiles) ?? null, existing: optStr(c.existing) ?? null, confidence, ...(cip && /^[RS](\s*,\s*[RS])*$/i.test(cip) ? { cip: cip.toUpperCase() } : {}) });
  }
  const steps: PlanStep[] = [];
  for (const s of r.steps as Record<string, unknown>[]) {
    if (!s || !Array.isArray(s.from) || !Array.isArray(s.to)) continue;
    const from = (s.from as unknown[]).filter(isStr).filter((x) => refs.has(x));
    const to = (s.to as unknown[]).filter(isStr).filter((x) => refs.has(x));
    if (!to.length && !from.length) continue;
    const reagents = Array.isArray(s.reagents)
      ? (s.reagents as Record<string, unknown>[])
          .filter((x) => x && optStr(x.text))
          .map((x) => ({ text: optStr(x.text)!, equiv: typeof x.equiv === 'number' && x.equiv > 0 ? x.equiv : null, smiles: optStr(x.smiles) ?? null }))
      : [];
    const y = s.yield;
    steps.push({
      from,
      to,
      reagents,
      solvent: optStr(s.solvent) ?? null,
      temp: optStr(s.temp) ?? null,
      time: optStr(s.time) ?? null,
      yield: typeof y === 'number' && y >= 0 && y <= 100 ? y : optStr(y) ?? null,
    });
  }
  const questions = Array.isArray(r.questions) ? (r.questions as unknown[]).map(optStr).filter((q): q is string => !!q) : [];
  // 描ける段が無くても、聞き返しがあればそれを返す（文章に手順が無いとき）
  if (!steps.length && !questions.length) return { error: 'no usable steps (each step needs from/to with refs listed in compounds)' };
  return { plan: { compounds, steps, questions } };
}

// ---- 構造と元素のつじつま ----

/** SMILES を構造（中心が原点）にする。読めなければ null */
export function structureFromSmiles(smiles: string): Structure | null {
  try {
    const r = addSmiles(emptyDoc(), smiles, { x: 0, y: 0 });
    if (!r.atomIds.length) return null;
    return structureFrom(r.doc, r.atomIds);
  } catch {
    return null;
  }
}

/** 構造が描けないときの代わり（名前を書いた1つの「原子」） */
function placeholder(name: string): Structure {
  return { atoms: { a1: { id: 'a1', x: 0, y: 0, element: '*', charge: 0, abbr: name } }, bonds: {}, groups: {} };
}

const elementsOf = (s: Structure) => new Set(Object.values(s.atoms).map((a) => a.element).filter((e) => e !== '*' && e !== 'H'));

/** 化学式の中でよく使う基の略号（元素記号と紛らわしいもの: Ac・Pr など）を、含む元素に置き換える */
const GROUP_ELEMENTS: [RegExp, string][] = [
  [/Boc|Cbz/g, 'CO'],
  [/Tf/g, 'CFSO'],
  [/Ts|Ms/g, 'CSO'],
  [/Ac/g, 'CO'],
  [/Ph|Me|Et|[in]?Pr|[nst]?Bu|Bn/g, 'C'],
];

/** 試薬の書き方が化学式（NaBH4・K2CO3・Pd(PPh3)4 など）なら、その元素。略号（HATU・TBAF）なら null */
export function formulaElements(text: string): Set<string> | null {
  let t = text.replace(/[\s·.()[\]\d+-]/g, '');
  for (const [re, els] of GROUP_ELEMENTS) t = t.replace(re, els);
  const tokens = t.match(/[A-Z][a-z]?/g);
  if (!tokens || tokens.join('') !== t || !tokens.every(isElement)) return null;
  return new Set(tokens.filter((e) => e !== 'H'));
}

/** 名前に書いた立体（(R)・(S)・(1R,2S) など）の R と S の数。書いていなければ null */
export function statedCip(name: string): { R: number; S: number } | null {
  const out = { R: 0, S: 0 };
  let found = false;
  for (const m of name.matchAll(/\(((?:\d+[a-z']*)?[RS](?:\s*,\s*(?:\d+[a-z']*)?[RS])*)\)/g)) {
    for (const d of m[1].match(/[RS](?=\s*(,|$))/g) ?? []) out[d as 'R' | 'S']++;
    found = true;
  }
  return found ? out : null;
}

const cipText = (c: { R: number; S: number }) => (c.R + c.S ? [...Array(c.R).fill('R'), ...Array(c.S).fill('S')].join(',') : 'なし');

/** 構造の不斉中心の CIP（R・S。決まっていないものは数えない） */
export function cipOf(smiles: string): { R: number; S: number } | null {
  const m = getRDKit().get_mol(smiles);
  if (!m) return null;
  try {
    const tags = JSON.parse(m.get_stereo_tags()) as { CIP_atoms: [number, string][] };
    const out = { R: 0, S: 0 };
    for (const [, l] of tags.CIP_atoms) if (l === '(R)' || l === '(S)') out[l[1] as 'R' | 'S']++;
    return out;
  } finally {
    m.delete();
  }
}

function inchikeyOf(smiles: string): string | null {
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

export interface CheckedCompound {
  ref: string;
  name?: string;
  /** 今のスキームの化合物をそのまま使う */
  reuse?: string;
  structure: Structure;
  number?: string;
  nickname?: string;
  /** 構造が分かったか（代わりの名前でなく） */
  known: boolean;
  /** 構造の SMILES（基質のまとまりの確かめに使う） */
  smiles?: string;
}

export interface CheckedPlan {
  compounds: Record<string, CheckedCompound>;
  steps: PlanStep[];
  questions: string[];
  /** compoundId の代わりに ref で指す（スキームにしたとき id に直す） */
  issues: (Omit<DraftIssue, 'compoundId'> & { ref?: string })[];
}

/**
 * 画像から読んだ立体（cip）と SMILES の立体を比べる。2026-10-26 の画像の評価で、くさびは正しく読めていそうなのに、
 * 原子の並びを変えて @/@@ をそのまま写した SMILES が多かった（同じ答えの中で、基質は正しく生成物だけ逆、など）。
 * 不斉中心が 1 つで食い違うなら、SMILES を cip に合わせて反転する。2 つ以上なら、どこが違うか決められないので知らせるだけ。
 * 合っていれば null
 */
export function fixStereo(smiles: string, cip: string): { smiles: string; message: string } | null {
  const want = cip.split(',').map((x) => x.trim().toUpperCase());
  const stated = { R: want.filter((x) => x === 'R').length, S: want.filter((x) => x === 'S').length };
  const actual = cipOf(smiles);
  if (!actual || (actual.R === stated.R && actual.S === stated.S)) return null;
  if (actual.R + actual.S === 1 && stated.R + stated.S === 1) {
    const inverted = smiles.replace(/@@?/g, (m) => (m === '@@' ? '@' : '@@'));
    const after = cipOf(inverted);
    if (after && after.R === stated.R && after.S === stated.S)
      return { smiles: inverted, message: `画像の立体（${cipText(stated)}）と SMILES の立体（${cipText(actual)}）が食い違ったので、SMILES を画像の立体（${cipText(stated)}）に直しました` };
  }
  return { smiles, message: `画像の立体（${cipText(stated)}）と SMILES の立体（${cipText(actual)}）が食い違います。立体を確かめてください` };
}

/**
 * 構造（RDKit）・既存との一致（InChIKey）・元素のつじつまを確かめる。
 * fromImage: 画像から読んだ答え。立体の決まった不斉中心があれば、いつも要確認にする
 */
export function checkPlan(plan: Plan, existing: ExistingCompound[], opts: { fromImage?: boolean } = {}): CheckedPlan {
  const issues: CheckedPlan['issues'] = [];
  const compounds: Record<string, CheckedCompound> = {};
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const byInchikey = new Map(existing.filter((e) => e.inchikey).map((e) => [e.inchikey!, e]));
  const label = (c: PlanCompound) => c.name ?? c.ref;

  for (let c of plan.compounds) {
    const ex = c.existing ? byKey.get(c.existing) : undefined;
    if (ex) {
      compounds[c.ref] = { ref: c.ref, name: c.name, reuse: ex.key.startsWith('lib:') ? undefined : ex.key, structure: ex.structure, number: ex.number, nickname: ex.nickname, known: true, smiles: ex.smiles };
      continue;
    }
    // 画像から読んだとき、LLM が書いた立体（cip）と SMILES の立体が食い違えば、SMILES の書き違いとみて直す（1 つの不斉中心のときだけ）
    const fixed = opts.fromImage && c.smiles && c.cip ? fixStereo(c.smiles, c.cip) : null;
    if (fixed) c = { ...c, smiles: fixed.smiles };
    const s = c.smiles ? structureFromSmiles(c.smiles) : null;
    if (!s) {
      compounds[c.ref] = { ref: c.ref, name: c.name, structure: placeholder(label(c)), known: false };
      issues.push(
        c.smiles
          ? { kind: 'structure', ref: c.ref, message: `${label(c)}: 構造（SMILES）が読めません。構造を描き直してください` }
          : { kind: 'missing', ref: c.ref, message: `${label(c)}: 構造が分かりませんでした。構造を描いてください` },
      );
      continue;
    }
    // 同じ構造が今のスキームかライブラリにあれば、番号と呼び名を引き継ぐ
    const key = inchikeyOf(c.smiles!);
    const same = key ? byInchikey.get(key) : undefined;
    compounds[c.ref] = {
      ref: c.ref,
      name: c.name,
      reuse: same && !same.key.startsWith('lib:') ? same.key : undefined,
      structure: same?.structure ?? s,
      number: same?.number,
      nickname: same?.nickname ?? (same ? undefined : c.name && !/^\d+[a-z]?$/.test(c.name) ? c.name : undefined),
      known: true,
      smiles: same?.smiles ?? c.smiles!,
    };
    if (!same && c.name && /^\d+[a-z]?$/.test(c.name)) compounds[c.ref].number = c.name;
    // 名前の (R)/(S) が構造に無ければ知らせる（光延の基質を逆の鏡像で描いた、2026-10-24、本物の Gemini で）。
    // 位置の番号までは対応づけず、R と S の数で比べる。名前に書いていない不斉中心は問わない
    const stated = c.name ? statedCip(c.name) : null;
    const actual = stated || opts.fromImage ? cipOf(c.smiles!) : null;
    if (stated && actual && (stated.R > actual.R || stated.S > actual.S))
      issues.push({ kind: 'stereo', ref: c.ref, message: `${label(c)}: 名前の立体（${cipText(stated)}）と、構造の立体（${cipText(actual)}）が合いません。立体を確かめてください` });
    // 画像のくさびは逆に読むことがある（2026-10-26 の画像の評価で、光延の生成物と L-Phe の 2 件を逆の鏡像で描いた。どちらも名前は無い）。
    // 正しく読めたかを機械では確かめられないので、立体があれば元の画像と見比べてもらう
    else if (fixed) issues.push({ kind: 'stereo', ref: c.ref, message: `${label(c)}: ${fixed.message}。元の画像と見比べてください` });
    else if (opts.fromImage && actual && actual.R + actual.S > 0)
      issues.push({ kind: 'stereo', ref: c.ref, message: `${label(c)}: 画像から読んだ立体（${cipText(actual)}）です。くさびの向きを読み違えることがあるので、元の画像と見比べてください` });
    if (c.confidence === 'low') issues.push({ kind: 'confidence', ref: c.ref, message: `${label(c)}: 構造に自信がない、と LLM が答えました。確かめてください` });
  }

  plan.steps.forEach((st, i) => {
    if (!st.from.length || !st.to.length) issues.push({ kind: 'step', stepIndex: i, message: `${i + 1} 段目: ${st.from.length ? '生成物' : '基質'}がありません` });
    // 生成物の元素が、基質と（中身が分かる）試薬のどこにも無ければ知らせる
    const have = new Set<string>();
    for (const r of st.from) if (compounds[r]?.known) elementsOf(compounds[r].structure).forEach((e) => have.add(e));
    let unknownReagent = false;
    for (const r of st.reagents ?? []) {
      const s = r.smiles ? structureFromSmiles(r.smiles) : null;
      const els = s ? elementsOf(s) : formulaElements(r.text);
      if (els) els.forEach((e) => have.add(e));
      else unknownReagent = true;
    }
    if (st.from.some((r) => !compounds[r]?.known)) return;
    for (const r of st.to) {
      const c = compounds[r];
      if (!c?.known) continue;
      const extra = [...elementsOf(c.structure)].filter((e) => !have.has(e));
      if (extra.length)
        issues.push({
          kind: 'elements',
          ref: r,
          stepIndex: i,
          message: `${c.name ?? r}: ${extra.join('・')} が基質${unknownReagent ? 'と、中身の分かる試薬' : 'と試薬'}にありません。構造か試薬を確かめてください`,
        });
    }
    // 基質のまとまり（環とそのまわり）が生成物に残っているか（click で置換基を取り違えた、2026-10-26。src/llm/skeleton.ts）
    const products = st.to.map((r) => compounds[r]?.smiles).filter((x): x is string => !!x);
    if (!products.length) return;
    for (const r of st.from) {
      const sub = compounds[r];
      if (!sub?.smiles) continue;
      for (const a of missingAnchors(sub.smiles, products))
        issues.push({
          kind: 'skeleton',
          ref: st.to[0],
          stepIndex: i,
          message: `${i + 1} 段目: 基質 ${sub.name ?? r} の「${a.label}」のつながりが、生成物に見当たりません。置換基の付く位置や、どの基質から来たかを確かめてください（転位などで骨格が組み替わる反応では、正しくても出ます）`,
        });
    }
  });
  return { compounds, steps: plan.steps, questions: plan.questions ?? [], issues };
}

// ---- スキームにする ----

/** 確かめた結果を、下書きのスキームとして文書に足す */
export function draftScheme(
  doc: Doc,
  checked: CheckedPlan,
  info: {
    text: string;
    model: string;
    origin: { x: number; y: number };
    styleId?: string;
    image?: string;
    imageDpi?: number;
    /** 本文・SI との突き合わせの記録（src/llm/reconcile.ts。化合物は ref で指す） */
    notes?: import('./reconcile').ReconcileNotes;
  },
): { doc: Doc; schemeId: string } {
  let schemeId = '';
  const out = edit(doc, (d) => {
    d.compounds ??= {};
    d.schemes ??= {};
    const idOf = new Map<string, string>();
    const compoundFor = (ref: string) => {
      if (idOf.has(ref)) return idOf.get(ref)!;
      const c = checked.compounds[ref];
      let id = c.reuse && d.compounds![c.reuse] ? c.reuse : '';
      if (!id) {
        id = newId(d, 'c');
        d.compounds![id] = { id, structure: structuredClone(c.structure), number: c.number, nickname: c.nickname };
      }
      idOf.set(ref, id);
      return id;
    };
    const steps: Step[] = checked.steps.map((st) => ({
      id: newId(d, 'x'),
      from: st.from.map(compoundFor),
      to: st.to.map(compoundFor),
      reagents: (st.reagents ?? []).map((r): Reagent => (r.equiv ? { text: r.text, equiv: r.equiv } : { text: r.text })),
      ...(st.solvent ? { solvent: st.solvent } : {}),
      ...(st.temp ? { temp: st.temp } : {}),
      ...(st.time ? { time: st.time } : {}),
      ...(st.yield !== null && st.yield !== undefined ? { yield: st.yield } : {}),
    }));
    schemeId = newId(d, 's');
    const issues: DraftIssue[] = checked.issues.map(({ ref, ...i }) => ({ ...i, ...(ref && idOf.has(ref) ? { compoundId: idOf.get(ref) } : {}) }));
    d.schemes[schemeId] = {
      id: schemeId,
      steps,
      styleId: info.styleId ?? 'acs',
      origin: info.origin,
      draft: {
        text: info.text,
        issues,
        questions: checked.questions,
        model: info.model,
        ...(info.image ? { image: info.image } : {}),
        ...(info.image && info.imageDpi ? { imageDpi: info.imageDpi } : {}),
        ...(info.notes?.textSources.length ? { textSources: info.notes.textSources } : {}),
        ...(info.notes?.nameChecks.length
          ? { nameChecks: info.notes.nameChecks.filter((n) => idOf.has(n.ref)).map(({ ref, ...n }) => ({ ...n, compoundId: idOf.get(ref)! })) }
          : {}),
      },
    };
  });
  return { doc: renderScheme(out, schemeId), schemeId };
}

/**
 * 「名前の構造にする」: 下書きの化合物の構造を、本文・SI の名前を OPSIN で構造にしたもの（nameChecks の smiles）に置き換える。
 * ほかのスキームでも使っている化合物なら、このスキームだけ新しい化合物にする。その化合物の名前と立体の要確認は消し、名前の確かめは「置き換えた」にする
 */
export function applyNameStructure(doc: Doc, schemeId: string, compoundId: string): Doc {
  const scheme = doc.schemes?.[schemeId];
  const check = scheme?.draft?.nameChecks?.find((n) => n.compoundId === compoundId && n.smiles);
  const structure = check?.smiles ? structureFromSmiles(check.smiles) : null;
  if (!scheme?.draft || !check || !structure || !doc.compounds?.[compoundId]) return doc;
  const out = edit(doc, (d) => {
    const sc = d.schemes![schemeId];
    const usedElsewhere = Object.values(d.schemes!).some((x) => x.id !== schemeId && x.steps.some((st) => [...st.from, ...st.to].includes(compoundId)));
    let id = compoundId;
    if (usedElsewhere) {
      id = newId(d, 'c');
      d.compounds![id] = { ...structuredClone(d.compounds![compoundId]), id };
      for (const st of sc.steps) {
        st.from = st.from.map((c) => (c === compoundId ? id : c));
        st.to = st.to.map((c) => (c === compoundId ? id : c));
      }
    }
    d.compounds![id].structure = structure;
    const dr = sc.draft!;
    dr.issues = dr.issues.filter((i) => !(i.compoundId === compoundId && (i.kind === 'name' || i.kind === 'stereo')));
    dr.nameChecks = dr.nameChecks!.map((n) => (n.compoundId === compoundId ? { ...n, compoundId: id, result: 'replaced' as const } : n));
  });
  return renderScheme(out, schemeId);
}

/** 下書きを確定する（draft を外すだけ。中身は普通のスキーム） */
export function confirmDraft(doc: Doc, schemeId: string): Doc {
  return edit(doc, (d) => {
    if (d.schemes?.[schemeId]) delete d.schemes[schemeId].draft;
  });
}

/** 下書きをやめる（スキームと、ほかで使っていない化合物を消す） */
export function discardDraft(doc: Doc, schemeId: string): Doc {
  const s = doc.schemes?.[schemeId];
  if (!s) return doc;
  return edit(doc, (d) => {
    for (const a of Object.values(d.atoms)) if (a.ref?.startsWith(`${schemeId}:`)) delete d.atoms[a.id];
    for (const b of Object.values(d.bonds)) if (!d.atoms[b.a1] || !d.atoms[b.a2]) delete d.bonds[b.id];
    for (const r of Object.values(d.arrows)) if (r.ref === schemeId) delete d.arrows[r.id];
    for (const t of Object.values(d.texts)) if (t.ref === schemeId) delete d.texts[t.id];
    for (const p of Object.values(d.pluses)) if (p.ref === schemeId) delete d.pluses[p.id];
    delete d.schemes![schemeId];
    const used = new Set(Object.values(d.schemes!).flatMap((x) => x.steps.flatMap((st) => [...st.from, ...st.to])));
    for (const st of s.steps) for (const c of [...st.from, ...st.to]) if (!used.has(c)) delete d.compounds?.[c];
  });
}

// ---- まとめて ----

/** usage は、直させた呼び出しも含めた合計（失敗でも、答えが届いた分はある） */
export type TextToSchemeResult = { ok: true; checked: CheckedPlan; usage?: LlmUsage } | { ok: false; error: import('./types').LlmError; usage?: LlmUsage };

/** LLM に送り、形が崩れていたら1回だけ直させ、確かめた結果を返す */
export async function textToScheme(
  llm: LlmProvider,
  req: {
    text: string;
    existing: ExistingCompound[];
    answers?: { question: string; answer: string }[];
    /** 画像から作るとき（今の画面は 1 枚だけ）。summary は文章と一緒に送る画像の説明（「IMAGE: ...」） */
    image?: { summary: string; images: LlmImage[] };
    thinking?: ThinkingLevel;
    signal?: AbortSignal;
  },
): Promise<TextToSchemeResult> {
  const r = await askChecked(
    llm,
    { system: SYSTEM_PROMPT, user: userPrompt(req.text, req.existing, req.answers, req.image?.summary), images: req.image?.images, schema: PLAN_SCHEMA, thinking: req.thinking, signal: req.signal },
    (raw) => {
      const s = checkShape(raw);
      return 'error' in s ? s : { value: s.plan };
    },
  );
  if (!r.ok) return r;
  return { ok: true, checked: checkPlan(r.value, req.existing, { fromImage: !!req.image }), usage: r.usage };
}

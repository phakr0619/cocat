// 言葉からスキームの評価の採点。CI のテストと、本物の API で測る道具（live.eval.ts）の両方で使う
import { emptyDoc } from '../../src/chem/model';
import { getRDKit } from '../../src/chem/rdkit';
import type { ExistingCompound, Plan, TextToSchemeResult } from '../../src/llm/textToScheme';
import { structureFromSmiles } from '../../src/llm/textToScheme';
import type { LlmError, LlmUsage } from '../../src/llm/types';
import { identify } from '../../src/project/library';
import type { Structure } from '../../src/scheme/model';
import cases from './cases.json';

export interface ExpectStep {
  from: string[];
  to: string[];
  /** 試薬の欄（と溶媒）に含まれるべき書き方 */
  reagents?: string[];
  solvent?: string;
  /** 温度の欄に含まれるべき文字（「80」など） */
  temp?: string;
  yield?: number;
}
export interface EvalCase {
  id: string;
  title: string;
  text: string;
  existing?: { key: string; number?: string; nickname?: string; smiles: string }[];
  expect: { kind: 'scheme'; steps: ExpectStep[] } | { kind: 'ask' } | { kind: 'flag' };
}
export const CASES = cases.cases as EvalCase[];

/**
 * correct: 正しい / flagged: 正しくないが、要確認か聞き返しで止まった / silent-wrong: 黙って間違えた（あってはならない）/ error: 呼び出しの失敗
 */
export type Outcome = 'correct' | 'flagged' | 'silent-wrong' | 'error';
export interface CaseScore {
  id: string;
  outcome: Outcome;
  /** 条件の一致（当たった数 / 確かめた数） */
  conditions: { hit: number; total: number };
  notes: string[];
}

/** 塩などを除いた、いちばん大きい分子の InChIKey */
export function keyOfSmiles(smiles: string): string | null {
  const R = getRDKit();
  const parts = smiles.split('.').sort((a, b) => b.replace(/[^A-Za-z]/g, '').length - a.replace(/[^A-Za-z]/g, '').length);
  const m = R.get_mol(parts[0]);
  if (!m) return null;
  try {
    const inchi = m.get_inchi();
    return inchi ? R.get_inchikey_for_inchi(inchi) : null;
  } finally {
    m.delete();
  }
}

function keyOfStructure(s: Structure): string | null {
  if (Object.values(s.atoms).some((a) => a.element === '*')) return null;
  const id = identify({ ...emptyDoc(), atoms: s.atoms, bonds: s.bonds, groups: s.groups }, Object.keys(s.atoms));
  return id ? keyOfSmiles(id.smiles) : null;
}

/** 評価の件の「今のスキームの化合物」 */
export function existingFor(c: EvalCase): ExistingCompound[] {
  return (c.existing ?? []).map((e) => ({ key: e.key, number: e.number, nickname: e.nickname, smiles: e.smiles, inchikey: keyOfSmiles(e.smiles) ?? undefined, structure: structureFromSmiles(e.smiles)! }));
}

const flat = (s: string) => s.toLowerCase().replace(/[\s·.\-–]/g, '');

/**
 * この失敗のあと、残りの件を流しても同じ失敗になるか（上限・キー違い）。そうなら理由を返す。
 * 2026-10-24 に無料キーの 1 日の上限に当たったあとも、残りの 17 件を流して同じ失敗を並べた
 */
export function stopReason(r: { ok: true } | { ok: false; error: LlmError }): string | null {
  if (r.ok) return null;
  if (r.error.kind === 'quota') return '使える量の上限に達した（無料キーは 1 日の回数に上限がある）';
  if (r.error.kind === 'auth') return 'キーが違うか、使えないキー';
  return null;
}

export function scoreCase(c: EvalCase, r: TextToSchemeResult): CaseScore {
  const notes: string[] = [];
  const score = (outcome: Outcome, hit = 0, total = 0): CaseScore => ({ id: c.id, outcome, conditions: { hit, total }, notes });
  if (!r.ok) {
    notes.push(`${r.error.kind}: ${r.error.message}`);
    return score('error');
  }
  const ch = r.checked;
  const warned = ch.issues.length > 0 || ch.questions.length > 0;
  const asked = ch.steps.length === 0 && ch.questions.length > 0;

  if (c.expect.kind === 'ask') {
    if (asked) return score('correct');
    notes.push(`聞き返さずに ${ch.steps.length} 段を作った`);
    return score(warned ? 'flagged' : 'silent-wrong');
  }
  if (c.expect.kind === 'flag') {
    if (asked || ch.issues.some((i) => i.kind === 'missing' || i.kind === 'structure')) return score('correct');
    notes.push('分からないはずの構造を、要確認にせずに描いた');
    return score(ch.issues.length ? 'flagged' : 'silent-wrong');
  }

  const keyOfRef = new Map(Object.values(ch.compounds).map((x) => [x.ref, keyOfStructure(x.structure)]));
  let ok = ch.steps.length === c.expect.steps.length;
  if (!ok) notes.push(`段の数: ${ch.steps.length}（正解 ${c.expect.steps.length}）`);
  let hit = 0;
  let total = 0;
  c.expect.steps.forEach((want, i) => {
    const got = ch.steps[i];
    if (!got) return;
    const gotFrom = new Set(got.from.map((x) => keyOfRef.get(x)));
    const gotTo = new Set(got.to.map((x) => keyOfRef.get(x)));
    // 基質は正解を含めばよい（試薬を基質に書いたものは許す）。生成物も正解を含めばよい
    for (const s of want.from)
      if (!gotFrom.has(keyOfSmiles(s))) {
        ok = false;
        notes.push(`${i + 1} 段目の基質に ${s} が無い`);
      }
    for (const s of want.to)
      if (!gotTo.has(keyOfSmiles(s))) {
        ok = false;
        notes.push(`${i + 1} 段目の生成物に ${s} が無い`);
      }
    const reagentText = flat([...(got.reagents ?? []).map((x) => x.text), got.solvent ?? ''].join(' '));
    const check = (label: string, pass: boolean) => {
      total++;
      if (pass) hit++;
      else notes.push(`${i + 1} 段目の${label}`);
    };
    for (const t of want.reagents ?? []) check(`試薬 ${t}`, reagentText.includes(flat(t)));
    if (want.solvent) check(`溶媒 ${want.solvent}`, reagentText.includes(flat(want.solvent)));
    if (want.temp) check(`温度 ${want.temp}`, (got.temp ?? '').includes(want.temp));
    if (want.yield !== undefined) check(`収率 ${want.yield}`, Number(got.yield) === want.yield);
  });
  if (ok) return score('correct', hit, total);
  return score(warned ? 'flagged' : 'silent-wrong', hit, total);
}

/** 1 回あたり 100 万トークンの料金（USD。2026-10-24 に ai.google.dev の Pricing で確認。思考のトークンは出力に入る） */
export const PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-4-argon': { input: 2, output: 10 },
};

export interface Summary {
  total: number;
  correct: number;
  flagged: number;
  silentWrong: number;
  errors: number;
  conditionRate: number;
  /** 完了の条件: 8 割以上が正しく、黙って間違えたものが無い */
  pass: boolean;
  seconds?: { mean: number; max: number };
  /** 使ったトークンの合計（output は考えた分を含む） */
  tokens?: { input: number; output: number; thinking: number };
  usd?: number;
}

export function summarize(scores: CaseScore[], runs?: { seconds: number; usage?: LlmUsage }[], model?: string): Summary {
  const n = (o: Outcome) => scores.filter((s) => s.outcome === o).length;
  const hit = scores.reduce((a, s) => a + s.conditions.hit, 0);
  const total = scores.reduce((a, s) => a + s.conditions.total, 0);
  const out: Summary = {
    total: scores.length,
    correct: n('correct'),
    flagged: n('flagged'),
    silentWrong: n('silent-wrong'),
    errors: n('error'),
    conditionRate: total ? hit / total : 1,
    pass: n('correct') >= scores.length * 0.8 && n('silent-wrong') === 0,
  };
  if (runs?.length) {
    const secs = runs.map((r) => r.seconds);
    out.seconds = { mean: secs.reduce((a, b) => a + b, 0) / secs.length, max: Math.max(...secs) };
    const price = model ? PRICES[model] : undefined;
    const sum = (k: keyof LlmUsage) => runs.reduce((a, r) => a + (r.usage?.[k] ?? 0), 0);
    out.tokens = { input: sum('input'), output: sum('output'), thinking: sum('thinking') };
    if (price) out.usd = (out.tokens.input * price.input + out.tokens.output * price.output) / 1e6;
  }
  return out;
}

/** 正解をそのまま LLM の答えの形にしたもの（採点の確かめ用） */
export function planFromExpect(c: EvalCase): Plan {
  if (c.expect.kind !== 'scheme') return { compounds: [], steps: [], questions: [] };
  const refs = new Map<string, string>();
  const ref = (s: string) => {
    if (!refs.has(s)) refs.set(s, String.fromCharCode(65 + refs.size));
    return refs.get(s)!;
  };
  const ex = new Map((c.existing ?? []).map((e) => [keyOfSmiles(e.smiles), e.key]));
  const steps = c.expect.steps.map((st) => ({
    from: st.from.map(ref),
    to: st.to.map(ref),
    reagents: (st.reagents ?? []).map((text) => ({ text })),
    solvent: st.solvent ?? null,
    temp: st.temp ? `${st.temp} °C` : null,
    time: null,
    yield: st.yield ?? null,
  }));
  const compounds = [...refs].map(([smiles, r]) => {
    const key = ex.get(keyOfSmiles(smiles));
    return key ? { ref: r, existing: key } : { ref: r, smiles };
  });
  return { compounds, steps, questions: [] };
}

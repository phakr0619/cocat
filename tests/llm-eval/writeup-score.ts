// スキームから実験項の文章を書く評価の採点。CI のテストと、本物の API で測る道具（writeup.eval.ts）の両方で使う
import { emptyDoc, type Doc } from '../../src/chem/model';
import { checkPlan, confirmDraft, draftScheme, type Plan } from '../../src/llm/textToScheme';
import { writeFacts, type WriteIssue, type WriteLanguage, type WriteUpResult } from '../../src/llm/writeUp';
import type { Step } from '../../src/scheme/model';
import { updateStoich } from '../../src/scheme/ops';
import cases from './writeup-cases.json';
import type { CaseScore, Outcome } from './score';

export interface WriteUpEvalCase {
  id: string;
  title: string;
  base: string;
  text: string;
  language: WriteLanguage;
  /** 正しい答えの例で、指示（話し言葉など）の代わりに書く後処理の文 */
  ideal?: string;
  expect: {
    /** 使うべき差し込みの印 */
    placeholders: string[];
    /** 出るべき要確認の種類 */
    expectIssues?: WriteIssue['kind'][];
    /** 出てもよい要確認の種類 */
    allowIssues?: WriteIssue['kind'][];
    /** [[…]] の外に書いてはいけない言葉（大文字小文字は問わない） */
    forbid?: string[];
    /** 差し込んだ後の文に含まれるべき書き方 */
    contains?: string[];
    /** 書き足す所か質問で知らせるべきこと（その言葉を含む書き足す所か質問があること） */
    needNotice?: string[];
  };
}
export const WRITEUP_CASES = cases.cases as WriteUpEvalCase[];
const BASES = cases.bases as unknown as Record<string, Plan & { scales: Step['scale'][] }>;

/** 評価の件の、書く前の文書（言葉からスキームの下書きを確定し、量を入れたもの） */
export function writeUpBase(c: WriteUpEvalCase): { doc: Doc; schemeId: string } {
  const plan = BASES[c.base];
  const r = draftScheme(emptyDoc(), checkPlan(plan, []), { text: '', model: 'eval', origin: { x: 0, y: 0 } });
  let doc = confirmDraft(r.doc, r.schemeId);
  plan.scales.forEach((scale, i) => (doc = updateStoich(doc, r.schemeId, i, { scale })));
  return { doc, schemeId: r.schemeId };
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * 結果: 正しい（使うべき印がすべてあり、要確認は出るべきものだけ、書いてはいけない言葉が無い）/
 * 要確認か質問で止まった / 黙って間違えた（要確認も質問も無いのに、足りない・書いてはいけない言葉がある）/ 失敗
 */
export function scoreWriteUp(c: WriteUpEvalCase, r: WriteUpResult): CaseScore {
  if (!r.ok) return { id: c.id, outcome: 'error', conditions: { hit: 0, total: c.expect.placeholders.length }, notes: [`${r.error.kind}: ${r.error.message}`] };
  const w = r.checked;
  const e = c.expect;
  const used = new Set([...w.template.matchAll(PLACEHOLDER)].map((m) => m[1]));
  const lacking = e.placeholders.filter((p) => !used.has(p));
  const outside = w.text.replace(/\[\[[^\]]*\]\]/g, ' ').toLowerCase();
  const forbidden = (e.forbid ?? []).filter((f) => outside.includes(f.toLowerCase()));
  const absent = (e.contains ?? []).filter((s) => !w.text.toLowerCase().includes(s.toLowerCase()));
  const kinds = new Set(w.issues.map((i) => i.kind));
  const missedIssue = (e.expectIssues ?? []).filter((k) => !kinds.has(k));
  const ok = new Set([...(e.expectIssues ?? []), ...(e.allowIssues ?? [])]);
  const unexpected = w.issues.filter((i) => !ok.has(i.kind));
  const noNotice = (e.needNotice ?? []).some((k) => ![...w.todos, ...w.questions].some((t) => t.toLowerCase().includes(k.toLowerCase())));

  const notes = [
    ...lacking.map((p) => `印が無い: {{${p}}}`),
    ...forbidden.map((f) => `書いてはいけない言葉: ${f}`),
    ...absent.map((s) => `指示の後処理が無い: ${s}`),
    ...missedIssue.map((k) => `出るべき要確認が無い: ${k}`),
    ...(noNotice ? ['書き足す所も質問も無い'] : []),
    ...unexpected.map((i) => `要確認: ${i.message}`),
    ...w.questions.map((q) => `質問: ${q}`),
  ];
  const wrong = lacking.length + forbidden.length + absent.length + missedIssue.length + (noNotice ? 1 : 0);
  let outcome: Outcome;
  if (!wrong && !unexpected.length) outcome = 'correct';
  else if (unexpected.length || w.questions.length) outcome = 'flagged';
  else outcome = 'silent-wrong';
  return { id: c.id, outcome, conditions: { hit: e.placeholders.length - lacking.length, total: e.placeholders.length }, notes };
}

/** 正しい答えの例（採点と確かめが通ることの確かめ用）: 段ごとに、名前と値のある量と条件を並べ、後処理は書き足す所にする */
export function idealWriteUp(c: WriteUpEvalCase): { text: string; questions: string[] } {
  const { doc, schemeId } = writeUpBase(c);
  const facts = writeFacts(doc, schemeId);
  const has = (k: string) => facts.facts.get(k)?.value !== null && facts.facts.has(k);
  const want = new Set(c.expect.placeholders);
  const ph = (k: string) => (has(k) || want.has(k) ? `{{${k}}}` : null);
  const paras = facts.steps.map((st, i) => {
    const p = `s${i + 1}`;
    const parts = st.entities.map((e) => {
      const q = (e.startsWith(`${p}.R`) ? ['mg', 'mmol', 'equiv'].map((f) => `${e}.${f}`) : ['mg', 'mmol', 'equiv'].map((f) => `${p}.${e}.${f}`)).map(ph).filter(Boolean);
      return `{{${e}}}${q.length ? ` (${q.join(', ')})` : ''}`;
    });
    const cond = ['solvent', 'temp', 'time', 'yield'].map((f) => ph(`${p}.${f}`)).filter(Boolean);
    return `${parts.join(', ')} were combined; conditions: ${cond.join(', ')}. [[work-up]]`;
  });
  if (c.expect.contains?.length) paras.push(c.ideal ?? c.text);
  if (c.expect.needNotice?.length) paras.push(`[[${c.expect.needNotice.join(' and ')} data]]`);
  return { text: paras.join('\n\n'), questions: [] };
}

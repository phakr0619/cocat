// メモから実験の記録の下書きを作る評価の採点。本物の API で測る道具（run.eval.ts）と、記録した答えを採点するテストの両方で使う
import { emptyDoc, type Doc } from '../../src/chem/model';
import { formatAmount, parseAmount, type MaterialRole } from '../../src/process/model';
import { addMaterial, createRun } from '../../src/process/ops';
import type { TextToRunResult } from '../../src/llm/textToRun';
import cases from './run-cases.json';
import type { CaseScore } from './score';

export interface RunCase {
  id: string;
  title: string;
  /** 今の仕込み: [名前, 量, 役割] */
  known: [string, string, string][];
  memo: string;
  expect: {
    /** 操作の種類の並び。それぞれの位置で、この中のどれかの種類が、この順に出てくること（間にほかの操作があってよい） */
    kinds: string[][];
    minEvents: number;
    /** 下書きのどこか（外へ出た物・次へ進む重さ）に入っているべき量 */
    amounts: string[];
    /** 足されるべき仕込みの名前（含まれていればよい） */
    materials: string[];
    /** 記録の時刻に入っているべき時刻 */
    times: string[];
    /** メモに量が無い件: 外へ出た物・次へ進む重さ・足した仕込みに、量が 1 つも入っていないこと */
    noAmounts?: boolean;
  };
}
export const RUN_CASES = cases.cases as RunCase[];

/** 件の、今の記録（仕込みだけが入った物）を作る */
export function runDocFor(c: RunCase): { doc: Doc; runId: string } {
  let { doc, runId } = createRun(emptyDoc(), undefined, new Date(2026, 10, 14));
  for (const [name, amount, role] of c.known) doc = addMaterial(doc, runId, { name, role: role as MaterialRole, amount: parseAmount(amount) ?? undefined });
  return { doc, runId };
}

const norm = (s: string) => s.replace(/\s+/g, '').replace(/\.0(?=[a-zA-Zµ])/g, '').toLowerCase();

/**
 * correct: 期待した操作の並び・量・仕込み・時刻がすべて入り、メモに無い数字が無い
 * flagged: 足りない所があるが、要確認か聞き返しが付いている
 * silent-wrong: メモに無い量が入っているのに、要確認が付いていない（量の無い件で量が入った、を含む）
 */
export function scoreRun(c: RunCase, r: TextToRunResult): CaseScore {
  const notes: string[] = [];
  if (!r.ok) return { id: c.id, outcome: 'error', conditions: { hit: 0, total: 0 }, notes: [`${r.error.kind}: ${r.error.message}`] };
  const d = r.draft;
  let hit = 0;
  let total = 0;
  const check = (ok: boolean, what: string) => {
    total++;
    if (ok) hit++;
    else notes.push(what);
  };
  // 操作の並び
  let at = 0;
  let orderOk = true;
  for (const any of c.expect.kinds) {
    const i = d.operations.findIndex((op, k) => k >= at && any.includes(op.kind));
    if (i < 0) {
      orderOk = false;
      break;
    }
    at = i + 1;
  }
  check(orderOk, `操作の並びが違う: ${d.operations.map((o) => `${o.kind}(${o.name})`).join(' → ')}`);
  check(d.events.length >= c.expect.minEvents, `記録が ${d.events.length} 行（${c.expect.minEvents} 行以上のはず）`);
  const amounts = [...d.operations.flatMap((op) => [...op.outputs.map((o) => o.amount), op.carry]), ...d.materials.map((m) => m.amount)].filter((a) => !!a).map((a) => norm(formatAmount(a)));
  for (const a of c.expect.amounts) check(amounts.includes(norm(a)), `量 ${a} が入っていない`);
  for (const m of c.expect.materials) check(d.materials.some((x) => norm(x.name).includes(norm(m))), `仕込みに ${m} が無い`);
  const times = d.events.map((e) => (e.time ?? '').replace(/^0/, ''));
  for (const t of c.expect.times) check(times.includes(t.replace(/^0/, '')), `時刻 ${t} の記録が無い`);
  // 黙って間違えた: メモに無い量が、要確認なしで入っている
  const flagged = d.issues.length > 0 || d.questions.length > 0;
  const memo = norm(c.memo.normalize('NFKC'));
  const invented = amounts.filter((a) => !memo.includes(a) && !memo.includes(a.replace(/(\d)([a-zµ])/, '$1.0$2')));
  if (c.expect.noAmounts && amounts.length) invented.push(...amounts);
  if (invented.length) notes.push(`メモに無い量: ${[...new Set(invented)].join(', ')}`);
  if (d.issues.length) notes.push(`要確認 ${d.issues.length} 件: ${d.issues.map((i) => i.message).join(' / ')}`);
  if (d.questions.length) notes.push(`聞き返し: ${d.questions.join(' / ')}`);
  const outcome = invented.length && !flagged ? 'silent-wrong' : hit === total && !invented.length ? 'correct' : flagged ? 'flagged' : 'silent-wrong';
  // 足りない所があって要確認も無いときは、足りないだけ（数字を作ってはいない）なら flagged ではなく、足りないと分かる形か見る
  return { id: c.id, outcome: outcome === 'silent-wrong' && !invented.length ? 'flagged' : outcome, conditions: { hit, total }, notes };
}

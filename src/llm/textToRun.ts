// 実験のメモの文章から、実験の記録（操作・外へ出た物・重さ・記録・足りない仕込み）の下書きを作る。
//
// 数字は LLM に作らせない: 返ってきた量・温度・時刻の数字が、メモに書いてある数字かを確かめ、無い数字は要確認にする。
// 量は「10 g」「100 mL」の形に読めるかを確かめ、読めなければ入れない。下書きは、人が確かめて確定するまで文書に入れない
import type { Doc } from '../chem/model';
import { edit, newId } from '../chem/model';
import { renderRun } from '../process/layout';
import { OP_KINDS, parseAmount, type Amount, type Material, type MaterialRole, type OpKind, type Operation, type ProcessRun, type RunEvent } from '../process/model';
import { materialName } from '../process/ops';
import { askChecked } from './ask';
import type { JsonSchema, LlmError, LlmProvider, LlmUsage, ThinkingLevel } from './types';
import { givenNumbers } from './writeUp';

const KINDS = OP_KINDS.map((k) => k.kind);
const ROLES: MaterialRole[] = ['reagent', 'solvent', 'water', 'other'];

export const RUN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS },
          name: { type: 'string', description: 'Short name of the unit operation, in the language of the memo' },
          outputs: {
            type: 'array',
            description: 'Streams that leave the process at this operation (aqueous layer, mother liquor, distillate, ...)',
            items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'string', description: 'mass or volume with unit, only if the memo gives it' } }, required: ['name'] },
          },
          carry: { type: 'string', description: 'Mass of the main stream that goes on to the next operation (for the last operation: the product obtained), only if the memo gives it' },
        },
        required: ['kind', 'name'],
      },
    },
    materials: {
      type: 'array',
      description: 'Materials charged that are NOT in KNOWN MATERIALS (wash solutions, extraction and crystallization solvents, ...)',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, role: { type: 'string', enum: ROLES }, amount: { type: 'string' }, operation: { type: 'integer', description: '1-based index into operations' } },
        required: ['name', 'role', 'operation'],
      },
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          operation: { type: 'integer', description: '1-based index into operations' },
          time: { type: 'string', description: 'clock time as written in the memo (HH:MM), if given' },
          action: { type: 'string', description: 'what was done' },
          amount: { type: 'string' },
          temp: { type: 'string', description: 'internal temperature, if given' },
          note: { type: 'string', description: 'measurement or observation, if given' },
        },
        required: ['operation', 'action'],
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['operations', 'events'],
};

export const RUN_SYSTEM_PROMPT = `You turn a chemist's lab memo of one run of a reaction into a structured record: unit operations in order, what left the process at each operation, masses, and a time-stamped log.
Return only JSON that matches the schema.

Rules:
- Use only what the memo says. Never invent or compute a number: every amount, temperature and time you write must appear in the memo as written. If the memo does not give a value, leave the field out.
- operations: the unit operations in the order they were done. Pick kind from the list (charge, reaction, addition, heatcool, quench, separation, wash, extraction, concentration, swap, crystallization, filtration, drying, column, other). Merge consecutive washes of the same organic layer into one operation unless the memo treats them separately. Give each a short name in the language of the memo.
- outputs: what leaves the process at that operation (for example aqueous layers, mother liquor, distillate, filter cake that is discarded). Add its amount only if the memo gives the mass or volume.
- carry: the mass of the main stream that goes on to the next operation, only if the memo gives it (for example the weight of the organic layer, the concentrate, the wet cake). For the last operation, carry is the mass of product obtained.
- materials: things that were charged and are not listed in KNOWN MATERIALS, with role (reagent, solvent, water for water and aqueous solutions, other) and the operation where they were charged. Do not repeat KNOWN MATERIALS.
- Amounts are a number and a unit from mg, g, kg, µL, mL, L (for example "50 g", "100 mL"). Do not convert units.
- events: one entry per thing done or observed, in order, each pointing to its operation. Copy clock times as HH:MM. Put internal temperatures in temp, and measurements or observations (pH, HPLC, colour, exotherm, phase separation, weights) in note. Keep the wording short, in the language of the memo.
- If something in the memo is unclear or contradictory, say so in questions instead of guessing.`;

/** 送る本文: 今の仕込み（名前と量）と、メモ（「送る内容を見る」でそのまま見せる）。ロットは送らない */
export function runPrompt(doc: Doc, run: ProcessRun, memo: string): string {
  const known = run.materials.map((m) => `- ${materialName(doc, m) || '(no name)'}${m.amount ? ` (${m.amount.value} ${m.amount.unit})` : ''} [${m.role}]`);
  return ['KNOWN MATERIALS:', ...(known.length ? known : ['(none)']), '', `PRODUCT: ${materialName(doc, { id: '', role: 'other', name: run.product.name, compoundId: run.product.compoundId }) || 'product'}`, '', 'MEMO:', memo.trim()].join('\n');
}

export interface RawRunDraft {
  operations: { kind: string; name: string; outputs?: { name: string; amount?: string }[]; carry?: string }[];
  materials?: { name: string; role: string; amount?: string; operation: number }[];
  events: { operation: number; time?: string; action: string; amount?: string; temp?: string; note?: string }[];
  questions?: string[];
}

export function checkRunShape(raw: unknown): { value: RawRunDraft } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'the answer is not an object' };
  const o = raw as Partial<RawRunDraft>;
  if (!Array.isArray(o.operations) || !o.operations.length) return { error: '"operations" must be a non-empty array' };
  if (!Array.isArray(o.events)) return { error: '"events" must be an array' };
  for (const op of o.operations) if (!op || typeof op.kind !== 'string' || typeof op.name !== 'string') return { error: 'each operation needs kind and name' };
  for (const e of o.events) if (!e || typeof e.operation !== 'number' || typeof e.action !== 'string') return { error: 'each event needs operation and action' };
  return { value: o as RawRunDraft };
}

/** number: メモに無い数字 / amount: 量として読めない / index: 操作の番号が合わない / kind: 知らない種類 */
export interface RunDraftIssue {
  kind: 'number' | 'amount' | 'index' | 'kind';
  message: string;
}

export interface RunDraft {
  operations: (Omit<Operation, 'id' | 'outputs'> & { outputs: { name: string; amount?: Amount }[] })[];
  materials: (Pick<Material, 'name' | 'role' | 'amount'> & { operation: number })[];
  events: (Omit<RunEvent, 'id' | 'opId'> & { operation: number })[];
  issues: RunDraftIssue[];
  questions: string[];
}

const NUMBER = /\d+(?:[.,:]\d+)*/g;

/** 答えを確かめて、下書きにする。量は読めた物だけを入れ、メモに無い数字・読めない量・合わない番号は issues に入れる */
export function checkRunDraft(memo: string, raw: RawRunDraft): RunDraft {
  const issues: RunDraftIssue[] = [];
  const add = (i: RunDraftIssue) => {
    if (!issues.some((x) => x.message === i.message)) issues.push(i);
  };
  const given = givenNumbers(memo);
  /** 文字の中の数字が、メモにあるか。無ければ知らせて false */
  const numbersOk = (text: string | undefined, where: string): boolean => {
    let ok = true;
    for (const m of (text ?? '').normalize('NFKC').matchAll(NUMBER)) {
      const before = (text ?? '')[m.index! - 1] ?? '';
      if (/[A-Za-z)\]]/.test(before)) continue; // NaHCO3・CH2Cl2 の添字
      if (given.has(m[0]) || m[0].split(/[:,]/).every((n) => given.has(n)) || given.has(m[0].replace(/^0+(?=\d)/, ''))) continue;
      add({ kind: 'number', message: `${where}の「${m[0]}」は、メモに無い数字です` });
      ok = false;
    }
    return ok;
  };
  const amount = (text: string | undefined, where: string): Amount | undefined => {
    if (!text?.trim()) return undefined;
    const a = parseAmount(text);
    if (!a) {
      add({ kind: 'amount', message: `${where}の量「${text}」を、数と単位として読めません。入れていません` });
      return undefined;
    }
    return numbersOk(text, where) ? a : undefined;
  };
  const operations: RunDraft['operations'] = raw.operations.map((op, i) => {
    const known = (KINDS as string[]).includes(op.kind);
    if (!known) add({ kind: 'kind', message: `操作 ${i + 1}「${op.name}」の種類「${op.kind}」は知らない種類です。「その他」にしました` });
    const where = `操作 ${i + 1}「${op.name}」`;
    return {
      kind: (known ? op.kind : 'other') as OpKind,
      name: op.name.trim() || OP_KINDS.find((k) => k.kind === op.kind)?.name || '操作',
      outputs: (op.outputs ?? []).filter((o) => o && typeof o.name === 'string').map((o) => ({ name: o.name.trim(), ...(amount(o.amount, `${where}の ${o.name}`) ? { amount: amount(o.amount, `${where}の ${o.name}`) } : {}) })),
      ...(amount(op.carry, `${where}の次へ進む重さ`) ? { carry: amount(op.carry, `${where}の次へ進む重さ`) } : {}),
    };
  });
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= operations.length;
  const materials: RunDraft['materials'] = [];
  for (const m of raw.materials ?? []) {
    if (!m || typeof m.name !== 'string' || !m.name.trim()) continue;
    if (!inRange(m.operation)) add({ kind: 'index', message: `仕込み「${m.name}」の入れる操作の番号（${m.operation}）が合いません。最初の操作にしました` });
    const a = amount(m.amount, `仕込み「${m.name}」`);
    materials.push({ name: m.name.trim(), role: (ROLES as string[]).includes(m.role) ? (m.role as MaterialRole) : 'other', ...(a ? { amount: a } : {}), operation: inRange(m.operation) ? m.operation : 1 });
  }
  const events: RunDraft['events'] = [];
  raw.events.forEach((e, i) => {
    if (!e.action.trim()) return;
    const where = `記録 ${i + 1}`;
    if (!inRange(e.operation)) add({ kind: 'index', message: `${where}「${e.action}」の操作の番号（${e.operation}）が合いません。最後の操作にしました` });
    const keep = (text: string | undefined, what: string) => (text?.trim() && numbersOk(text, `${where}の${what}`) ? text.trim() : undefined);
    numbersOk(e.action, `${where}のしたこと`);
    const time = keep(e.time, '時刻');
    const amt = keep(e.amount, '量');
    const temp = keep(e.temp, '内温');
    const note = e.note?.trim();
    if (note) numbersOk(note, `${where}の測定・観察`);
    events.push({ operation: inRange(e.operation) ? e.operation : operations.length, action: e.action.trim(), ...(time ? { time } : {}), ...(amt ? { amount: amt } : {}), ...(temp ? { temp } : {}), ...(note ? { note } : {}) });
  });
  return { operations, materials, events, issues, questions: (raw.questions ?? []).filter((q): q is string => typeof q === 'string' && !!q.trim()) };
}

export type TextToRunResult = { ok: true; draft: RunDraft; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage };

/** メモから下書きを作る */
export async function textToRun(llm: LlmProvider, req: { doc: Doc; runId: string; memo: string; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<TextToRunResult> {
  const run = req.doc.runs?.[req.runId];
  if (!run) return { ok: false, error: { kind: 'invalid-output', message: 'no run' } };
  const r = await askChecked(llm, { system: RUN_SYSTEM_PROMPT, user: runPrompt(req.doc, run, req.memo), schema: RUN_SCHEMA, thinking: req.thinking, signal: req.signal }, checkRunShape);
  if (!r.ok) return r;
  return { ok: true, draft: checkRunDraft(req.memo, r.value), usage: r.usage };
}

/**
 * 下書きを記録に入れる: 操作と記録は下書きの物に置き換え、仕込みは今ある行を残して、下書きの行を足す（同じ名前の行は足さない）。
 * 今の仕込みで、消える操作に入れていた物は、最初の操作に入れた物になる
 */
export function applyRunDraft(doc: Doc, runId: string, draft: RunDraft): Doc {
  if (!doc.runs?.[runId]) return doc;
  return renderRun(
    edit(doc, (d) => {
      const run = d.runs![runId];
      const id = () => newId(d, 'e');
      const ops: Operation[] = draft.operations.map((op) => ({ id: id(), kind: op.kind, name: op.name, outputs: op.outputs.map((o) => ({ id: id(), name: o.name, ...(o.amount ? { amount: o.amount } : {}) })), ...(op.carry ? { carry: op.carry } : {}) }));
      for (const m of run.materials) delete m.opId;
      const names = new Set(run.materials.map((m) => materialName(d, m).trim().toLowerCase()));
      for (const m of draft.materials) {
        if (names.has(m.name.trim().toLowerCase())) continue;
        names.add(m.name.trim().toLowerCase());
        run.materials.push({ id: id(), name: m.name, role: m.role, ...(m.amount ? { amount: m.amount } : {}), ...(m.operation > 1 ? { opId: ops[m.operation - 1].id } : {}) });
      }
      run.operations = ops;
      run.events = draft.events.map((e) => ({ id: id(), opId: ops[e.operation - 1].id, action: e.action, ...(e.time ? { time: e.time } : {}), ...(e.amount ? { amount: e.amount } : {}), ...(e.temp ? { temp: e.temp } : {}), ...(e.note ? { note: e.note } : {}) }));
    }),
    runId,
  );
}

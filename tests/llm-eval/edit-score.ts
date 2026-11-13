// 言葉での編集の評価の採点（M3-4 段3）。CI のテストと、本物の API で測る道具（edit.eval.ts）の両方で使う
import { emptyDoc, type Doc } from '../../src/chem/model';
import { applyEdit, type TextEditResult } from '../../src/llm/textEdit';
import { checkPlan, confirmDraft, draftScheme, type Plan } from '../../src/llm/textToScheme';
import { identify } from '../../src/project/library';
import type { Compound, Step } from '../../src/scheme/model';
import cases from './edit-cases.json';
import { keyOfSmiles, type CaseScore, type Outcome } from './score';

/** "*" は問わない */
type Any = '*';
export interface ExpectStepEdit {
  reagents?: string[];
  reagentsNot?: string[];
  equiv?: Record<string, number>;
  solvent?: string | Any;
  /** 含まれるべき文字 */
  temp?: string | Any;
  time?: string | Any;
  yield?: number | Any;
}
export interface ExpectCompoundEdit {
  number?: string;
  nickname?: string;
  smiles?: string;
}
export interface EditEvalCase {
  id: string;
  title: string;
  base: string;
  text: string;
  /** 選んでおく化合物（base の ref） */
  select?: string[];
  expect:
    | { kind: 'edit'; steps?: Record<string, ExpectStepEdit>; compounds?: Record<string, ExpectCompoundEdit>; style?: string; wholeScheme?: boolean }
    | { kind: 'ask' };
}
export const EDIT_CASES = cases.cases as EditEvalCase[];
const BASES = cases.bases as unknown as Record<string, Plan>;

export interface EditBase {
  doc: Doc;
  schemeId: string;
  /** base の ref → 化合物 id */
  ids: Record<string, string>;
  selected: string[];
}

/** 評価の件の、直す前の文書（言葉からスキームの下書きを確定したもの） */
export function editBase(c: EditEvalCase): EditBase {
  const plan = BASES[c.base];
  const checked = checkPlan(plan, []);
  const r = draftScheme(emptyDoc(), checked, { text: '', model: 'eval', origin: { x: 0, y: 0 } });
  const doc = confirmDraft(r.doc, r.schemeId);
  // draftScheme は compounds の順でなく、段に出てくる順に id を付ける。構造で ref に結び付ける
  const ids: Record<string, string> = {};
  for (const pc of plan.compounds) {
    const key = keyOfSmiles(pc.smiles!);
    const id = Object.values(doc.compounds!).find((x) => keyOfCompound(x) === key)?.id;
    if (id) ids[pc.ref] = id;
  }
  return { doc, schemeId: r.schemeId, ids, selected: (c.select ?? []).map((ref) => ids[ref]) };
}

function keyOfCompound(c: Compound): string | null {
  const id = identify({ ...emptyDoc(), atoms: c.structure.atoms, bonds: c.structure.bonds, groups: c.structure.groups }, Object.keys(c.structure.atoms));
  return id ? keyOfSmiles(id.smiles) : null;
}

const flat = (s: string) => s.toLowerCase().replace(/[\s·.\-–]/g, '');
const reagentsOf = (st: Step) => st.reagents.map((r) => `${r.text}${r.equiv !== undefined ? ` (${r.equiv})` : ''}`).join(', ');
const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

/** 直した後の文書が、正解のとおりか。違う所を返す（空なら正しい） */
export function editMismatches(c: EditEvalCase, base: EditBase, after: Doc): string[] {
  if (c.expect.kind !== 'edit') return [];
  const want = c.expect;
  const notes: string[] = [];
  const a = base.doc.schemes![base.schemeId];
  const b = after.schemes![base.schemeId];
  if (b.styleId !== (want.style ?? a.styleId)) notes.push(`書式: ${b.styleId}（正解 ${want.style ?? a.styleId}）`);
  a.steps.forEach((sa, i) => {
    const sb = b.steps[i];
    const w = want.steps?.[String(i + 1)];
    const at = `${i + 1} 段目`;
    if (!w) {
      if (reagentsOf(sa) !== reagentsOf(sb)) notes.push(`${at}の試薬が変わった: ${reagentsOf(sb)}`);
      for (const f of ['solvent', 'temp', 'time', 'yield'] as const) if (!same(sa[f], sb[f])) notes.push(`${at}の ${f} が変わった: ${String(sb[f] ?? '')}`);
      return;
    }
    const text = flat(sb.reagents.map((r) => r.text).join(' '));
    if (w.reagents || w.reagentsNot) {
      for (const t of w.reagents ?? []) if (!text.includes(flat(t))) notes.push(`${at}の試薬に ${t} が無い（${reagentsOf(sb)}）`);
      for (const t of w.reagentsNot ?? []) if (text.includes(flat(t))) notes.push(`${at}の試薬に ${t} が残った`);
    } else if (reagentsOf(sa) !== reagentsOf(sb)) notes.push(`${at}の試薬が変わった: ${reagentsOf(sb)}`);
    for (const [t, n] of Object.entries(w.equiv ?? {})) {
      const r = sb.reagents.find((x) => flat(x.text).includes(flat(t)));
      if (r?.equiv !== n) notes.push(`${at}の ${t} の当量: ${r?.equiv ?? 'なし'}（正解 ${n}）`);
    }
    const field = (f: 'solvent' | 'temp' | 'time', exact: boolean) => {
      const wv = w[f];
      if (wv === '*') return;
      if (wv === undefined) {
        if (!same(sa[f], sb[f])) notes.push(`${at}の ${f} が変わった: ${sb[f] ?? ''}`);
        return;
      }
      const got = flat(sb[f] ?? '');
      if (exact ? got !== flat(wv) : !got.includes(flat(wv))) notes.push(`${at}の ${f}: ${sb[f] ?? ''}（正解 ${wv}）`);
    };
    field('solvent', true);
    field('temp', false);
    field('time', false);
    if (w.yield !== '*') {
      const wy = w.yield ?? sa.yield;
      if (!same(sb.yield, wy)) notes.push(`${at}の収率: ${sb.yield ?? ''}（正解 ${wy ?? ''}）`);
    }
  });
  for (const [ref, id] of Object.entries(base.ids)) {
    const ca = base.doc.compounds![id];
    const cb = after.compounds![id];
    const w = want.compounds?.[ref] ?? {};
    if (!same(cb.number, w.number ?? ca.number)) notes.push(`${ref} の番号: ${cb.number ?? ''}（正解 ${w.number ?? ca.number ?? ''}）`);
    // 構造を書き換える化合物は、呼び名を合わせて直してよい（Boc-Ala-OH → Cbz-Ala-OH。差の一覧に出るので、人が確かめられる）
    const renameOk = !!w.smiles && w.nickname === undefined;
    if (!renameOk && !same(cb.nickname, w.nickname ?? ca.nickname)) notes.push(`${ref} の呼び名: ${cb.nickname ?? ''}（正解 ${w.nickname ?? ca.nickname ?? ''}）`);
    const wantKey = w.smiles ? keyOfSmiles(w.smiles) : keyOfCompound(ca);
    if (keyOfCompound(cb) !== wantKey) notes.push(w.smiles ? `${ref} の構造が正解（${w.smiles}）と違う` : `${ref} の構造が変わった`);
  }
  return notes;
}

/** 採点。結果の分け方は言葉からスキームと同じ（正しい / 要確認か聞き返しで止まった / 黙って間違えた / 失敗） */
export function scoreEdit(c: EditEvalCase, base: EditBase, r: TextEditResult): CaseScore {
  const notes: string[] = [];
  const score = (outcome: Outcome): CaseScore => ({ id: c.id, outcome, conditions: { hit: 0, total: 0 }, notes });
  if (!r.ok) {
    notes.push(`${r.error.kind}: ${r.error.message}`);
    return score('error');
  }
  const ch = r.checked;
  const after = applyEdit(base.doc, base.schemeId, ch.ops);
  // 利用者に見える知らせ: 聞き返し・使えなかった指示・要確認
  const warned = ch.questions.length > 0 || ch.rejected.length > 0 || ch.warnings.length > 0;
  notes.push(...ch.rejected.map((x) => `使えなかった: ${x}`), ...ch.warnings.map((x) => `要確認: ${x}`), ...ch.questions.map((x) => `質問: ${x}`));

  if (c.expect.kind === 'ask') {
    const changed = JSON.stringify(after.schemes) !== JSON.stringify(base.doc.schemes) || JSON.stringify(after.compounds) !== JSON.stringify(base.doc.compounds);
    if (!changed && ch.questions.length) return score('correct');
    if (!changed && warned) return score('flagged');
    notes.push(changed ? '聞き返さずに直した' : '何も言わずに何もしなかった');
    return score(warned ? 'flagged' : 'silent-wrong');
  }
  const wrong = editMismatches(c, base, after);
  if (ch.wholeScheme !== (c.expect.wholeScheme ?? false)) wrong.push(`whole_scheme: ${ch.wholeScheme}（正解 ${c.expect.wholeScheme ?? false}）`);
  notes.unshift(...wrong);
  if (!wrong.length) return score('correct');
  return score(warned ? 'flagged' : 'silent-wrong');
}

/** 正解をそのまま LLM の答え（操作の並び）の形にしたもの（採点の確かめ用。ask はそのまま聞き返す） */
export function opsFromExpect(c: EditEvalCase, base: EditBase): { ops: Record<string, unknown>[]; whole_scheme?: boolean; questions: string[] } {
  if (c.expect.kind === 'ask') return { ops: [], questions: ['どれを直しますか？'] };
  const s = base.doc.schemes![base.schemeId];
  const ops: Record<string, unknown>[] = [];
  for (const [n, w] of Object.entries(c.expect.steps ?? {})) {
    const st = s.steps[Number(n) - 1];
    if (w.reagents || w.reagentsNot) {
      for (const r of st.reagents) ops.push({ op: 'remove_reagent', step: Number(n), reagent: r.text });
      for (const t of w.reagents ?? []) ops.push({ op: 'add_reagent', step: Number(n), text: t, ...(w.equiv?.[t] !== undefined ? { equiv: w.equiv[t] } : {}) });
    }
    if (w.solvent !== undefined && w.solvent !== '*') ops.push({ op: 'set_condition', step: Number(n), field: 'solvent', value: w.solvent });
    if (w.temp !== undefined && w.temp !== '*') ops.push({ op: 'set_condition', step: Number(n), field: 'temp', value: `${w.temp} °C` });
    if (w.time !== undefined && w.time !== '*') ops.push({ op: 'set_condition', step: Number(n), field: 'time', value: `${w.time} h` });
    if (w.yield !== undefined && w.yield !== '*') ops.push({ op: 'set_condition', step: Number(n), field: 'yield', value: String(w.yield) });
  }
  for (const [ref, w] of Object.entries(c.expect.compounds ?? {})) {
    const compound = base.ids[ref];
    if (w.number !== undefined || w.nickname !== undefined) ops.push({ op: 'set_compound', compound, ...(w.number !== undefined ? { number: w.number } : {}), ...(w.nickname !== undefined ? { nickname: w.nickname } : {}) });
    if (w.smiles) ops.push({ op: 'replace_structure', compound, smiles: w.smiles });
  }
  if (c.expect.style) ops.push({ op: 'set_style', style: c.expect.style });
  return { ops, whole_scheme: c.expect.wholeScheme ?? false, questions: [] };
}

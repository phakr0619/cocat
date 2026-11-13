// 仕上げの一括の指示の評価の採点。CI のテストと、本物の API で測る道具（finish.eval.ts）の両方で使う
import { emptyDoc, type Doc } from '../../src/chem/model';
import { applyFinish, finishableSchemes, STYLE_OPTIONS, type FinishResult, type StyleOption } from '../../src/llm/finish';
import { checkPlan, confirmDraft, draftScheme, existingCompounds, type Plan } from '../../src/llm/textToScheme';
import { identify } from '../../src/project/library';
import type { Compound } from '../../src/scheme/model';
import { getStyle, type SchemeStyle } from '../../src/scheme/style';
import cases from './finish-cases.json';
import { keyOfSmiles, type CaseScore, type Outcome } from './score';

/** "*" は問わない */
type Any = '*';
export interface ExpectStepFinish {
  /** 試薬の書き方の並び */
  reagents?: string[] | Any;
  solvent?: string | Any;
  temp?: string | Any;
  time?: string | Any;
}
export interface FinishEvalCase {
  id: string;
  title: string;
  base: string;
  scope: 'all' | 'active';
  /** scope が active のとき、選んでいるスキーム（上から 1 番目が 1） */
  active?: number;
  text: string;
  expect:
    | {
        kind: 'finish';
        style?: { base: string; options?: Partial<Record<StyleOption, string | boolean>>; loose?: boolean };
        /** 「スキーム.段」（"*" はすべての段） */
        steps?: Record<string, ExpectStepFinish>;
        numbers?: Record<string, string>;
        mustWarn?: boolean;
      }
    | { kind: 'cannot' };
}
export const FINISH_CASES = cases.cases as FinishEvalCase[];
const BASES = cases.bases as unknown as Record<string, { schemes: { styleId: string; plan: Plan }[] }>;

export interface FinishBase {
  doc: Doc;
  /** 文書のスキーム（上から順） */
  schemeIds: string[];
  /** 仕上げる範囲 */
  targets: string[];
  /** base の ref → 化合物 id */
  ids: Record<string, string>;
}

const keyOfCompound = (c: Compound) => {
  const id = identify({ ...emptyDoc(), atoms: c.structure.atoms, bonds: c.structure.bonds, groups: c.structure.groups }, Object.keys(c.structure.atoms));
  return id ? keyOfSmiles(id.smiles) : null;
};

/** 評価の件の、直す前の文書（言葉からスキームの下書きを、上から順に確定したもの。同じ構造の化合物は共有する） */
export function finishBase(c: FinishEvalCase): FinishBase {
  let doc = emptyDoc();
  const ids: Record<string, string> = {};
  BASES[c.base].schemes.forEach((b, n) => {
    const checked = checkPlan(b.plan, existingCompounds(doc));
    const r = draftScheme(doc, checked, { text: '', model: 'eval', origin: { x: 0, y: n * 400 }, styleId: b.styleId });
    doc = confirmDraft(r.doc, r.schemeId);
    for (const pc of b.plan.compounds) {
      const key = keyOfSmiles(pc.smiles!);
      const id = Object.values(doc.compounds!).find((x) => keyOfCompound(x) === key)?.id;
      if (id) ids[pc.ref] = id;
    }
  });
  const schemeIds = finishableSchemes(doc).map((s) => s.id);
  const targets = c.scope === 'active' ? [schemeIds[(c.active ?? 1) - 1]] : schemeIds;
  return { doc, schemeIds, targets, ids };
}

const flat = (s: string) => s.toLowerCase().replace(/[\s·.\-–]/g, '');
const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');
const fields = (s: SchemeStyle) => Object.fromEntries(STYLE_OPTIONS.map((k) => [k, s[k]]));

/** 仕上げた後の文書が、正解のとおりか。違う所を返す（空なら正しい） */
export function finishMismatches(c: FinishEvalCase, base: FinishBase, after: Doc): string[] {
  const want: Partial<Extract<FinishEvalCase['expect'], { kind: 'finish' }>> = c.expect.kind === 'finish' ? c.expect : {};
  const notes: string[] = [];
  base.schemeIds.forEach((sid, n) => {
    const at = `スキーム ${n + 1}`;
    const inScope = base.targets.includes(sid);
    const a = base.doc.schemes![sid];
    const b = after.schemes![sid];
    // 書式は、仕上げる項目（STYLE_OPTIONS）で比べる
    const sa = fields(getStyle(a.styleId, base.doc.styles));
    const sb = fields(getStyle(b.styleId, after.styles));
    const ws = inScope ? want.style : undefined;
    const wantStyle = !ws ? sa : ws.loose ? { ...sb, ...ws.options } : { ...(ws.base === 'current' ? sa : fields(getStyle(ws.base))), ...ws.options };
    for (const k of STYLE_OPTIONS) if (wantStyle[k] !== sb[k]) notes.push(`${at}の書式の ${k}: ${String(sb[k])}（正解 ${String(wantStyle[k])}）`);
    a.steps.forEach((st, i) => {
      const nb = b.steps[i];
      // 「スキーム.段」のスキームは、LLM に送るのと同じ範囲の中の番号
      const w = (inScope ? (want.steps?.[`${base.targets.indexOf(sid) + 1}.${i + 1}`] ?? want.steps?.['*']) : undefined) ?? {};
      const step = `${at}の ${i + 1} 段目`;
      // 当量と収率は、仕上げではいつも変わらない
      if (JSON.stringify(st.reagents.map((r) => r.equiv)) !== JSON.stringify(nb.reagents.map((r) => r.equiv))) notes.push(`${step}の当量が変わった`);
      if (!same(st.yield, nb.yield)) notes.push(`${step}の収率が変わった: ${String(nb.yield ?? '')}`);
      const texts = nb.reagents.map((r) => r.text);
      if (w.reagents !== '*') {
        const wr = w.reagents ?? st.reagents.map((r) => r.text);
        if (texts.length !== wr.length || texts.some((t, j) => flat(t) !== flat(wr[j]))) notes.push(`${step}の試薬: ${texts.join(', ')}（正解 ${wr.join(', ')}）`);
      } else if (texts.length !== st.reagents.length) notes.push(`${step}の試薬の数が変わった: ${texts.join(', ')}`);
      for (const f of ['solvent', 'temp', 'time'] as const) {
        const wv = w[f];
        if (wv === '*') continue;
        if (flat(nb[f] ?? '') !== flat(wv ?? st[f] ?? '')) notes.push(`${step}の ${f}: ${nb[f] ?? ''}（正解 ${wv ?? st[f] ?? ''}）`);
      }
    });
  });
  for (const [ref, id] of Object.entries(base.ids)) {
    const ca = base.doc.compounds![id];
    const cb = after.compounds![id];
    const wn = want.numbers?.[ref] ?? ca.number;
    if (!same(cb.number, wn)) notes.push(`${ref} の番号: ${cb.number ?? ''}（正解 ${wn ?? ''}）`);
    if (!same(cb.nickname, ca.nickname)) notes.push(`${ref} の呼び名が変わった: ${cb.nickname ?? ''}`);
    if (keyOfCompound(cb) !== keyOfCompound(ca)) notes.push(`${ref} の構造が変わった`);
  }
  return notes;
}

/** 採点。分け方は言葉からスキームと同じ（正しい / 要確認か聞き返しで止まった / 黙って間違えた / 失敗） */
export function scoreFinish(c: FinishEvalCase, base: FinishBase, r: FinishResult): CaseScore {
  const notes: string[] = [];
  const score = (outcome: Outcome): CaseScore => ({ id: c.id, outcome, conditions: { hit: 0, total: 0 }, notes });
  if (!r.ok) {
    notes.push(`${r.error.kind}: ${r.error.message}`);
    return score('error');
  }
  const ch = r.checked;
  const after = applyFinish(base.doc, base.targets, ch.ops);
  // 利用者に見える知らせ: できないこと・聞き返し・使えなかった指示・要確認
  const told = ch.cannot.length > 0 || ch.questions.length > 0 || ch.rejected.length > 0;
  const warned = told || ch.warnings.length > 0;
  notes.push(
    ...ch.cannot.map((x) => `できない: ${x}`),
    ...ch.rejected.map((x) => `使えなかった: ${x}`),
    ...ch.warnings.map((x) => `要確認: ${x}`),
    ...ch.questions.map((x) => `質問: ${x}`),
  );
  const wrong = finishMismatches(c, base, after);
  if (c.expect.kind === 'cannot') {
    if (!wrong.length && (ch.cannot.length || ch.questions.length)) return score('correct');
    notes.unshift(...wrong, ...(told ? [] : ['できないことを知らせなかった']));
    return score(told ? 'flagged' : 'silent-wrong');
  }
  if (c.expect.mustWarn && !told) wrong.push('頼まれた中身の変更を、できないこととして知らせなかった');
  notes.unshift(...wrong);
  if (!wrong.length) return score('correct');
  return score(warned ? 'flagged' : 'silent-wrong');
}

/** 正解をそのまま LLM の答え（操作の並び）の形にしたもの（採点の確かめ用） */
export function opsFromExpect(c: FinishEvalCase, base: FinishBase): { ops: Record<string, unknown>[]; cannot: string[]; questions: string[] } {
  if (c.expect.kind === 'cannot') return { ops: [], cannot: ['フォントと線の太さは直せません'], questions: [] };
  const w = c.expect;
  const ops: Record<string, unknown>[] = [];
  if (w.style && w.style.base !== 'current') ops.push({ op: 'set_style', style: w.style.base });
  for (const [option, value] of Object.entries(w.style?.options ?? {})) ops.push({ op: 'set_style_option', option, value: String(value) });
  for (const [key, ws] of Object.entries(w.steps ?? {})) {
    if (key === '*') continue;
    const [scheme, step] = key.split('.').map(Number);
    const st = base.doc.schemes![base.targets[scheme - 1]].steps[step - 1];
    if (Array.isArray(ws.reagents))
      ws.reagents.forEach((t, j) => {
        if (st.reagents[j].text !== t) ops.push({ op: 'rename_reagent', scheme, step, reagent: st.reagents[j].text, text: t });
      });
    for (const f of ['solvent', 'temp', 'time'] as const) if (ws[f] !== undefined && ws[f] !== '*') ops.push({ op: 'set_condition', scheme, step, field: f, value: ws[f] });
  }
  if (w.numbers) {
    const nums = Object.values(w.numbers);
    const prefix = /^(\D*)/.exec(nums[0])![1];
    ops.push({ op: 'renumber', start: Math.min(...nums.map((x) => Number(x.slice(prefix.length)))), prefix });
  }
  return { ops, cannot: w.mustWarn ? ['TFA を HCl に替えるのは、仕上げではできません'] : [], questions: [] };
}

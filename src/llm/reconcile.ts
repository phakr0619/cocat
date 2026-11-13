// 図（①画像 → スキーム）と本文・SI（②文字 → 事実）の突き合わせ。決まった規則で、AI は使わない
//
// - 図に条件・収率が無く、文字にある → 文字から補い、出所（「SI p.12」）を残す
// - 図と文字で条件・収率が食い違う → 図の値を残し、要確認（両方を並べる）。試薬・溶媒は略号と正式名の違いで食い違って見えやすいので、補うだけ
// - 文字に系統名がある → OPSIN で構造にし、図の構造と InChIKey（立体を含む）で比べる。違えば要確認（自動では置き換えない）
import { inchikeyOf } from './structureToName';
import { figureLabel, normalizeLabel, stereoLabel } from './pdfText';
import { structureFromSmiles, type CheckedPlan, type PlanStep } from './textToScheme';
import type { Facts, FactStep } from './textFacts';
import type { TextField } from '../scheme/model';

/** 名前 → SMILES（OPSIN）。読めなければ null */
export type NameToSmiles = (name: string) => Promise<string | null>;

export interface ReconcileNotes {
  textSources: { stepIndex: number; field: TextField; where: string }[];
  nameChecks: { ref: string; name: string; result: 'match' | 'stereo' | 'mismatch' | 'filled' | 'unread'; where: string; smiles?: string }[];
}

/** 図の番号と文字の番号が同じ化合物か（立体の前置きが両方にあれば、それも同じこと） */
export function sameCompound(a: string, b: string): boolean {
  if (normalizeLabel(a) !== normalizeLabel(b)) return false;
  const sa = stereoLabel(a);
  const sb = stereoLabel(b);
  const plain = (x: string) => x === normalizeLabel(x);
  return plain(sa) || plain(sb) || sa === sb;
}

// ---- 数値のならし ----

/** 収率（%）。「quant.」は 100 */
export function yieldOf(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return v;
  if (!v) return null;
  if (/quant/i.test(v)) return 100;
  const m = /(\d+(?:\.\d+)?)/.exec(v);
  return m ? Number(m[1]) : null;
}

/** 温度を °C の範囲にする（rt は 20〜25、reflux は印として返す）。読めなければ null */
export function tempOf(v: string | null | undefined): { lo: number; hi: number } | 'reflux' | null {
  if (!v) return null;
  // 範囲のダッシュ（「0–60 °C」）は「to」にする。マイナスの記号（「−78 °C」）は数の頭に付いたまま残す
  const t = v
    .toLowerCase()
    .replace(/(\d)\s*[–—-]\s*(?=[−-]?\d)/g, '$1 to ')
    .replace(/[−–]/g, '-');
  if (/reflux/.test(t) && !/\d/.test(t)) return 'reflux';
  const nums: number[] = [];
  // 「0 to 60 °C」の 0 のように、範囲の頭の数は °C が付かないことがある
  const re = /(-?\d+(?:\.\d+)?)\s*(?:°?\s*c\b|(?=\s*(?:to|~)\s*-?\d+(?:\.\d+)?\s*°?\s*c\b))|\b(r\.?\s*t\.?|room temp(?:erature)?|ambient)\b/g;
  for (const m of t.matchAll(re)) {
    if (m[1] !== undefined) nums.push(Number(m[1]));
    else nums.push(20, 25);
  }
  if (!nums.length) return /reflux/.test(t) ? 'reflux' : null;
  return { lo: Math.min(...nums), hi: Math.max(...nums) };
}

/** 時間を時間（h）の範囲にする（overnight は 8〜24 h）。読めなければ null */
export function timeOf(v: string | null | undefined): { lo: number; hi: number } | null {
  if (!v) return null;
  const t = v.toLowerCase();
  if (/overnight|o\/n/.test(t)) return { lo: 8, hi: 24 };
  const m = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|min|mins|minutes?|d|days?)\b/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const h = /^m/.test(m[2]) ? n / 60 : /^d/.test(m[2]) ? n * 24 : n;
  return { lo: h, hi: h };
}

const overlap = (a: { lo: number; hi: number }, b: { lo: number; hi: number }, tol: number) => a.lo <= b.hi + tol && b.lo <= a.hi + tol;

/** 図と文字の値が同じとみなせるか。読めない値どうしは比べない（null） */
export function sameValue(field: 'temp' | 'time' | 'yield', fig: string | number, text: string | number): boolean | null {
  if (field === 'yield') {
    const a = yieldOf(fig);
    const b = yieldOf(text);
    return a === null || b === null ? null : Math.abs(a - b) <= 1;
  }
  if (field === 'temp') {
    const a = tempOf(String(fig));
    const b = tempOf(String(text));
    if (!a || !b) return null;
    // 還流の温度は溶媒で決まるので、数の温度とは比べない（MeOH の還流は 65 °C）
    if (a === 'reflux' || b === 'reflux') return a === b ? true : null;
    return overlap(a, b, 2);
  }
  const a = timeOf(String(fig));
  const b = timeOf(String(text));
  if (!a || !b) return null;
  return overlap(a, b, Math.max(a.hi, b.hi) * 0.1);
}

const FIELD_JA: Record<'temp' | 'time' | 'yield', string> = { temp: '温度', time: '時間', yield: '収率' };
const show = (field: 'temp' | 'time' | 'yield', v: string | number) => (field === 'yield' && typeof v === 'number' ? `${v}%` : String(v));

/**
 * 突き合わせる。checked（①の結果）は変えずに、補った・食い違いを足した新しい CheckedPlan と、出所と名前の確かめの記録を返す。
 * labelOf は、図の化合物（ref）の番号（①の答えの name。番号でなければ undefined）
 */
export async function reconcile(
  checked: CheckedPlan,
  facts: Facts,
  opsin: NameToSmiles | null,
): Promise<{ checked: CheckedPlan; notes: ReconcileNotes }> {
  const out: CheckedPlan = structuredClone(checked);
  const notes: ReconcileNotes = { textSources: [], nameChecks: [] };
  const labelOf = (ref: string) => {
    const c = out.compounds[ref];
    const l = c?.number ?? c?.name;
    return l === undefined ? undefined : figureLabel(l);
  };

  // ---- 段の条件・収率 ----
  out.steps.forEach((st: PlanStep, i) => {
    const toLabels = st.to.map(labelOf).filter((x): x is string => !!x);
    const fromLabels = st.from.map(labelOf).filter((x): x is string => !!x);
    const candidates: FactStep[] = facts.steps.filter((f) => f.to.some((t) => toLabels.some((l) => sameCompound(l, t))));
    // 文字の段の基質が、図の段の基質と 1 つも合わなければ、図と文字で段の分け方が違う（図の 2 段を 1 段に読んだなど）。
    // そのときは条件を補わずに知らせる（別の段の条件が混ざるため）
    const sameFrom = (f: FactStep) => !f.from.length || !fromLabels.length || f.from.some((x) => fromLabels.some((l) => sameCompound(l, x)));
    const fact = candidates.find(sameFrom);
    if (!fact) {
      const other = candidates[0];
      if (other)
        out.issues.push({
          kind: 'text',
          stepIndex: i,
          message: `${i + 1} 段目: ${other.page} では、この生成物を ${other.from.join('、')} から作っています。図では ${fromLabels.join('、') || '?'} からです。段の分け方を元の論文で確かめてください。この段には文字から何も補っていません`,
        });
      return;
    }
    const where = fact.page;
    if (!st.reagents?.length && fact.reagents.length) {
      st.reagents = fact.reagents.map((r) => ({ text: r.text, ...(r.equiv ? { equiv: r.equiv } : {}) }));
      notes.textSources.push({ stepIndex: i, field: 'reagents', where });
    }
    if (!st.solvent && fact.solvent) {
      st.solvent = fact.solvent;
      notes.textSources.push({ stepIndex: i, field: 'solvent', where });
    }
    for (const field of ['temp', 'time', 'yield'] as const) {
      const fv = st[field];
      const tv = fact[field];
      if (tv === undefined || tv === null || tv === '') continue;
      if (fv === undefined || fv === null || fv === '') {
        (st as unknown as Record<string, unknown>)[field] = tv;
        notes.textSources.push({ stepIndex: i, field, where });
        continue;
      }
      if (sameValue(field, fv, tv) === false)
        out.issues.push({
          kind: 'text',
          stepIndex: i,
          message: `${i + 1} 段目の${FIELD_JA[field]}: 図は ${show(field, fv)}、${where} は ${show(field, tv)}。図の値のままにしています`,
        });
    }
  });

  // ---- 系統名を OPSIN で構造にして比べる ----
  for (const fc of facts.compounds) {
    const ref = Object.keys(out.compounds).find((r) => {
      const l = labelOf(r);
      return l !== undefined && sameCompound(l, fc.label);
    });
    if (!ref) continue;
    const c = out.compounds[ref];
    const label = labelOf(ref) ?? ref;
    let name = fc.names[0];
    let smiles: string | null = null;
    if (opsin) {
      for (const n of fc.names) {
        smiles = await opsin(n).catch(() => null);
        if (smiles) {
          name = n;
          break;
        }
      }
    }
    if (!smiles) {
      notes.nameChecks.push({ ref, name, result: 'unread', where: fc.page });
      continue;
    }
    const nameKey = inchikeyOf(smiles);
    if (!c.known || !c.smiles) {
      const s = structureFromSmiles(smiles);
      if (!s || !nameKey) {
        notes.nameChecks.push({ ref, name, result: 'unread', where: fc.page });
        continue;
      }
      out.compounds[ref] = { ...c, structure: s, smiles, known: true };
      out.issues = out.issues.filter((x) => !(x.ref === ref && (x.kind === 'missing' || x.kind === 'structure')));
      out.issues.push({ kind: 'name', ref, message: `${label}: 図から構造を読めなかったので、${fc.page} の名前「${name}」から構造を入れました。元の論文と見比べてください` });
      notes.nameChecks.push({ ref, name, result: 'filled', where: fc.page, smiles });
      continue;
    }
    const figKey = inchikeyOf(c.smiles);
    if (!nameKey || !figKey) {
      notes.nameChecks.push({ ref, name, result: 'unread', where: fc.page });
      continue;
    }
    // 名前の構造（立体を含む）と同じなら、画像から読んだ立体の「見比べてください」は要らない。違うときは、名前の要確認に一つにまとめる
    out.issues = out.issues.filter((x) => !(x.ref === ref && x.kind === 'stereo'));
    if (nameKey === figKey) notes.nameChecks.push({ ref, name, result: 'match', where: fc.page, smiles });
    else if (nameKey.slice(0, 14) === figKey.slice(0, 14)) {
      notes.nameChecks.push({ ref, name, result: 'stereo', where: fc.page, smiles });
      out.issues.push({ kind: 'name', ref, message: `${label}: ${fc.page} の名前「${name}」の構造と、立体が合いません。骨格は同じです` });
    } else {
      notes.nameChecks.push({ ref, name, result: 'mismatch', where: fc.page, smiles });
      out.issues.push({ kind: 'name', ref, message: `${label}: ${fc.page} の名前「${name}」の構造と、図から読んだ構造が違います。置換の位置や環を確かめてください` });
    }
  }
  return { checked: out, notes };
}

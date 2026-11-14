// 実験の記録の計算: 操作ごとの収支・全体の収支・収率・生成物の行方・PMI と、確かめてほしい所。
// 式と出典は docs/process-record.md
import { formatGrams, toGrams, type Material, type Operation, type ProcessRun } from './model';

export interface OpBalance {
  opId: string;
  /** 入った重さ（前の操作から来た物 ＋ この操作で入れた物）。出せなければ undefined */
  inG?: number;
  /** 出た重さ（外へ出た物 ＋ 次へ進む物） */
  outG?: number;
  /** 次へ進む物の重さ（測った値か、差から出した値） */
  carryG?: number;
  /** carry を差から出した */
  carryDerived: boolean;
  /** 外へ出た物のうち、差から出した物の id */
  derivedOutputId?: string;
  derivedOutputG?: number;
  /** 収支（出 ÷ 入）。差から出した値を使ったときは出さない */
  closure?: number;
  /** 収支を出せない理由 */
  why?: string;
}

export interface RunBalance {
  ops: OpBalance[];
  totalInG?: number;
  totalOutG?: number;
  /** 全体の収支（外へ出た物と得た物の合計 ÷ 仕込みの合計） */
  closure?: number;
  /** 得た生成物の重さ */
  productG?: number;
  /** 理論収量 */
  theoryG?: number;
  /** 収率（%）。含量を考えない */
  yieldPct?: number;
  /** 含量で補正した収率（%）。仕込みか生成物に含量があるときだけ */
  assayYieldPct?: number;
  /** PMI: 仕込みの合計 ÷ 得た生成物の重さ */
  pmi?: number;
  /** PMI の内訳: 溶媒・水と水溶液・そのほか（基質と試薬など）。足すと PMI になる */
  pmiParts?: { solvent: number; water: number; other: number };
  /** 生成物の行方（理論収量に対する %）。外へ出た物に生成物の含量があるときだけ */
  fate: { name: string; pct: number }[];
  /** 行方の分からない分（%） */
  fateUnknown?: number;
  warnings: { opId?: string; text: string }[];
}

/** 収支が 100% からこれより離れたら知らせる（%） */
export const CLOSURE_TOLERANCE = 5;

const sum = (xs: (number | undefined)[]): number | undefined => (xs.some((x) => x === undefined) ? undefined : (xs as number[]).reduce((a, b) => a + b, 0));

/** 基準の基質（最初の基質） */
export function baseMaterial(run: ProcessRun): Material | undefined {
  return run.materials.find((m) => m.role === 'substrate');
}

const molOf = (m: Material | undefined, withAssay: boolean): number | undefined => {
  const g = toGrams(m?.amount, m?.density);
  if (g === undefined || !m?.mw) return undefined;
  return (g * (withAssay ? (m.assay ?? 100) / 100 : 1)) / m.mw;
};

export function runBalance(run: ProcessRun): RunBalance {
  const warnings: RunBalance['warnings'] = [];
  const firstOp = run.operations[0]?.id;
  const chargedAt = (op: Operation) => run.materials.filter((m) => (m.opId && run.operations.some((o) => o.id === m.opId) ? m.opId : firstOp) === op.id);
  const ops: OpBalance[] = [];
  let prev: number | undefined = 0;
  run.operations.forEach((op, i) => {
    const charged = chargedAt(op);
    const noMass = charged.filter((m) => toGrams(m.amount, m.density) === undefined);
    const inG = prev === undefined ? undefined : sum([prev, ...charged.map((m) => toGrams(m.amount, m.density))]);
    const outs = op.outputs.map((o) => toGrams(o.amount, o.density));
    const carry = toGrams(op.carry);
    const unknownOuts = op.outputs.filter((_, j) => outs[j] === undefined);
    const b: OpBalance = { opId: op.id, inG, carryDerived: false };
    const known = outs.filter((x): x is number => x !== undefined).reduce((a, x) => a + x, 0);
    if (inG === undefined) {
      b.why = noMass.length ? `${noMass.map((m) => m.name).join('・')} の重さが分かりません` : '前の操作から来た重さが分かりません';
      b.carryG = carry;
    } else if (carry !== undefined && !unknownOuts.length) {
      b.carryG = carry;
      b.outG = known + carry;
      b.closure = inG > 0 ? (b.outG / inG) * 100 : undefined;
    } else if (carry === undefined && !unknownOuts.length) {
      // 次へ進む物を差から出す
      b.carryG = inG - known;
      b.carryDerived = true;
      b.outG = inG;
    } else if (carry !== undefined && unknownOuts.length === 1) {
      // 外へ出た物の 1 つを差から出す
      b.carryG = carry;
      b.derivedOutputId = unknownOuts[0].id;
      b.derivedOutputG = inG - known - carry;
      b.outG = inG;
    } else {
      b.carryG = carry;
      b.why = '重さの入っていない物が 2 つ以上あります';
    }
    if (noMass.length && inG === undefined) for (const m of noMass) if (m.amount && !m.density) warnings.push({ opId: op.id, text: `${m.name}: 体積で入れた物は、密度を入れると重さにできます` });
    if (b.closure !== undefined) {
      if (b.closure > 100 + CLOSURE_TOLERANCE) warnings.push({ opId: op.id, text: `${op.name}: 収支が ${b.closure.toFixed(1)}% です。出た重さが入れた重さより多くなっています` });
      else if (b.closure < 100 - CLOSURE_TOLERANCE) warnings.push({ opId: op.id, text: `${op.name}: 収支が ${b.closure.toFixed(1)}% です。出た物が抜けていないか確かめてください` });
    }
    if (b.carryDerived && b.carryG !== undefined && b.carryG < 0) warnings.push({ opId: op.id, text: `${op.name}: 外へ出た重さが、入れた重さより多くなっています` });
    if (b.derivedOutputG !== undefined && b.derivedOutputG < 0) warnings.push({ opId: op.id, text: `${op.name}: 出た重さの合計が、入れた重さより多くなっています` });
    if (b.derivedOutputId) {
      const o = op.outputs.find((x) => x.id === b.derivedOutputId)!;
      warnings.push({ opId: op.id, text: `${op.name}: ${o.name || '出た物'} の重さが未入力です。差から ${formatGrams(b.derivedOutputG)} としています` });
    }
    if (i === run.operations.length - 1 && b.carryDerived) warnings.push({ opId: op.id, text: `${op.name}: 得た生成物の重さが未入力です。差から ${formatGrams(b.carryG)} としています` });
    ops.push(b);
    prev = b.carryG;
  });

  const totalInG = sum(run.materials.map((m) => toGrams(m.amount, m.density)));
  const last = ops.at(-1);
  const productG = last?.carryG;
  const outKnown = run.operations.flatMap((op, i) => op.outputs.map((o) => toGrams(o.amount, o.density) ?? (ops[i].derivedOutputId === o.id ? ops[i].derivedOutputG : undefined)));
  const totalOutG = productG === undefined ? undefined : sum([productG, ...outKnown]);
  const measuredAll = ops.every((b) => !b.carryDerived && !b.derivedOutputId);
  const closure = totalInG && totalOutG !== undefined && measuredAll && toGrams(run.operations.at(-1)?.carry) !== undefined ? (totalOutG / totalInG) * 100 : undefined;

  const base = baseMaterial(run);
  const baseMol = molOf(base, false);
  const mw = run.product.mw;
  const theoryG = baseMol !== undefined && mw ? baseMol * mw : undefined;
  const yieldPct = theoryG && productG !== undefined ? (productG / theoryG) * 100 : undefined;
  const hasAssay = base?.assay !== undefined || run.product.assay !== undefined;
  const baseMolA = molOf(base, true);
  const theoryA = baseMolA !== undefined && mw ? baseMolA * mw : undefined;
  const assayYieldPct = hasAssay && theoryA && productG !== undefined ? ((productG * (run.product.assay ?? 100)) / 100 / theoryA) * 100 : undefined;
  const pmi = totalInG !== undefined && productG && productG > 0 ? totalInG / productG : undefined;

  let pmiParts: RunBalance['pmiParts'];
  if (pmi !== undefined && productG) {
    const of = (pick: (m: Material) => boolean) => run.materials.filter(pick).reduce((a, m) => a + (toGrams(m.amount, m.density) ?? 0), 0) / productG;
    pmiParts = { solvent: of((m) => m.role === 'solvent'), water: of((m) => m.role === 'water'), other: of((m) => m.role !== 'solvent' && m.role !== 'water') };
  }

  // 生成物の行方: 外へ出た物のうち、生成物の含量が入っている物
  const fate: RunBalance['fate'] = [];
  let fateUnknown: number | undefined;
  const theory = theoryA ?? theoryG;
  const withAssay = run.operations.flatMap((op, i) =>
    op.outputs.filter((o) => o.productAssay !== undefined).map((o) => ({ o, g: toGrams(o.amount, o.density) ?? (ops[i].derivedOutputId === o.id ? ops[i].derivedOutputG : undefined) })),
  );
  if (theory && withAssay.length && productG !== undefined) {
    const isolated = ((productG * (run.product.assay ?? 100)) / 100 / theory) * 100;
    fate.push({ name: '単離', pct: isolated });
    for (const { o, g } of withAssay) if (g !== undefined) fate.push({ name: o.name || '出た物', pct: ((g * o.productAssay!) / 100 / theory) * 100 });
    fateUnknown = 100 - fate.reduce((a, f) => a + f.pct, 0);
    if (fateUnknown < -CLOSURE_TOLERANCE) warnings.push({ text: `生成物の行方の合計が ${(100 - fateUnknown).toFixed(1)}% です。含量か重さを確かめてください` });
  }

  // 仕込みの当量と量が合うか
  if (baseMol !== undefined)
    for (const m of run.materials) {
      if (m === base || m.equiv === undefined || !m.mw) continue;
      const mol = molOf(m, false);
      if (mol === undefined) continue;
      const actual = mol / baseMol;
      if (Math.abs(actual - m.equiv) / m.equiv > 0.03) warnings.push({ text: `${m.name}: 当量は ${m.equiv} ですが、入れた量からは ${actual.toFixed(2)} 当量になります` });
    }

  // 記録の時刻が前の行より早い（HH:MM の形の時刻だけを比べる）
  let lastT = -1;
  for (const e of run.events) {
    const m = e.time?.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (t < lastT) {
      warnings.push({ opId: e.opId, text: `記録の時刻 ${e.time} が、前の行より早くなっています` });
      break;
    }
    lastT = t;
  }
  return { ops, totalInG, totalOutG, closure, productG, theoryG, yieldPct, assayYieldPct, pmi, pmiParts, fate, fateUnknown, warnings };
}

const pct = (v: number | undefined, d = 1) => (v === undefined || !isFinite(v) ? '' : `${v.toFixed(d)}%`);
export { pct as formatPct };

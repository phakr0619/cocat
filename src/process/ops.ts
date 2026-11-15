// 実験の記録を作る・直す操作。どれも、直した後にフロー図を描き直した文書を返す
import type { Doc } from '../chem/model';
import { edit, newId } from '../chem/model';
import { stoichTable } from '../scheme/stoich';
import { compoundName } from '../scheme/stoich';
import { renderRun, clearRun } from './layout';
import { OP_KINDS, type Amount, type Material, type OpKind, type Operation, type Output, type ProcessRun, type RunEvent } from './model';

const opName = (kind: OpKind) => OP_KINDS.find((k) => k.kind === kind)?.name ?? '操作';

/** mg の値を、読みやすい単位の量にする */
function amountFromMg(mg: number | undefined): Amount | undefined {
  if (mg === undefined || !isFinite(mg)) return undefined;
  if (mg >= 1e6) return { value: +(mg / 1e6).toPrecision(4), unit: 'kg' };
  if (mg >= 1000) return { value: +(mg / 1000).toPrecision(4), unit: 'g' };
  return { value: +mg.toPrecision(4), unit: 'mg' };
}

/** フロー図を置く所: 図のいちばん下の、少し下 */
function below(doc: Doc): { x: number; y: number } {
  let x = Infinity;
  let y = -Infinity;
  const see = (px: number, py: number) => {
    x = Math.min(x, px);
    y = Math.max(y, py);
  };
  for (const a of Object.values(doc.atoms)) see(a.x, a.y);
  for (const t of Object.values(doc.texts)) see(t.x, t.y);
  for (const r of Object.values(doc.arrows)) (see(r.x1, r.y1), see(r.x2, r.y2));
  for (const s of Object.values(doc.shapes ?? {})) (see(s.x1, s.y1), see(s.x2, s.y2));
  return isFinite(x) ? { x: x - 8, y: y + 48 } : { x: 60, y: 60 };
}

/**
 * 実験の記録を作る。スキームの段があれば、その段の基質・試薬・溶媒から仕込みの行を作り、量は化学量論表の値を入れる。
 * 操作ははじめに「反応」「分液・洗浄」「濃縮」を置く（足す・消す・並べ替えはあとでできる）
 */
export function createRun(doc: Doc, from?: { schemeId: string; stepIndex: number }, today = new Date()): { doc: Doc; runId: string } {
  let runId = '';
  const out = edit(doc, (d) => {
    runId = newId(d, 'e');
    const id = () => newId(d, 'e');
    const ops: Operation[] = (['reaction', 'separation', 'concentration'] as OpKind[]).map((kind) => ({ id: id(), kind, name: kind === 'separation' ? '分液・洗浄' : opName(kind), outputs: [] }));
    ops[1].outputs.push({ id: id(), name: '水層' });
    ops[2].outputs.push({ id: id(), name: '留出' });
    const materials: Material[] = [];
    let product: ProcessRun['product'] = { name: '生成物' };
    const step = from ? d.schemes?.[from.schemeId]?.steps[from.stepIndex] : undefined;
    if (from && step) {
      for (const r of stoichTable(d, step)) {
        if (r.kind === 'product') {
          if (product.compoundId) continue;
          product = { name: r.name, compoundId: r.ref as string, mw: r.mw };
          continue;
        }
        materials.push({
          id: id(),
          name: r.name,
          role: r.kind,
          ...(r.kind === 'substrate' ? { compoundId: r.ref as string } : {}),
          ...(r.mw ? { mw: +r.mw.toFixed(2) } : {}),
          ...(r.equiv !== undefined ? { equiv: r.equiv } : {}),
          ...(r.density ? { density: r.density } : {}),
          ...(amountFromMg(r.mg) ? { amount: amountFromMg(r.mg) } : {}),
        });
      }
      if (step.solvent) for (const s of step.solvent.split(/\s*[/,]\s*/).filter(Boolean)) materials.push({ id: id(), name: s, role: 'solvent' });
    }
    const run: ProcessRun = {
      id: runId,
      ...(from && step ? { schemeId: from.schemeId, stepId: step.id, ...(step.notebook ? { notebook: step.notebook } : {}) } : {}),
      date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      materials,
      operations: ops,
      events: [],
      product,
      flow: { direction: 'horizontal', showMass: true },
      origin: below(d),
    };
    d.runs = { ...(d.runs ?? {}), [runId]: run };
  });
  return { doc: renderRun(out, runId), runId };
}

/** 記録を直して描き直す */
export function updateRun(doc: Doc, runId: string, fn: (run: ProcessRun, d: Doc) => void): Doc {
  if (!doc.runs?.[runId]) return doc;
  return renderRun(
    edit(doc, (d) => fn(d.runs![runId], d)),
    runId,
  );
}

export const setRunInfo = (doc: Doc, runId: string, patch: Partial<Pick<ProcessRun, 'title' | 'notebook' | 'date'>>) =>
  updateRun(doc, runId, (r) => {
    Object.assign(r, patch);
    for (const k of ['title', 'notebook', 'date'] as const) if (!r[k]) delete r[k];
  });

export const setRunFlow = (doc: Doc, runId: string, patch: Partial<ProcessRun['flow']>) => updateRun(doc, runId, (r) => Object.assign(r.flow, patch));
export const setRunProduct = (doc: Doc, runId: string, patch: Partial<ProcessRun['product']>) =>
  updateRun(doc, runId, (r) => {
    Object.assign(r.product, patch);
    if (r.product.assay === undefined) delete r.product.assay;
    if (r.product.mw === undefined) delete r.product.mw;
  });

/** undefined にした項目は消す */
function assign<T extends object>(target: T, patch: Partial<T>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') delete (target as Record<string, unknown>)[k];
    else (target as Record<string, unknown>)[k] = v;
  }
}

export const addMaterial = (doc: Doc, runId: string, m: Partial<Material> = {}) =>
  updateRun(doc, runId, (r, d) => {
    r.materials.push({ id: newId(d, 'e'), name: '', role: 'other', ...m });
  });
export const updateMaterial = (doc: Doc, runId: string, id: string, patch: Partial<Material>) =>
  updateRun(doc, runId, (r) => {
    const m = r.materials.find((x) => x.id === id);
    if (m) assign(m, patch);
  });
export const removeMaterial = (doc: Doc, runId: string, id: string) =>
  updateRun(doc, runId, (r) => {
    r.materials = r.materials.filter((x) => x.id !== id);
  });

/** 操作を足す。after の後ろ（無ければ最後）に入れる */
export const addOperation = (doc: Doc, runId: string, kind: OpKind, after?: string) =>
  updateRun(doc, runId, (r, d) => {
    const op: Operation = { id: newId(d, 'e'), kind, name: opName(kind), outputs: [] };
    const at = after ? r.operations.findIndex((o) => o.id === after) : -1;
    r.operations.splice(at >= 0 ? at + 1 : r.operations.length, 0, op);
  });
export const updateOperation = (doc: Doc, runId: string, id: string, patch: Partial<Pick<Operation, 'kind' | 'name' | 'carry'>>) =>
  updateRun(doc, runId, (r) => {
    const op = r.operations.find((o) => o.id === id);
    if (!op) return;
    // 種類を替えたとき、名前がはじめの名前のままなら、新しい種類の名前にする
    if (patch.kind && patch.kind !== op.kind && patch.name === undefined && op.name === opName(op.kind)) op.name = opName(patch.kind);
    assign(op, patch);
  });
/** 操作を消す。その操作で入れていた仕込みは最初の操作へ、記録は消す */
export const removeOperation = (doc: Doc, runId: string, id: string) =>
  updateRun(doc, runId, (r) => {
    if (r.operations.length <= 1) return;
    r.operations = r.operations.filter((o) => o.id !== id);
    for (const m of r.materials) if (m.opId === id) delete m.opId;
    r.events = r.events.filter((e) => e.opId !== id);
  });
/** 操作を前（-1）か後ろ（+1）へ動かす */
export const moveOperation = (doc: Doc, runId: string, id: string, by: -1 | 1) =>
  updateRun(doc, runId, (r) => {
    const i = r.operations.findIndex((o) => o.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= r.operations.length) return;
    [r.operations[i], r.operations[j]] = [r.operations[j], r.operations[i]];
  });

export const addOutput = (doc: Doc, runId: string, opId: string, o: Partial<Output> = {}) =>
  updateRun(doc, runId, (r, d) => {
    r.operations.find((x) => x.id === opId)?.outputs.push({ id: newId(d, 'e'), name: '', ...o });
  });
export const updateOutput = (doc: Doc, runId: string, opId: string, id: string, patch: Partial<Output>) =>
  updateRun(doc, runId, (r) => {
    const o = r.operations.find((x) => x.id === opId)?.outputs.find((x) => x.id === id);
    if (o) assign(o, patch);
  });
export const removeOutput = (doc: Doc, runId: string, opId: string, id: string) =>
  updateRun(doc, runId, (r) => {
    const op = r.operations.find((x) => x.id === opId);
    if (op) op.outputs = op.outputs.filter((x) => x.id !== id);
  });

/** 記録を足す。図は変わらないので描き直さない */
export function addEvent(doc: Doc, runId: string, e: Omit<RunEvent, 'id'>): Doc {
  if (!doc.runs?.[runId]) return doc;
  return edit(doc, (d) => {
    d.runs![runId].events.push({ ...e, id: newId(d, 'e') });
  });
}
export function updateEvent(doc: Doc, runId: string, id: string, patch: Partial<RunEvent>): Doc {
  if (!doc.runs?.[runId]) return doc;
  return edit(doc, (d) => {
    const e = d.runs![runId].events.find((x) => x.id === id);
    if (e) assign(e, patch);
  });
}
export function removeEvent(doc: Doc, runId: string, id: string): Doc {
  if (!doc.runs?.[runId]) return doc;
  return edit(doc, (d) => {
    const r = d.runs![runId];
    r.events = r.events.filter((x) => x.id !== id);
  });
}

/** 記録を消す（フロー図も消す） */
export function removeRun(doc: Doc, runId: string): Doc {
  if (!doc.runs?.[runId]) return doc;
  return edit(doc, (d) => {
    clearRun(d, runId);
    delete d.runs![runId];
  });
}

/** 記録のデータを消して、フロー図をただの図として残す */
export function dissolveRun(doc: Doc, runId: string): Doc {
  if (!doc.runs?.[runId]) return doc;
  return edit(doc, (d) => {
    for (const rec of [d.arrows, d.texts, d.shapes ?? {}]) for (const x of Object.values(rec)) if (x.ref === runId) delete x.ref;
    delete d.runs![runId];
  });
}

/** 記録の名前（題があれば題、無ければノート番号、どちらも無ければ「実験の記録」） */
export function runLabel(run: ProcessRun): string {
  return run.title?.trim() || (run.notebook?.trim() ? `実験 ${run.notebook.trim()}` : '実験の記録');
}

/** 仕込みの行の名前。スキームの化合物なら、今の番号か呼び名 */
export function materialName(doc: Doc, m: Material): string {
  return m.compoundId && doc.compounds?.[m.compoundId] ? compoundName(doc, m.compoundId, m.name) : m.name;
}

// ---------------------------------------------------------------- 記録を持ち運ぶ（プロジェクトに入れる）

/**
 * 記録を、ほかの図に置き直せる形で取り出す。スキームとのつながりは外し、
 * 化合物から引いていた名前は、今の番号か呼び名の文字にする
 */
export function packRun(doc: Doc, runId: string): ProcessRun | null {
  const r = doc.runs?.[runId];
  if (!r) return null;
  const run = structuredClone(r);
  delete run.schemeId;
  delete run.stepId;
  run.materials = run.materials.map((m) => {
    const out = { ...m, name: materialName(doc, m) };
    delete out.compoundId;
    return out;
  });
  if (run.product.compoundId) run.product = { ...run.product, name: compoundName(doc, run.product.compoundId, run.product.name) };
  delete run.product.compoundId;
  return run;
}

/**
 * 取り出した記録を、今の図の下に置く。id はすべて振り直す（同じ文書に何度置いてもよい）。
 * procedureOnly なら、仕込みの名前・役割・当量と操作の流れだけを残し、量・ロット・重さ・記録の行を外して今日の日付にする（次の回のひな形）
 */
export function placeRun(doc: Doc, saved: ProcessRun, procedureOnly = false, today = new Date()): { doc: Doc; runId: string } {
  let runId = '';
  const out = edit(doc, (d) => {
    runId = newId(d, 'e');
    const id = () => newId(d, 'e');
    const src = structuredClone(saved);
    const opMap = new Map<string, string>();
    const operations: Operation[] = src.operations.map((op) => {
      const nid = id();
      opMap.set(op.id, nid);
      const o: Operation = { ...op, id: nid, outputs: op.outputs.map((x) => ({ ...x, id: id() })) };
      if (procedureOnly) {
        delete o.carry;
        o.outputs = o.outputs.map(({ id: oid, name }) => ({ id: oid, name }));
      }
      return o;
    });
    const materials: Material[] = src.materials.map((m) => {
      const n: Material = { ...m, id: id(), ...(m.opId ? { opId: opMap.get(m.opId) } : {}) };
      if (procedureOnly) {
        delete n.amount;
        delete n.lot;
        delete n.assay;
      }
      return n;
    });
    const events: RunEvent[] = procedureOnly ? [] : src.events.map((e) => ({ ...e, id: id(), opId: opMap.get(e.opId) ?? e.opId }));
    const run: ProcessRun = {
      ...src,
      id: runId,
      materials,
      operations,
      events,
      origin: below(d),
      ...(procedureOnly ? { date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`, product: { name: src.product.name, ...(src.product.mw ? { mw: src.product.mw } : {}) } } : {}),
    };
    if (procedureOnly) delete run.notebook;
    d.runs = { ...(d.runs ?? {}), [runId]: run };
  });
  return { doc: renderRun(out, runId), runId };
}

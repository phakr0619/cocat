// スキームの編集の操作。どれもデータを変えてから renderScheme で描き直す
import { rectOfPoints, rectUnion, type Rect } from '../chem/geometry';
import type { Doc } from '../chem/model';
import { adjacency, edit, molecules, kindOf, newId } from '../chem/model';
import { analyzeScheme, type SchemeObject } from '../chem/reaction';
import { BOND_LEN } from '../chem/style';
import type { Compound, Reagent, Scheme, Step } from './model';
import { structureFrom } from './model';
import { renderScheme } from './layout';
import { getStyle, type SchemeStyle } from './style';

/** 選んだ物（無ければ全部）に掛かる、スキームでない分子の原子の組 */
export function freeFragments(doc: Doc, sel: Set<string>): string[][] {
  const frags = molecules(doc, adjacency(doc)).filter((f) => f.every((id) => !doc.atoms[id].ref));
  if (!sel.size) return frags;
  const atoms = new Set<string>();
  for (const id of sel) {
    if (kindOf(id) === 'atom') atoms.add(id);
    else if (doc.bonds[id]) {
      atoms.add(doc.bonds[id].a1);
      atoms.add(doc.bonds[id].a2);
    }
  }
  return frags.filter((f) => f.some((id) => atoms.has(id)));
}

function addCompound(d: Doc, atomIds: string[]): string {
  d.compounds ??= {};
  const id = newId(d, 'c');
  d.compounds[id] = { id, structure: structureFrom(d, atomIds) };
  return id;
}

function removeAtoms(d: Doc, atomIds: string[]) {
  const set = new Set(atomIds);
  for (const id of set) delete d.atoms[id];
  for (const b of Object.values(d.bonds)) if (set.has(b.a1) || set.has(b.a2)) delete d.bonds[b.id];
  for (const g of Object.values(d.groups)) if (g.atomIds.some((x) => set.has(x))) delete d.groups[g.id];
}

function boxOf(d: Doc, atomIds: string[]): Rect {
  return rectOfPoints(atomIds.map((id) => d.atoms[id]))!;
}

/** 文字を条件に振り分ける（温度・時間・収率・それ以外は試薬） */
export function parseConditionText(lines: string[]): Pick<Step, 'reagents' | 'solvent' | 'temp' | 'time' | 'yield'> {
  const out: Pick<Step, 'reagents' | 'solvent' | 'temp' | 'time' | 'yield'> = { reagents: [] };
  const SOLVENTS = /^(CH2Cl2|DCM|DMF|DMSO|THF|MeOH|EtOH|MeCN|CH3CN|toluene|PhMe|Et2O|EtOAc|AcOEt|dioxane|1,4-dioxane|H2O|acetone|hexane|CHCl3|DCE|NMP|DMA|pyridine|i-PrOH|t-BuOH|benzene)(\/.*)?$/i;
  for (const line of lines) {
    for (const raw of line.split(/,\s*/)) {
      const t = raw.trim();
      if (!t) continue;
      if (/^(-?\d+(\.\d+)?\s*°C|rt|r\.t\.|reflux|0 °C to rt|-?\d+ °C to rt)$/i.test(t)) out.temp = t;
      else if (/^\d+(\.\d+)?\s*(h|min|d|days?)$/i.test(t)) out.time = t;
      else if (/^\d+(\.\d+)?\s*%$/.test(t)) out.yield = parseFloat(t);
      else if (/^quant\.?$/i.test(t)) out.yield = 'quant.';
      else if (SOLVENTS.test(t) && !out.solvent) out.solvent = t;
      else {
        const m = t.match(/^(.*?)\s*\(?(\d+(?:\.\d+)?)\s*(?:equiv|eq)\.?\)?$/);
        out.reagents.push(m ? { text: m[1], equiv: parseFloat(m[2]) } : { text: t });
      }
    }
  }
  return out;
}

/** 「TFA (10 equiv), HATU 1.2 eq., DIPEA」を試薬の並びにする。括弧の中のカンマでは分けない */
export function parseReagents(text: string): Reagent[] {
  return text
    .split(/,\s*(?![^()]*\))/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = x.match(/^(.*?)\s*\(?\s*(\d+(?:\.\d+)?)\s*(?:equiv|eq)\.?\s*\)?$/i);
      return m && m[1] ? { text: m[1].trim(), equiv: parseFloat(m[2]) } : { text: x };
    });
}

/**
 * 描いた反応式（分子・矢印・文字）をスキームのデータにする。
 * 矢印の上下の文字は条件に、上下の分子は試薬の名前に（番号や呼び名が無いので SMILES は使わず「試薬」のまま）。
 */
export function schemeFromDrawing(doc: Doc, styleId = 'acs'): { doc: Doc; schemeId: string } | null {
  const free = { ...doc, atoms: Object.fromEntries(Object.entries(doc.atoms).filter(([, a]) => !a.ref)) };
  const steps = analyzeScheme({
    ...free,
    bonds: Object.fromEntries(Object.entries(doc.bonds).filter(([, b]) => free.atoms[b.a1] && free.atoms[b.a2])),
    arrows: Object.fromEntries(Object.entries(doc.arrows).filter(([, r]) => !r.ref)),
    texts: Object.fromEntries(Object.entries(doc.texts).filter(([, t]) => !t.ref)),
    pluses: Object.fromEntries(Object.entries(doc.pluses).filter(([, p]) => !p.ref)),
  });
  if (!steps.length) return null;
  let schemeId = '';
  const out = edit(doc, (d) => {
    const byKey = new Map<string, string>();
    const compoundFor = (o: SchemeObject) => {
      if (!byKey.has(o.key)) byKey.set(o.key, addCompound(d, o.atomIds));
      return byKey.get(o.key)!;
    };
    let box: Rect | null = null;
    const used: string[] = [];
    const data: Step[] = steps.map((st) => {
      const all = [...st.reactants, ...st.products, ...st.above, ...st.below, ...st.pluses];
      for (const o of all) {
        box = rectUnion(box, o.box);
        if (o.kind === 'fragment') used.push(...o.atomIds);
        else if (o.id) used.push(o.id);
      }
      const r = d.arrows[st.arrowId];
      box = rectUnion(box, { x1: Math.min(r.x1, r.x2), y1: r.y1 - 10, x2: Math.max(r.x1, r.x2), y2: r.y1 + 10 });
      used.push(st.arrowId);
      const lines = [...st.above, ...st.below].filter((o) => o.kind === 'text').map((o) => d.texts[o.id!].text);
      const cond = parseConditionText(lines);
      const extra: Reagent[] = [...st.above, ...st.below].filter((o) => o.kind === 'fragment').map(() => ({ text: 'reagent' }));
      return {
        id: newId(d, 'x'),
        from: st.reactants.filter((o) => o.kind === 'fragment').map(compoundFor),
        to: st.products.filter((o) => o.kind === 'fragment').map(compoundFor),
        ...cond,
        reagents: [...cond.reagents, ...extra],
      };
    });
    // 元の描いた物を消して、スキームとして置き直す
    const atomIds = used.filter((id) => kindOf(id) === 'atom');
    removeAtoms(d, atomIds);
    for (const id of used) {
      delete d.arrows[id];
      delete d.texts[id];
      delete d.pluses[id];
    }
    schemeId = newId(d, 's');
    d.schemes ??= {};
    const b = box ?? { x1: 40, y1: 40, x2: 40, y2: 40 };
    d.schemes[schemeId] = { id: schemeId, steps: data, styleId, origin: { x: b.x1, y: b.y1 } };
  });
  return { doc: renderScheme(out, schemeId), schemeId };
}

/** 選んだ分子からスキームを始める（まだ段が無いので、最初の段の基質として持っておく） */
export function startScheme(doc: Doc, atomIds: string[], styleId = 'acs'): { doc: Doc; schemeId: string } {
  let schemeId = '';
  const out = edit(doc, (d) => {
    const box = boxOf(d, atomIds);
    const cid = addCompound(d, atomIds);
    removeAtoms(d, atomIds);
    schemeId = newId(d, 's');
    d.schemes ??= {};
    d.schemes[schemeId] = {
      id: schemeId,
      steps: [{ id: newId(d, 'x'), from: [cid], to: [], reagents: [] }],
      styleId,
      origin: { x: box.x1, y: box.y1 - BOND_LEN },
    };
  });
  return { doc: renderScheme(out, schemeId), schemeId };
}

/** 選んだ分子を生成物にして、段を1つ足す（最後の段に生成物が無ければ、その段の生成物にする） */
export function addStepWithProduct(doc: Doc, schemeId: string, atomIds: string[]): Doc {
  const out = edit(doc, (d) => {
    const s = d.schemes![schemeId];
    const cid = addCompound(d, atomIds);
    removeAtoms(d, atomIds);
    const last = s.steps.at(-1);
    if (last && last.to.length === 0) last.to.push(cid);
    else s.steps.push({ id: newId(d, 'x'), from: last ? [...last.to] : [], to: [cid], reagents: [] });
  });
  return renderScheme(out, schemeId);
}

/** 選んだ分子を、ある段の基質に足す（カップリングの相手など） */
export function addSubstrate(doc: Doc, schemeId: string, stepIndex: number, atomIds: string[]): Doc {
  const out = edit(doc, (d) => {
    const cid = addCompound(d, atomIds);
    removeAtoms(d, atomIds);
    d.schemes![schemeId].steps[stepIndex].from.push(cid);
  });
  return renderScheme(out, schemeId);
}

/**
 * 化合物の構造を、選んだ分子（スキームに入っていない分子）に替える。枠（読めなかった名前・空の欄の仮の化合物）を、
 * キャンバスに描いた分子で埋めるのに使う。その化合物を使うスキームは、すべて描き直す
 */
export function replaceCompound(doc: Doc, compoundId: string, atomIds: string[]): Doc {
  if (!doc.compounds?.[compoundId] || !atomIds.length) return doc;
  let out = edit(doc, (d) => {
    d.compounds![compoundId].structure = structureFrom(d, atomIds);
    removeAtoms(d, atomIds);
  });
  for (const sid of Object.keys(out.schemes ?? {}))
    if (out.schemes![sid].steps.some((st) => [...st.from, ...st.to].includes(compoundId))) out = renderScheme(out, sid);
  return out;
}

/** 枠（構造の分からない仮の化合物: 原子が 1 つだけの「*」）か */
export function isPlaceholder(structure: { atoms: Record<string, { element: string }> }): boolean {
  const atoms = Object.values(structure.atoms);
  return atoms.length === 1 && atoms[0].element === '*';
}

export function updateStep(doc: Doc, schemeId: string, stepIndex: number, patch: Partial<Omit<Step, 'id' | 'from' | 'to'>>): Doc {
  const out = edit(doc, (d) => {
    Object.assign(d.schemes![schemeId].steps[stepIndex], patch);
  });
  return renderScheme(out, schemeId);
}

export function removeStep(doc: Doc, schemeId: string, stepIndex: number): Doc {
  const out = edit(doc, (d) => {
    const s = d.schemes![schemeId];
    s.steps.splice(stepIndex, 1);
    // 段を抜いたら、次の段の基質を前の段の生成物につなぎ直す
    const prev = s.steps[stepIndex - 1];
    const next = s.steps[stepIndex];
    if (prev && next) next.from = [...prev.to, ...next.from.filter((c) => !prev.to.includes(c) && s.steps.every((st) => !st.to.includes(c)))];
  });
  return renderScheme(out, schemeId);
}

export function updateCompound(doc: Doc, compoundId: string, patch: Partial<Pick<Compound, 'number' | 'nickname' | 'note'>>): Doc {
  let out = edit(doc, (d) => {
    Object.assign(d.compounds![compoundId], patch);
  });
  for (const s of Object.values(out.schemes ?? {})) {
    if (s.steps.some((st) => st.from.includes(compoundId) || st.to.includes(compoundId))) out = renderScheme(out, s.id);
  }
  return out;
}

/** 化合物の構造を差し替える（番号・呼び名はそのまま）。その化合物を使うスキームはすべて描き直す */
export function replaceCompoundStructure(doc: Doc, compoundId: string, structure: Compound['structure']): Doc {
  let out = edit(doc, (d) => {
    d.compounds![compoundId].structure = structuredClone(structure);
  });
  for (const s of Object.values(out.schemes ?? {})) {
    if (s.steps.some((st) => st.from.includes(compoundId) || st.to.includes(compoundId))) out = renderScheme(out, s.id);
  }
  return out;
}

export function setSchemeStyle(doc: Doc, schemeId: string, styleId: string): Doc {
  const out = edit(doc, (d) => {
    d.schemes![schemeId].styleId = styleId;
  });
  return renderScheme(out, schemeId);
}

/**
 * 書式を直す。プリセットを直そうとしたら、写しを文書の書式として作ってそちらを直す。
 * 同じ書式を使うスキームはすべて描き直す
 */
export function editSchemeStyle(doc: Doc, schemeId: string, patch: Partial<SchemeStyle>): Doc {
  let styleId = doc.schemes![schemeId].styleId;
  let out = edit(doc, (d) => {
    d.styles ??= {};
    if (!d.styles[styleId]) {
      const base = getStyle(styleId, d.styles);
      const id = `custom-${newId(d, 'x')}`;
      d.styles[id] = { ...base, id, name: `${base.name.replace(/（.*$/, '')}（変更）` };
      d.schemes![schemeId].styleId = id;
      styleId = id;
    }
    Object.assign(d.styles[styleId], patch);
  });
  for (const s of Object.values(out.schemes ?? {})) if (s.styleId === styleId) out = renderScheme(out, s.id);
  return out;
}

/** 書式（自分のテンプレートなど）を文書に入れて、スキームに使う */
export function applyStyle(doc: Doc, schemeId: string, style: SchemeStyle): Doc {
  const out = edit(doc, (d) => {
    d.styles ??= {};
    d.styles[style.id] = structuredClone(style);
    d.schemes![schemeId].styleId = style.id;
  });
  return renderScheme(out, schemeId);
}

/**
 * スキームを複製する（反応の使い回し）。化合物は同じものを使うので、番号・呼び名・構造を直すと両方に反映する。
 * 条件は写したうえで、複製の側だけ直せる。元の図の下に置く
 */
export function duplicateScheme(doc: Doc, schemeId: string): { doc: Doc; schemeId: string } {
  const src = doc.schemes![schemeId];
  const ys = [
    ...Object.values(doc.atoms).filter((a) => a.ref?.startsWith(`${schemeId}:`)).map((a) => a.y),
    ...Object.values(doc.texts).filter((t) => t.ref === schemeId).map((t) => t.y),
  ];
  const bottom = ys.length ? Math.max(...ys) : src.origin.y;
  let id = '';
  const out = edit(doc, (d) => {
    id = newId(d, 's');
    d.schemes![id] = {
      ...structuredClone(src),
      id,
      steps: src.steps.map((st) => ({ ...structuredClone(st), id: newId(d, 'x') })),
      origin: { x: src.origin.x, y: bottom + BOND_LEN * 3 },
    };
    // 複製は条件を変えるためのものなので、固定は写さない
    delete d.schemes![id].pinned;
  });
  return { doc: renderScheme(out, id), schemeId: id };
}

/**
 * スキームを固定する（反映させない版）。今の化合物と書式の写しで描くようにし、化合物の番号・構造や書式を直しても、この図は変わらない。
 * 発表に使った図を、後の変更から守るため
 */
export function pinScheme(doc: Doc, schemeId: string, now = new Date()): Doc {
  const s = doc.schemes?.[schemeId];
  if (!s || s.pinned || s.draft) return doc;
  const ids = [...new Set(s.steps.flatMap((st) => [...st.from, ...st.to]))];
  return edit(doc, (d) => {
    d.schemes![schemeId].pinned = {
      at: now.toISOString(),
      compounds: Object.fromEntries(ids.filter((c) => d.compounds?.[c]).map((c) => [c, structuredClone(d.compounds![c])])),
      style: structuredClone(getStyle(s.styleId, d.styles)),
    };
  });
}

/** 固定を外す。今の化合物と書式で描き直す */
export function unpinScheme(doc: Doc, schemeId: string): Doc {
  if (!doc.schemes?.[schemeId]?.pinned) return doc;
  return renderScheme(edit(doc, (d) => void delete d.schemes![schemeId].pinned), schemeId);
}

/** スキームをやめて、ただの図に戻す（データは消す。図はそのまま残す） */
export function dissolveScheme(doc: Doc, schemeId: string): Doc {
  return edit(doc, (d) => {
    const prefix = `${schemeId}:`;
    for (const a of Object.values(d.atoms)) if (a.ref?.startsWith(prefix)) delete a.ref;
    for (const rec of [d.arrows, d.texts, d.pluses] as Record<string, { ref?: string }>[]) {
      for (const o of Object.values(rec)) if (o.ref === schemeId) delete o.ref;
    }
    delete d.schemes![schemeId];
  });
}

/** 化合物番号を、スキームに出てくる順に振る（論文用）。prefix は「」なら 1, 2, 3 */
export function numberCompounds(doc: Doc, schemeId: string, start = 1, prefix = ''): Doc {
  const s = doc.schemes?.[schemeId];
  if (!s) return doc;
  const order: string[] = [];
  for (const st of s.steps) for (const c of [...st.from, ...st.to]) if (!order.includes(c)) order.push(c);
  const out = edit(doc, (d) => {
    order.forEach((c, i) => {
      d.compounds![c].number = `${prefix}${start + i}`;
    });
  });
  return renderScheme(out, schemeId);
}

/**
 * いくつかのスキームに通し番号を振る（並べた順に、化合物が初めて出てくる順）。
 * 2 つのスキームに出てくる化合物は 1 つの番号。番号が変わった化合物を使うスキームはすべて描き直す
 */
export function numberSchemesCompounds(doc: Doc, schemeIds: string[], start = 1, prefix = ''): Doc {
  const order: string[] = [];
  for (const sid of schemeIds) for (const st of doc.schemes?.[sid]?.steps ?? []) for (const c of [...st.from, ...st.to]) if (!order.includes(c)) order.push(c);
  if (!order.length) return doc;
  let out = edit(doc, (d) => {
    order.forEach((c, i) => {
      d.compounds![c].number = `${prefix}${start + i}`;
    });
  });
  for (const s of Object.values(out.schemes ?? {})) {
    if (s.steps.some((st) => [...st.from, ...st.to].some((c) => order.includes(c)))) out = renderScheme(out, s.id);
  }
  return out;
}

export type { Scheme };

/** 化学量論表の入力（基準の量・基質の当量・試薬の分子量と密度）。図は変わらないので描き直さない */
export function updateStoich(
  doc: Doc,
  schemeId: string,
  stepIndex: number,
  patch: { scale?: Step['scale']; substrateEquiv?: Record<string, number>; reagent?: { index: number; mw?: number; density?: number } },
): Doc {
  return edit(doc, (d) => {
    const st = d.schemes![schemeId].steps[stepIndex];
    if ('scale' in patch) st.scale = patch.scale;
    if (patch.substrateEquiv) st.substrateEquiv = { ...st.substrateEquiv, ...patch.substrateEquiv };
    if (patch.reagent) {
      const r = st.reagents[patch.reagent.index];
      if (r) {
        if ('mw' in patch.reagent) r.mw = patch.reagent.mw;
        if ('density' in patch.reagent) r.density = patch.reagent.density;
      }
    }
  });
}

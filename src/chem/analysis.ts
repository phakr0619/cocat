// 分析パネル: 組成式・分子量・精密質量・m/z・元素分析値・物性・R/S・構造チェック
// 分子量・精密質量・物性は RDKit.js、組成式と元素分析値はこちらで数える
import { expandedMolfile } from '../io/smiles';
import { implicitHydrogens, valenceErrors } from './hydrogens';
import { isotopePattern, type IsotopePeak } from './isotopes';
import type { Doc } from './model';
import { adjacency, kindOf, molecules, neighbors } from './model';
import { getRDKit } from './rdkit';
import { expandSalts } from './saltLabel';
import { getAbbr } from './abbreviations';
import { expandAbbr } from './abbrOps';

/** 元素分析に使う平均原子量（IUPAC の慣用値に近い、RDKit と同じ程度の値） */
const AVG_MASS: Record<string, number> = {
  H: 1.008, Li: 6.941, B: 10.812, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Na: 22.99, Mg: 24.305,
  Al: 26.982, Si: 28.086, P: 30.974, S: 32.067, Cl: 35.453, K: 39.098, Ca: 40.078, Fe: 55.845,
  Cu: 63.546, Zn: 65.39, Se: 78.96, Br: 79.904, Pd: 106.42, Ag: 107.868, Sn: 118.71, I: 126.904,
  Pt: 195.08, Au: 196.967, Hg: 200.59,
};

/** 陽子・電子の質量（m/z の計算用） */
const PROTON = 1.007276;
const NA_ION = 22.989218;
const ELECTRON = 0.000549;

export interface MzValue {
  label: string;
  value: number;
}

export interface Analysis {
  atomIds: string[];
  /** 組成式（Hill 式）。下付きにする数字を含む文字列、例 "C9H8O4" */
  formula: string;
  charge: number;
  mw: number;
  exactMass: number;
  mz: MzValue[];
  /** 元素分析値（重量 %） */
  ea: { element: string; pct: number }[];
  logP: number;
  tpsa: number;
  hbd: number;
  hba: number;
  rotatable: number;
  lipinskiViolations: number;
  /** 立体中心の R/S（元の文書の原子 id）。決まっていないものは '?' */
  stereo: { atomId: string; label: string }[];
  /** 二重結合の E/Z（元の文書の結合 id） */
  bondStereo: { bondId: string; label: string }[];
  unspecifiedStereo: number;
  /** 同位体のパターン（M・M+1・M+2… の高さ）。同位体を指定した原子や、表に無い元素があれば null */
  isotopes: IsotopePeak[] | null;
  warnings: { message: string; atomIds: string[] }[];
  /**
   * 塩など、離れた部分を持つときの成分（大きい順）。1 つだけなら無い。
   * saltFormula は成分を「·」でつないだ書き方（例 "C9H13NO·HCl"、イオンは "C9H14NO+·Cl−"）。m/z は炭素を含む成分ごとのもの
   */
  components?: { formula: string; charge: number; mw: number; count: number }[];
  saltFormula?: string;
}

export type AnalysisResult = Analysis | { atomIds: string[]; error: string };

/** 選択に掛かる分子（選択が空なら全部）の原子 id の組 */
export function targetFragments(doc: Doc, sel: Set<string>): string[][] {
  const frags = molecules(doc, adjacency(doc));
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

export function hillFormula(counts: Map<string, number>): string {
  const keys = [...counts.keys()].filter((k) => (counts.get(k) ?? 0) > 0);
  const hasC = counts.has('C');
  keys.sort((a, b) => {
    if (hasC) {
      const rank = (x: string) => (x === 'C' ? 0 : x === 'H' ? 1 : 2);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
    }
    return a.localeCompare(b);
  });
  return keys.map((k) => `${k}${counts.get(k)! > 1 ? counts.get(k) : ''}`).join('');
}

/** 炭素の無い成分は、Hill 式（ClH・H2O4S）より慣用の書き方（HCl・H2SO4）で書く */
const CONVENTIONAL: Record<string, string> = {
  ClH: 'HCl', BrH: 'HBr', HI: 'HI', FH: 'HF', H2O4S: 'H2SO4', H3O4P: 'H3PO4', HNO3: 'HNO3', H2O: 'H2O',
  ClNa: 'NaCl', ClK: 'KCl', BrNa: 'NaBr', BrK: 'KBr', ClLi: 'LiCl',
};

/** 成分の式の慣用の書き方（ClH → HCl）。無ければ Hill 式のまま */
export function conventionalFormula(formula: string): string {
  return CONVENTIONAL[formula] ?? formula;
}

function componentText(c: { formula: string; charge: number; count: number }): string {
  const f = conventionalFormula(c.formula);
  const ch = c.charge ? `${Math.abs(c.charge) > 1 ? Math.abs(c.charge) : ''}${c.charge > 0 ? '+' : '−'}` : '';
  const one = `${f}${ch}`;
  return c.count > 1 ? `(${one})${c.count}` : one;
}

/** 原子の組を、つながっている部分ごとに分ける（大きい順） */
function connectedParts(doc: Doc, atomIds: string[]): string[][] {
  const keep = new Set(atomIds);
  const adj = adjacency(doc);
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of atomIds) {
    if (seen.has(id)) continue;
    const part: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      part.push(cur);
      for (const n of neighbors(adj, cur)) if (keep.has(n) && !seen.has(n)) (seen.add(n), stack.push(n));
    }
    out.push(part);
  }
  return out.sort((a, b) => b.length - a.length);
}

export function analyzeFragment(doc0: Doc, atomIds0: string[]): AnalysisResult {
  // ラベルに書いた塩（NH2Cl）は、対イオンを原子にしてから数える（成分にも出る）
  let doc = doc0;
  let atomIds = atomIds0;
  if (atomIds0.some((id) => doc0.atoms[id]?.salt)) {
    const ex = expandSalts(doc0);
    doc = ex.doc;
    atomIds = [...atomIds0, ...atomIds0.map((id) => ex.counters.get(id)).filter((x): x is string => !!x)];
  }
  // 対イオンを持つ略号（BF3K・CO2Na）は、展開してから数える（成分に出す）
  const ionic = atomIds.filter((id) => doc.atoms[id]?.abbr && getAbbr(doc.atoms[id].abbr!)?.smiles.includes('.'));
  if (ionic.length) {
    for (const id of ionic) doc = expandAbbr(doc, id, false);
    const keep = new Set(atomIds);
    atomIds = molecules(doc).filter((m) => m.some((id) => keep.has(id))).flat();
  }
  const r = analyzeOne(doc, atomIds);
  if ('error' in r) return r;
  const parts = connectedParts(doc, atomIds);
  if (parts.length < 2) return r;
  // 塩: 成分ごとに数え、同じ成分（式と電荷が同じ）はまとめる
  const comps: NonNullable<Analysis['components']> = [];
  // m/z は成分ごと（イオンは M⁺・M⁻、中性の成分は [M+H]⁺）。質量分析では塩は成分に分かれて見えるため
  const mz: MzValue[] = [];
  for (const p of parts) {
    const c = analyzeOne(doc, p);
    if ('error' in c) return c;
    const same = comps.find((x) => x.formula === c.formula && x.charge === c.charge);
    if (same) {
      same.count++;
      continue;
    }
    comps.push({ formula: c.formula, charge: c.charge, mw: c.mw, count: 1 });
    // 小さい無機の成分（HCl・Na⁺ など）の m/z は出さない
    if (/C/.test(c.formula.replace(/Cl|Ca|Cs|Cu|Co|Cr|Cd/g, ''))) mz.push({ ...c.mz[0], label: `${c.mz[0].label}（${conventionalFormula(c.formula)}）` });
  }
  return {
    ...r,
    atomIds: atomIds0,
    components: comps,
    saltFormula: comps.map(componentText).join('·'),
    mz: mz.length ? mz : r.mz,
  };
}

function analyzeOne(doc: Doc, atomIds: string[]): AnalysisResult {
  const { molblock, order, expanded, ids } = expandedMolfile(doc, atomIds);
  const adj = adjacency(expanded);
  const counts = new Map<string, number>();
  let charge = 0;
  let labelled = false;
  const warnings: Analysis['warnings'] = [];
  for (const id of ids) {
    const a = expanded.atoms[id];
    if (a.element === '*') {
      warnings.push({ message: '元素の決まっていない原子（R）があります', atomIds: [id] });
      continue;
    }
    counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
    if (a.isotope) labelled = true;
    const h = implicitHydrogens(a, adj);
    if (h) counts.set('H', (counts.get('H') ?? 0) + h);
    charge += a.charge;
  }
  const bad = [...valenceErrors(doc)].filter((id) => atomIds.includes(id));
  if (bad.length) warnings.push({ message: '価数を超えている原子があります', atomIds: bad });

  const R = getRDKit();
  const m = R.get_mol(molblock, JSON.stringify({ removeHs: false }));
  if (!m) return { atomIds, error: 'RDKit が構造を読めません。価数を確かめてください' };
  try {
    const d = JSON.parse(m.get_descriptors()) as Record<string, number>;
    const tags = JSON.parse(m.get_stereo_tags()) as { CIP_atoms: [number, string][]; CIP_bonds?: [number, number, string][] };
    const bondStereo = (tags.CIP_bonds ?? [])
      .map(([i, j, label]) => {
        const b = Object.values(doc.bonds).find((x) => (x.a1 === order[i] && x.a2 === order[j]) || (x.a1 === order[j] && x.a2 === order[i]));
        return b ? { bondId: b.id, label: label.replace(/[()]/g, '') } : null;
      })
      .filter((x): x is { bondId: string; label: string } => !!x && (x.label === 'E' || x.label === 'Z'));
    const stereo = tags.CIP_atoms
      .map(([i, label]) => ({ atomId: order[i], label: label.replace(/[()]/g, '') }))
      .filter((s) => doc.atoms[s.atomId]);
    const unspecified = tags.CIP_atoms.filter(([, l]) => l === '(?)').length;
    if (unspecified) {
      warnings.push({
        message: `立体の決まっていない不斉中心が ${unspecified} 個あります`,
        atomIds: stereo.filter((s) => s.label === '?').map((s) => s.atomId),
      });
    }
    if (charge !== 0) warnings.push({ message: `全体の電荷が ${charge > 0 ? '+' : ''}${charge} です`, atomIds: [] });

    const exact = d.exactmw;
    // 電荷を持つ分子は、電子の質量を引いた（足した）値がその m/z
    const ion = exact - charge * ELECTRON;
    const mz: MzValue[] =
      charge !== 0
        ? [{ label: `M${charge > 0 ? '+' : '−'}`, value: ion / Math.abs(charge) }]
        : [
            { label: '[M+H]⁺', value: exact + PROTON },
            { label: '[M+Na]⁺', value: exact + NA_ION - ELECTRON },
            { label: '[M−H]⁻', value: exact - PROTON },
          ];
    let total = 0;
    for (const [el, n] of counts) total += (AVG_MASS[el] ?? NaN) * n;
    const ea = isFinite(total)
      ? hillOrder(counts).map((el) => ({ element: el, pct: ((AVG_MASS[el] * counts.get(el)!) / total) * 100 }))
      : [];
    const logP = d.CrippenClogP;
    const violations =
      Number(d.amw > 500) + Number(logP > 5) + Number(d.lipinskiHBD > 5) + Number(d.lipinskiHBA > 10);
    return {
      atomIds,
      formula: hillFormula(counts),
      charge,
      mw: d.amw,
      exactMass: exact,
      mz,
      ea,
      logP,
      tpsa: d.tpsa,
      hbd: d.NumHBD,
      hba: d.NumHBA,
      rotatable: d.NumRotatableBonds,
      lipinskiViolations: violations,
      stereo,
      bondStereo,
      unspecifiedStereo: unspecified,
      isotopes: labelled ? null : isotopePattern(counts),
      warnings,
    };
  } finally {
    m.delete();
  }
}

function hillOrder(counts: Map<string, number>): string[] {
  return hillFormula(counts).match(/[A-Z][a-z]?/g) ?? [];
}

export function formatAnalysisText(a: Analysis): string {
  const lines = [
    `Chemical Formula: ${a.formula}${a.charge ? (a.charge > 0 ? '+' : '-') : ''}`,
    `Exact Mass: ${a.exactMass.toFixed(4)}`,
    `Molecular Weight: ${a.mw.toFixed(2)}`,
  ];
  if (a.saltFormula) lines.splice(1, 0, `Salt: ${a.saltFormula}`);
  lines.push(`m/z: ${a.mz.map((z) => `${z.value.toFixed(4)} (${z.label})`).join(', ')}`);
  if (a.ea.length) lines.push(`Elemental Analysis: ${a.ea.map((e) => `${e.element}, ${e.pct.toFixed(2)}`).join('; ')}`);
  return lines.join('\n');
}

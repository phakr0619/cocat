// 化学量論表: 最初の基質の量と当量から、各試薬の mmol・重さ・体積と、生成物の理論収量を出す
import { analyzeFragment } from '../chem/analysis';
import type { Doc } from '../chem/model';
import { emptyDoc } from '../chem/model';
import type { Step } from './model';

/** よく使う試薬の分子量と密度（g/mL、液体だけ）。利用者が表で上書きできる */
export const REAGENT_DB: Record<string, { mw: number; density?: number }> = {
  TFA: { mw: 114.02, density: 1.489 },
  Et3N: { mw: 101.19, density: 0.726 },
  TEA: { mw: 101.19, density: 0.726 },
  DIPEA: { mw: 129.25, density: 0.742 },
  'i-Pr2NEt': { mw: 129.25, density: 0.742 },
  HATU: { mw: 380.23 },
  HBTU: { mw: 379.25 },
  'EDC·HCl': { mw: 191.7 },
  EDC: { mw: 155.24, density: 0.877 },
  HOBt: { mw: 135.12 },
  DCC: { mw: 206.33 },
  DMAP: { mw: 122.17 },
  Boc2O: { mw: 218.25, density: 0.95 },
  Ac2O: { mw: 102.09, density: 1.08 },
  AcCl: { mw: 78.5, density: 1.104 },
  pyridine: { mw: 79.1, density: 0.982 },
  MsCl: { mw: 114.55, density: 1.48 },
  TsCl: { mw: 190.65 },
  TBSCl: { mw: 150.72 },
  imidazole: { mw: 68.08 },
  TBAF: { mw: 261.46 },
  NaH: { mw: 24.0 },
  NaBH4: { mw: 37.83 },
  LiAlH4: { mw: 37.95 },
  K2CO3: { mw: 138.21 },
  Cs2CO3: { mw: 325.82 },
  NaHCO3: { mw: 84.01 },
  NaOH: { mw: 40.0 },
  LiOH: { mw: 23.95 },
  'LiOH·H2O': { mw: 41.96 },
  'Pd(PPh3)4': { mw: 1155.56 },
  'Pd/C': { mw: 106.42 },
  PCC: { mw: 215.56 },
  DMP: { mw: 424.14 },
  'm-CPBA': { mw: 172.57 },
  NBS: { mw: 177.98 },
  NIS: { mw: 224.98 },
  PPh3: { mw: 262.29 },
  DIAD: { mw: 202.21, density: 1.027 },
  DEAD: { mw: 174.15, density: 1.106 },
  BnBr: { mw: 171.04, density: 1.438 },
  MeI: { mw: 141.94, density: 2.28 },
  'TMSCl': { mw: 108.64, density: 0.856 },
  'SOCl2': { mw: 118.97, density: 1.638 },
  '(COCl)2': { mw: 126.93, density: 1.478 },
};

export interface StoichRow {
  kind: 'substrate' | 'reagent' | 'product';
  name: string;
  /** substrate・product なら化合物 id、reagent なら試薬の番号 */
  ref: string | number;
  mw?: number;
  density?: number;
  equiv?: number;
  mmol?: number;
  mg?: number;
  /** 液体なら体積（µL） */
  uL?: number;
}

function compoundMw(doc: Doc, compoundId: string): number | undefined {
  const c = doc.compounds?.[compoundId];
  if (!c || !Object.keys(c.structure.atoms).length) return undefined;
  const d = { ...emptyDoc(), atoms: c.structure.atoms, bonds: c.structure.bonds, groups: c.structure.groups };
  const r = analyzeFragment(d, Object.keys(d.atoms));
  return 'error' in r ? undefined : r.mw;
}

export function compoundName(doc: Doc, compoundId: string, fallback: string): string {
  const c = doc.compounds?.[compoundId];
  return c?.number?.trim() || c?.nickname?.trim() || fallback;
}

export function stoichTable(doc: Doc, step: Step): StoichRow[] {
  const rows: StoichRow[] = [];
  const firstId = step.from[0];
  const firstMw = firstId ? compoundMw(doc, firstId) : undefined;
  let base: number | undefined;
  if (step.scale && step.scale.value > 0) {
    base = step.scale.unit === 'mmol' ? step.scale.value : firstMw ? step.scale.value / firstMw : undefined;
  }
  const fill = (row: StoichRow): StoichRow => {
    if (base === undefined || row.equiv === undefined) return row;
    const mmol = base * row.equiv;
    const mg = row.mw ? mmol * row.mw : undefined;
    const uL = mg !== undefined && row.density ? mg / row.density : undefined;
    return { ...row, mmol, mg, uL };
  };
  step.from.forEach((cid, i) => {
    rows.push(
      fill({
        kind: 'substrate',
        name: compoundName(doc, cid, `基質 ${i + 1}`),
        ref: cid,
        mw: compoundMw(doc, cid),
        equiv: i === 0 ? 1 : (step.substrateEquiv?.[cid] ?? 1),
      }),
    );
  });
  step.reagents.forEach((r, i) => {
    const known = REAGENT_DB[r.text.trim()];
    rows.push(fill({ kind: 'reagent', name: r.text, ref: i, mw: r.mw ?? known?.mw, density: r.density ?? known?.density, equiv: r.equiv }));
  });
  step.to.forEach((cid, i) => {
    const row: StoichRow = { kind: 'product', name: compoundName(doc, cid, `生成物 ${i + 1}`), ref: cid, mw: compoundMw(doc, cid), equiv: 1 };
    // 生成物は理論収量（1:1）
    rows.push(fill(row));
  });
  return rows;
}

const fmt = (v: number | undefined, digits: number) => (v === undefined || !isFinite(v) ? '' : v.toFixed(digits));

/** Excel に貼れるタブ区切り */
export function stoichTsv(rows: StoichRow[]): string {
  const head = ['', '名前', 'MW', '当量', 'mmol', 'mg', 'µL'];
  const kind = { substrate: '基質', reagent: '試薬', product: '生成物（理論）' } as const;
  const lines = [head.join('\t')];
  for (const r of rows) lines.push([kind[r.kind], r.name, fmt(r.mw, 2), fmt(r.equiv, 2), fmt(r.mmol, 3), fmt(r.mg, 1), fmt(r.uL, 1)].join('\t'));
  return lines.join('\n');
}

/** 文章や Markdown に貼る表 */
export function stoichMarkdown(rows: StoichRow[]): string {
  const kind = { substrate: '基質', reagent: '試薬', product: '生成物（理論）' } as const;
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const lines = ['| | 名前 | MW | 当量 | mmol | mg | µL |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${kind[r.kind]} | ${cell(r.name)} | ${fmt(r.mw, 2)} | ${fmt(r.equiv, 2)} | ${fmt(r.mmol, 3)} | ${fmt(r.mg, 1)} | ${fmt(r.uL, 1)} |`);
  return lines.join('\n');
}

export { fmt as formatNumber };

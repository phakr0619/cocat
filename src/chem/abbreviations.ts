// 略号の表。smiles の [*] が結合する相手（外側）。
import { parseCondensed } from './condensed';
export interface AbbrDef {
  /** 結合が左から来るとき（ラベルが原子の右に伸びる）の表記 */
  label: string;
  /** 結合が右から来るときの表記 */
  reversed: string;
  smiles: string;
}

export const ABBREVIATIONS: Record<string, AbbrDef> = {
  Me: { label: 'Me', reversed: 'Me', smiles: '*C' },
  Et: { label: 'Et', reversed: 'Et', smiles: '*CC' },
  Pr: { label: 'Pr', reversed: 'Pr', smiles: '*CCC' },
  iPr: { label: 'iPr', reversed: 'iPr', smiles: '*C(C)C' },
  Bu: { label: 'Bu', reversed: 'Bu', smiles: '*CCCC' },
  tBu: { label: 'tBu', reversed: 'tBu', smiles: '*C(C)(C)C' },
  Ph: { label: 'Ph', reversed: 'Ph', smiles: '*c1ccccc1' },
  Bn: { label: 'Bn', reversed: 'Bn', smiles: '*Cc1ccccc1' },
  Bz: { label: 'Bz', reversed: 'Bz', smiles: '*C(=O)c1ccccc1' },
  Ac: { label: 'Ac', reversed: 'Ac', smiles: '*C(C)=O' },
  Piv: { label: 'Piv', reversed: 'Piv', smiles: '*C(=O)C(C)(C)C' },
  Boc: { label: 'Boc', reversed: 'Boc', smiles: '*C(=O)OC(C)(C)C' },
  Cbz: { label: 'Cbz', reversed: 'Cbz', smiles: '*C(=O)OCc1ccccc1' },
  Fmoc: { label: 'Fmoc', reversed: 'Fmoc', smiles: '*C(=O)OCC1c2ccccc2-c2ccccc12' },
  PMB: { label: 'PMB', reversed: 'PMB', smiles: '*Cc1ccc(OC)cc1' },
  TMS: { label: 'TMS', reversed: 'TMS', smiles: '*[Si](C)(C)C' },
  TBS: { label: 'TBS', reversed: 'TBS', smiles: '*[Si](C)(C)C(C)(C)C' },
  TIPS: { label: 'TIPS', reversed: 'TIPS', smiles: '*[Si](C(C)C)(C(C)C)C(C)C' },
  Ts: { label: 'Ts', reversed: 'Ts', smiles: '*S(=O)(=O)c1ccc(C)cc1' },
  Ms: { label: 'Ms', reversed: 'Ms', smiles: '*S(C)(=O)=O' },
  Tf: { label: 'Tf', reversed: 'Tf', smiles: '*S(=O)(=O)C(F)(F)F' },
  OMe: { label: 'OMe', reversed: 'MeO', smiles: '*OC' },
  OAc: { label: 'OAc', reversed: 'AcO', smiles: '*OC(C)=O' },
  CO2Me: { label: 'CO2Me', reversed: 'MeO2C', smiles: '*C(=O)OC' },
  CO2Et: { label: 'CO2Et', reversed: 'EtO2C', smiles: '*C(=O)OCC' },
  CO2H: { label: 'CO2H', reversed: 'HO2C', smiles: '*C(=O)O' },
  CN: { label: 'CN', reversed: 'NC', smiles: '*C#N' },
  NO2: { label: 'NO2', reversed: 'O2N', smiles: '*[N+](=O)[O-]' },
  CF3: { label: 'CF3', reversed: 'F3C', smiles: '*C(F)(F)F' },
  // 2026-10-29 に足したもの（保護基・脱離基・よく使う置換基）
  OTf: { label: 'OTf', reversed: 'TfO', smiles: '*OS(=O)(=O)C(F)(F)F' },
  OTs: { label: 'OTs', reversed: 'TsO', smiles: '*OS(=O)(=O)c1ccc(C)cc1' },
  OMs: { label: 'OMs', reversed: 'MsO', smiles: '*OS(C)(=O)=O' },
  OBn: { label: 'OBn', reversed: 'BnO', smiles: '*OCc1ccccc1' },
  OTBS: { label: 'OTBS', reversed: 'TBSO', smiles: '*O[Si](C)(C)C(C)(C)C' },
  NHBoc: { label: 'NHBoc', reversed: 'BocHN', smiles: '*NC(=O)OC(C)(C)C' },
  NHCbz: { label: 'NHCbz', reversed: 'CbzHN', smiles: '*NC(=O)OCc1ccccc1' },
  MOM: { label: 'MOM', reversed: 'MOM', smiles: '*COC' },
  SEM: { label: 'SEM', reversed: 'SEM', smiles: '*COCC[Si](C)(C)C' },
  THP: { label: 'THP', reversed: 'THP', smiles: '*C1CCCCO1' },
  Tr: { label: 'Tr', reversed: 'Tr', smiles: '*C(c1ccccc1)(c1ccccc1)c1ccccc1' },
  Alloc: { label: 'Alloc', reversed: 'Alloc', smiles: '*C(=O)OCC=C' },
  Troc: { label: 'Troc', reversed: 'Troc', smiles: '*C(=O)OCC(Cl)(Cl)Cl' },
  Ns: { label: 'Ns', reversed: 'Ns', smiles: '*S(=O)(=O)c1ccc(cc1)[N+](=O)[O-]' },
  TES: { label: 'TES', reversed: 'TES', smiles: '*[Si](CC)(CC)CC' },
  TBDPS: { label: 'TBDPS', reversed: 'TBDPS', smiles: '*[Si](c1ccccc1)(c1ccccc1)C(C)(C)C' },
  Bpin: { label: 'Bpin', reversed: 'pinB', smiles: '*B1OC(C)(C)C(C)(C)O1' },
  Cy: { label: 'Cy', reversed: 'Cy', smiles: '*C1CCCCC1' },
  Tol: { label: 'Tol', reversed: 'Tol', smiles: '*c1ccc(C)cc1' },
  Mes: { label: 'Mes', reversed: 'Mes', smiles: '*c1c(C)cc(C)cc1C' },
};

/** 入力された文字から略号を探す（大文字小文字と別名を許す） */
export function findAbbr(text: string): string | undefined {
  const t = text.trim();
  if (t in ABBREVIATIONS) return t;
  const alias: Record<string, string> = { TBDMS: 'TBS', 't-Bu': 'tBu', 'i-Pr': 'iPr', COOMe: 'CO2Me', COOEt: 'CO2Et', COOH: 'CO2H', Z: 'Cbz' };
  if (t in alias) return alias[t];
  for (const [k, v] of Object.entries(ABBREVIATIONS)) {
    if (k.toLowerCase() === t.toLowerCase() || v.reversed === t) return k;
  }
  return undefined;
}

/**
 * 利用者の辞書（略号の辞書の画面で足したもの）と、開いた文書が持つ辞書。名前 → * で結合する SMILES。
 * 標準の表より後、ラベルの読み方（縮約式）より先に引く。docs/abbreviation-labels.md
 */
const userAbbrs = new Map<string, AbbrDef>();
const condensedCache = new Map<string, AbbrDef | null>();
const listeners = new Set<() => void>();

/** 利用者の辞書を入れ替える（名前 → SMILES） */
export function setUserAbbrs(entries: Record<string, string>) {
  userAbbrs.clear();
  for (const [name, smiles] of Object.entries(entries)) userAbbrs.set(name, { label: name, reversed: reverseLabel(name), smiles });
  condensedCache.clear();
  listeners.forEach((l) => l());
}

export function userAbbrEntries(): Record<string, string> {
  return Object.fromEntries([...userAbbrs].map(([k, v]) => [k, v.smiles]));
}

/** 辞書が変わったら知らせる（図を描き直すため） */
export function subscribeAbbrs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 左向きの書き方。読めればその並べ直し、読めなければそのまま */
function reverseLabel(name: string): string {
  return parseCondensed(name, (n) => ABBREVIATIONS[n]?.smiles)?.reversed ?? name;
}

/** 置換基の表（ラベルの読み方に渡す）: 標準の表と利用者の辞書 */
export function groupSmiles(name: string): string | undefined {
  return ABBREVIATIONS[name]?.smiles ?? userAbbrs.get(name)?.smiles;
}

/** 略号の定義: 標準の表 → 利用者の辞書 → ラベルの読み方（NHFmoc・CH2OH・BF3K） */
export function getAbbr(name: string): AbbrDef | undefined {
  const def = ABBREVIATIONS[name] ?? userAbbrs.get(name);
  if (def) return def;
  if (!condensedCache.has(name)) {
    const c = parseCondensed(name, groupSmiles);
    // 右向きの書き方で読めたものだけを名前として使う（左向きの名前は resolveAbbr で右向きに直す）
    condensedCache.set(name, c && c.label === name ? { label: c.label, reversed: c.reversed, smiles: c.smiles } : null);
  }
  return condensedCache.get(name) ?? undefined;
}

/** 略号がどこから来たか（辞書の画面・知らせに使う） */
export function abbrSource(name: string): 'standard' | 'user' | 'label' | null {
  if (ABBREVIATIONS[name]) return 'standard';
  if (userAbbrs.has(name)) return 'user';
  return getAbbr(name) ? 'label' : null;
}

/**
 * 入力・読み込んだラベルを、略号の名前にする。標準の表（別名・左向きを含む）→ 利用者の辞書 → ラベルの読み方。
 * 左向きで書いたもの（HOH2C）は右向きの名前（CH2OH）にする。読めなければ undefined
 */
export function resolveAbbr(text: string): string | undefined {
  const t = text.trim();
  const std = findAbbr(t);
  if (std) return std;
  if (userAbbrs.has(t)) return t;
  for (const [k, v] of userAbbrs) if (v.reversed === t) return k;
  const c = parseCondensed(t, groupSmiles);
  return c ? c.label : undefined;
}

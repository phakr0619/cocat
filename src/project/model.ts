// プロジェクト: 化合物のライブラリと、保存した図を入れる箱（ブラウザの中に保存）
import type { Doc } from '../chem/model';
import type { Structure } from '../scheme/model';
import type { ProcessRun } from '../process/model';
import type { TablePackage } from '../table/ops';

export interface LibraryCompound {
  id: string;
  structure: Structure;
  /** 正規化した SMILES（検索と、キャンバスの分子との比較に使う） */
  smiles: string;
  /** 同じ構造かどうかの判定に使う */
  inchikey: string;
  formula: string;
  mw: number;
  number?: string;
  nickname?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedFigure {
  id: string;
  name: string;
  doc: Doc;
  savedAt: string;
}

/** 保存した検討表（表の上の反応式ごと）。ほかの図に置き直せる */
export interface SavedTable extends TablePackage {
  id: string;
  name: string;
  savedAt: string;
}

/** 保存した実験の記録。ほかの図に置き直せる（スキームとのつながりは外してある） */
export interface SavedRun {
  id: string;
  name: string;
  run: ProcessRun;
  savedAt: string;
}

/** 部品: よく置く部分構造（母核・保護基）。R のラベルの原子がつなぐ点 */
export interface Part {
  id: string;
  name: string;
  structure: Structure;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  compounds: Record<string, LibraryCompound>;
  figures: Record<string, SavedFigure>;
  /** 無ければ空（部品を足す前に作ったプロジェクト） */
  parts?: Record<string, Part>;
  /** 無ければ空（検討表を入れる前に作ったプロジェクト） */
  tables?: Record<string, SavedTable>;
  /** 無ければ空（実験の記録を入れる前に作ったプロジェクト） */
  runs?: Record<string, SavedRun>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  compoundCount: number;
}

export function newProject(name: string, now = new Date()): Project {
  const t = now.toISOString();
  return { id: `prj-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, createdAt: t, updatedAt: t, compounds: {}, figures: {}, parts: {}, tables: {}, runs: {} };
}

export const summarize = (p: Project): ProjectSummary => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, compoundCount: Object.keys(p.compounds).length });

/** 一覧や図に出す名前（番号 → 呼び名 → 組成式の順） */
export function displayName(c: LibraryCompound): string {
  return c.number?.trim() || c.nickname?.trim() || c.formula;
}

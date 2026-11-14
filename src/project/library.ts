// 化合物のライブラリの操作。プロジェクトも文書も、元を変えずに新しいものを返す
import { analyzeFragment } from '../chem/analysis';
import type { P } from '../chem/geometry';
import type { Doc } from '../chem/model';
import { adjacency, edit, emptyDoc, molecules, newId, remapUnits } from '../chem/model';
import { getRDKit } from '../chem/rdkit';
import { expandedMolfile } from '../io/smiles';
import { writeMolfile } from '../io/molfile';
import { expandAllAbbr } from '../chem/abbrOps';
import { structureFrom, type Structure } from '../scheme/model';
import { packTable } from '../table/ops';
import { packRun } from '../process/ops';
import type { LibraryCompound, Part, Project, SavedFigure, SavedRun, SavedTable } from './model';

export interface Identity {
  smiles: string;
  inchikey: string;
  formula: string;
  mw: number;
}

/** 分子の正規化した SMILES・InChIKey・組成式・分子量。解釈できなければ null */
export function identify(doc: Doc, atomIds: string[]): Identity | null {
  const { molblock } = expandedMolfile(doc, atomIds);
  const R = getRDKit();
  const m = R.get_mol(molblock, JSON.stringify({ removeHs: false }));
  if (!m) return null;
  try {
    // rac・rel の組があれば、CXSMILES と、InChIKey に組の書き方を足したものを使う（InChI は rac と絶対配置を区別しないため）
    const groups = /MDLV30\/STE(RAC|REL)/.test(molblock);
    const smiles = groups ? m.get_cxsmiles(JSON.stringify({ CX_ENHANCEDSTEREO: true })) : m.get_smiles();
    const inchi = m.get_inchi();
    const base = inchi ? R.get_inchikey_for_inchi(inchi) : `SMILES:${smiles}`;
    const inchikey = groups ? `${base}|${smiles.split('|')[1] ?? ''}` : base;
    const a = analyzeFragment(doc, atomIds);
    if ('error' in a) return null;
    return { smiles, inchikey, formula: a.formula, mw: a.mw };
  } finally {
    m.delete();
  }
}

function structureDoc(s: Structure): Doc {
  return { ...emptyDoc(), atoms: s.atoms, bonds: s.bonds, groups: s.groups };
}

const touch = (p: Project): Project => ({ ...p, updatedAt: new Date().toISOString() });

export type RegisterResult = { project: Project; id: string } | { duplicateOf: string };

/**
 * キャンバスの分子をライブラリに登録する。同じ構造（InChIKey）が既にあれば登録せず知らせる。
 * allowDuplicate なら、同じ構造でも別の化合物として登録する
 */
export function registerCompound(project: Project, doc: Doc, atomIds: string[], allowDuplicate = false): RegisterResult | null {
  const ident = identify(doc, atomIds);
  if (!ident) return null;
  if (!allowDuplicate) {
    const dup = Object.values(project.compounds).find((c) => c.inchikey === ident.inchikey);
    if (dup) return { duplicateOf: dup.id };
  }
  const now = new Date().toISOString();
  const id = `lc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const c: LibraryCompound = { id, structure: structureFrom(doc, atomIds), ...ident, createdAt: now, updatedAt: now };
  // ライブラリの側は、つながりの印（lib）を持たない
  for (const a of Object.values(c.structure.atoms)) delete a.lib;
  return { project: touch({ ...project, compounds: { ...project.compounds, [id]: c } }), id };
}

/** ライブラリの化合物の構造を、キャンバスの分子で置き換える */
export function updateLibraryStructure(project: Project, id: string, doc: Doc, atomIds: string[]): Project {
  const ident = identify(doc, atomIds);
  const old = project.compounds[id];
  if (!ident || !old) return project;
  const structure = structureFrom(doc, atomIds);
  for (const a of Object.values(structure.atoms)) delete a.lib;
  return touch({ ...project, compounds: { ...project.compounds, [id]: { ...old, ...ident, structure, updatedAt: new Date().toISOString() } } });
}

export function updateLibraryInfo(project: Project, id: string, patch: Partial<Pick<LibraryCompound, 'number' | 'nickname' | 'note'>>): Project {
  const old = project.compounds[id];
  if (!old) return project;
  return touch({ ...project, compounds: { ...project.compounds, [id]: { ...old, ...patch, updatedAt: new Date().toISOString() } } });
}

export function removeLibraryCompound(project: Project, id: string): Project {
  const compounds = { ...project.compounds };
  delete compounds[id];
  return touch({ ...project, compounds });
}

/** ライブラリの化合物をキャンバスの at（中心）に置く。置いた原子にはつながりの印が付く */
export function placeCompound(doc: Doc, c: LibraryCompound, at: P): { doc: Doc; ids: Set<string> } {
  const ids = new Set<string>();
  const out = edit(doc, (d) => {
    const map = new Map<string, string>();
    for (const a of Object.values(c.structure.atoms)) {
      const id = newId(d, 'a');
      map.set(a.id, id);
      d.atoms[id] = { ...a, id, x: a.x + at.x, y: a.y + at.y, lib: c.id };
      delete d.atoms[id].ref;
      ids.add(id);
    }
    remapUnits([...map.values()].map((id) => d.atoms[id]), () => newId(d, 'u'));
    for (const b of Object.values(c.structure.bonds)) {
      const id = newId(d, 'b');
      d.bonds[id] = { ...b, id, a1: map.get(b.a1)!, a2: map.get(b.a2)! };
      ids.add(id);
    }
    for (const g of Object.values(c.structure.groups)) {
      const id = newId(d, 'g');
      d.groups[id] = { ...g, id, atomIds: g.atomIds.map((x) => map.get(x)!), attachId: map.get(g.attachId)! };
    }
  });
  return { doc: out, ids };
}

/** 分子にライブラリとのつながりの印を付ける・外す */
export function setLink(doc: Doc, atomIds: string[], compoundId: string | null): Doc {
  return edit(doc, (d) => {
    for (const id of atomIds) {
      if (!d.atoms[id]) continue;
      if (compoundId) d.atoms[id].lib = compoundId;
      else delete d.atoms[id].lib;
    }
  });
}

export interface LinkedFragment {
  atomIds: string[];
  compoundId: string;
  /** same: ライブラリと同じ構造、changed: キャンバスで直された、missing: ライブラリから消された */
  status: 'same' | 'changed' | 'missing';
}

/** キャンバスの中で、ライブラリとつながっている分子と、その状態 */
export function linkedFragments(doc: Doc, project: Project | null): LinkedFragment[] {
  const out: LinkedFragment[] = [];
  for (const f of molecules(doc, adjacency(doc))) {
    const lib = f.map((id) => doc.atoms[id].lib).find(Boolean);
    if (!lib) continue;
    const c = project?.compounds[lib];
    if (!c) {
      out.push({ atomIds: f, compoundId: lib, status: 'missing' });
      continue;
    }
    const ident = identify(doc, f);
    out.push({ atomIds: f, compoundId: lib, status: ident && ident.smiles === c.smiles ? 'same' : 'changed' });
  }
  return out;
}

/** 文字（番号・呼び名・メモ・組成式・SMILES）と、部分構造（キャンバスの分子）で探す */
export function searchCompounds(project: Project, text: string, query?: { doc: Doc; atomIds: string[] }): LibraryCompound[] {
  const t = text.trim().toLowerCase();
  let list = Object.values(project.compounds);
  if (t) {
    list = list.filter((c) => [c.number, c.nickname, c.note, c.formula, c.smiles].some((v) => v?.toLowerCase().includes(t)));
  }
  if (query && query.atomIds.length) {
    const R = getRDKit();
    const q = R.get_mol(expandedMolfile(query.doc, query.atomIds).molblock);
    if (q) {
      try {
        list = list.filter((c) => {
          const m = R.get_mol(c.smiles);
          if (!m) return false;
          try {
            return m.get_substruct_match(q) !== '{}';
          } finally {
            m.delete();
          }
        });
      } finally {
        q.delete();
      }
    }
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveFigure(project: Project, name: string, doc: Doc, overwriteId?: string): { project: Project; id: string } {
  const id = overwriteId ?? `fg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const fig: SavedFigure = { id, name, doc: structuredClone(doc), savedAt: new Date().toISOString() };
  return { project: touch({ ...project, figures: { ...project.figures, [id]: fig } }), id };
}

export function removeFigure(project: Project, id: string): Project {
  const figures = { ...project.figures };
  delete figures[id];
  return touch({ ...project, figures });
}

// ---------------------------------------------------------------- 検討表

/** 文書の検討表を、反応式ごとプロジェクトに入れる。overwriteId なら上書き */
export function saveTable(project: Project, doc: Doc, tableId: string, name: string, overwriteId?: string): { project: Project; id: string } | null {
  const pkg = packTable(doc, tableId);
  if (!pkg) return null;
  const id = overwriteId ?? `tb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const saved: SavedTable = { ...pkg, id, name: name.trim() || '検討表', savedAt: new Date().toISOString() };
  return { project: touch({ ...project, tables: { ...(project.tables ?? {}), [id]: saved } }), id };
}

export function removeSavedTable(project: Project, id: string): Project {
  const tables = { ...(project.tables ?? {}) };
  delete tables[id];
  return touch({ ...project, tables });
}

// ---------------------------------------------------------------- 実験の記録

/** 文書の実験の記録をプロジェクトに入れる。overwriteId なら上書き */
export function saveRun(project: Project, doc: Doc, runId: string, name: string, overwriteId?: string): { project: Project; id: string } | null {
  const run = packRun(doc, runId);
  if (!run) return null;
  const id = overwriteId ?? `rn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const saved: SavedRun = { id, name: name.trim() || '実験の記録', run, savedAt: new Date().toISOString() };
  return { project: touch({ ...project, runs: { ...(project.runs ?? {}), [id]: saved } }), id };
}

export function removeSavedRun(project: Project, id: string): Project {
  const runs = { ...(project.runs ?? {}) };
  delete runs[id];
  return touch({ ...project, runs });
}

// ---------------------------------------------------------------- 部品

/** 選んだ分子を部品にする（つなぐ点は R のラベルの原子） */
export function addPart(project: Project, name: string, doc: Doc, atomIds: string[]): { project: Project; id: string } {
  const id = `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const part: Part = { id, name: name.trim() || '部品', structure: structureFrom(doc, atomIds), createdAt: new Date().toISOString() };
  for (const a of Object.values(part.structure.atoms)) {
    delete a.lib;
    // SMILES の * で示したつなぐ点は、R のラベルにして見えるようにする
    if (a.element === '*' && !a.abbr) a.abbr = 'R';
  }
  return { project: touch({ ...project, parts: { ...(project.parts ?? {}), [id]: part } }), id };
}

export function removePart(project: Project, id: string): Project {
  const parts = { ...(project.parts ?? {}) };
  delete parts[id];
  return touch({ ...project, parts });
}

// ---------------------------------------------------------------- 書き出し・読み込み

/** 化合物の SDF（番号・呼び名・メモをデータの項目として付ける）。ほかのソフトへ持っていける */
export function exportSdf(project: Project): string {
  const blocks: string[] = [];
  for (const c of Object.values(project.compounds)) {
    const d = expandAllAbbr(structureDoc(c.structure));
    const mb = writeMolfile(d).molblock.replace(/^[^\n]*\n/, `${c.number ?? c.nickname ?? c.id}\n`);
    const fields: [string, string | undefined][] = [
      ['number', c.number],
      ['nickname', c.nickname],
      ['note', c.note],
      ['smiles', c.smiles],
    ];
    const data = fields.filter(([, v]) => v).map(([k, v]) => `> <${k}>\n${v}\n`).join('\n');
    blocks.push(`${mb}${data ? `${data}\n` : ''}$$$$`);
  }
  return blocks.join('\n') + '\n';
}

export const BUNDLE_FORMAT = 'ai-chem-editor-project';

/** プロジェクト一式（元に戻せる JSON） */
export function exportBundle(project: Project): string {
  return JSON.stringify({ format: BUNDLE_FORMAT, version: 1, project }, null, 1);
}

/** 読み込むと別のプロジェクトとして足す（id を振り直す） */
export function importBundle(text: string): Project {
  const data = JSON.parse(text) as { format?: string; project?: Project };
  if (data.format !== BUNDLE_FORMAT || !data.project) throw new Error('プロジェクトのファイルではありません');
  const p = data.project;
  return { ...p, id: `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, compounds: p.compounds ?? {}, figures: p.figures ?? {}, parts: p.parts ?? {}, tables: p.tables ?? {}, runs: p.runs ?? {} };
}

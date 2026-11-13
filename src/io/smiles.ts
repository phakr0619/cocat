// SMILES の書き出しと読み込み（RDKit）
import { expandAllAbbr } from '../chem/abbrOps';
import { expandSalts } from '../chem/saltLabel';
import { readStereoGroups, withStereoGroups } from '../chem/stereoGroups';
import type { Doc } from '../chem/model';
import { molecules } from '../chem/model';
import { reactionSteps } from '../chem/reactionSteps';
import { withMol, getRDKit } from '../chem/rdkit';
import { addParsedMol, parseMolfile, writeMolfile } from './molfile';

export interface SmilesResult {
  smiles: string | null;
  error?: string;
}

/**
 * 略号を展開したうえで、atomIds の分子（無ければ全部）の Molfile を作る。
 * order は Molfile の原子の順の id（展開で増えた原子は、元の doc に無い id）
 */
export function expandedMolfile(doc0: Doc, atomIds?: string[]): { molblock: string; order: string[]; expanded: Doc; ids: string[] } {
  // ラベルに書いた塩（NH2Cl）は、対イオンを原子にしてから書く
  const salts = expandSalts(doc0);
  const doc = salts.doc;
  const ids = atomIds ? [...atomIds, ...atomIds.map((id) => salts.counters.get(id)).filter((x): x is string => !!x)] : Object.keys(doc.atoms);
  let ex = doc;
  const keep = new Set(ids);
  if (ids.some((id) => doc.atoms[id]?.abbr)) {
    ex = expandAllAbbr(doc);
    // 展開で増えた原子のうち、選んだ原子とつながっているものだけを含める
    // 対イオン（BF3K の K⁺）はまとまりとしてつながるので、molecules で数える
    for (const f of molecules(ex)) if (f.some((id) => keep.has(id))) f.forEach((id) => keep.add(id));
  }
  const kept = Object.keys(ex.atoms).filter((id) => keep.has(id));
  const { molblock, order } = writeMolfile(ex, kept);
  // rac・rel の組があれば V3000 にして組を足す
  return { molblock: withStereoGroups(molblock, order, ex), order, expanded: ex, ids: kept };
}

/** doc の分子（atomIds があればその原子だけ）を SMILES にする */
export function docToSmiles(doc: Doc, atomIds?: string[], opts: { cx?: boolean } = {}): SmilesResult {
  const ids = atomIds ?? Object.keys(doc.atoms);
  if (ids.length === 0) return { smiles: '' };
  const { molblock } = expandedMolfile(doc, ids);
  // rac・rel の組があれば CXSMILES（C[C@H](N)[C@H](C)O |&1:1,3|）で書く。反応 SMILES の中では組を書けないので、cx: false で外す
  const cx = opts.cx !== false && /MDLV30\/STE(RAC|REL)/.test(molblock);
  const smi = withMol(molblock, (m) => (cx ? m.get_cxsmiles(JSON.stringify({ CX_ENHANCEDSTEREO: true })) : m.get_smiles()));
  if (smi === null) return { smiles: null, error: 'RDKit が構造を読めません。価数を確かめてください' };
  return { smiles: smi };
}

/** SMILES を正規化する（テストの比較用）。読めなければ null */
export function canonical(smiles: string): string | null {
  return withMol(smiles, (m) => m.get_smiles());
}

/** SMILES（. 区切りの複数でもよい）を読み、2D 座標を付けて doc に足す */
export function addSmiles(doc: Doc, smiles: string, center: { x: number; y: number }): { doc: Doc; atomIds: string[] } {
  const R = getRDKit();
  const m = R.get_mol(smiles.trim());
  if (!m) throw new Error(`SMILES を読めません: ${smiles}`);
  try {
    m.set_new_coords();
    const mb = m.get_v2Kmolblock();
    return withGroupsFrom(m.get_json(), addParsedMol(doc, parseMolfile(mb), center));
  } finally {
    m.delete();
  }
}

/**
 * 文書全体の SMILES。矢印があれば段ごとの反応 SMILES（反応物>矢印の上下の分子>生成物）を改行で並べる。
 */
export function documentSmiles(doc: Doc): SmilesResult {
  const steps = reactionSteps(doc);
  if (!steps.length) return docToSmiles(doc);
  const lines: string[] = [];
  for (const st of steps) {
    const part = (objs: { kind: string; atomIds: string[] }[]) => {
      const out: string[] = [];
      for (const o of objs) {
        if (o.kind !== 'fragment') continue;
        const r = docToSmiles(doc, o.atomIds, { cx: false });
        if (r.smiles === null) throw new Error(r.error);
        out.push(r.smiles);
      }
      return out.join('.');
    };
    try {
      lines.push(`${part(st.reactants)}>${part([...st.above, ...st.below])}>${part(st.products)}`);
    } catch (e) {
      return { smiles: null, error: String((e as Error).message ?? e) };
    }
  }
  return { smiles: lines.join('\n') };
}

/** RDKit で読んだ分子の rac・rel の組を、doc に足した原子（atomIds は RDKit の原子の順）に写す */
export function withGroupsFrom(json: string, r: { doc: Doc; atomIds: string[] }): { doc: Doc; atomIds: string[] } {
  const groups = readStereoGroups(json);
  if (!groups.size) return r;
  for (const [i, g] of groups) {
    const id = r.atomIds[i];
    if (id && r.doc.atoms[id]) r.doc.atoms[id].stereoGroup = g;
  }
  return r;
}

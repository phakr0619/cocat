// 拡張立体表記（rac・rel）: 不斉中心を「絶対配置（abs）」「ラセミ（and、&n）」「相対配置（or、orN）」の組に分ける。
// Molfile V3000 の MDLV30/STEABS・STERAC・STEREL、CXSMILES の |&1:…,o1:…|、CDXML の EnhancedStereoType と同じ考え方。docs/salt-design.md
import { freeDirection } from '../render/labels';
import { add, fromAngle, rectOfPoints } from './geometry';
import type { Doc, StereoGroupType } from './model';
import { adjacency, edit, kindOf, molecules } from './model';
import { getRDKit } from './rdkit';

/** くさび・破線のくさびの細い側（a1）の原子 = 立体を描いた不斉中心 */
export function stereoCenters(doc: Doc, atomIds?: Iterable<string>): string[] {
  const keep = atomIds ? new Set(atomIds) : null;
  const out = new Set<string>();
  for (const b of Object.values(doc.bonds)) {
    if (b.stereo !== 'wedge' && b.stereo !== 'hash') continue;
    if (!keep || keep.has(b.a1)) out.add(b.a1);
  }
  return [...out];
}

/**
 * 選んだ不斉中心（選んだ原子に不斉中心が無ければ、選んだ分子の不斉中心すべて）の表し方を変える。
 * and・or は、同じ分子のほかの組と重ならない番号にする（すでに同じ組なら番号はそのまま）
 */
export function setStereoGroup(doc: Doc, sel: Set<string>, kind: 'abs' | StereoGroupType): Doc {
  const touched = new Set<string>();
  for (const id of sel) {
    if (kindOf(id) === 'atom') touched.add(id);
    else if (doc.bonds[id]) touched.add(doc.bonds[id].a1).add(doc.bonds[id].a2);
  }
  const mols = molecules(doc).filter((m) => m.some((id) => touched.has(id)));
  const inMols = mols.flat();
  const centers = stereoCenters(doc, inMols);
  const picked = centers.filter((id) => sel.has(id));
  const targets = picked.length ? picked : centers;
  if (!targets.length) return doc;
  return edit(doc, (d) => {
    if (kind === 'abs') {
      for (const id of targets) delete d.atoms[id].stereoGroup;
      return;
    }
    const cur = targets.map((id) => d.atoms[id].stereoGroup);
    if (cur.every((g) => g && g.type === kind && g.n === cur[0]!.n)) return;
    const others = inMols.filter((id) => !targets.includes(id)).map((id) => d.atoms[id].stereoGroup).filter((g) => g?.type === kind);
    const n = Math.max(0, ...others.map((g) => g!.n)) + 1;
    for (const id of targets) d.atoms[id].stereoGroup = { type: kind, n };
  });
}

export interface StereoGroupLabel {
  x: number;
  y: number;
  text: string;
  /** 分子全体の印（rac・rel）なら分子の原子 id、中心ごとの印なら中心の原子 id */
  owner: string;
}

/**
 * 図に出す印。分子の不斉中心がすべて 1 つの組なら、分子の下に「rac」「rel」を 1 つ出す（論文の書き方）。
 * 組が混ざっていれば、中心ごとに ChemDraw と同じ「&1」「or1」「abs」を出す
 */
export function stereoGroupLabels(doc: Doc): StereoGroupLabel[] {
  if (!Object.values(doc.atoms).some((a) => a.stereoGroup)) return [];
  const adj = adjacency(doc);
  const out: StereoGroupLabel[] = [];
  for (const mol of molecules(doc, adj)) {
    const centers = stereoCenters(doc, mol);
    const groups = centers.map((id) => doc.atoms[id].stereoGroup);
    if (!groups.some(Boolean)) continue;
    const g0 = groups[0];
    if (g0 && groups.every((g) => g && g.type === g0.type && g.n === g0.n)) {
      const box = rectOfPoints(mol.map((id) => doc.atoms[id]))!;
      out.push({ x: (box.x1 + box.x2) / 2, y: box.y2 + 14, text: g0.type === 'and' ? 'rac' : 'rel', owner: mol[0] });
      continue;
    }
    for (const id of centers) {
      const a = doc.atoms[id];
      const g = a.stereoGroup;
      const p = add(a, fromAngle(freeDirection(a, doc, adj), 9));
      out.push({ x: p.x, y: p.y, text: g ? `${g.type === 'and' ? '&' : 'or'}${g.n}` : 'abs', owner: id });
    }
  }
  return out;
}

/**
 * Molfile（V2000）に、order の原子の組を足す。組が無ければそのまま返す。
 * 組は V2000 に書けないので、RDKit で V3000 にして、MDLV30/STEABS・STERAC・STEREL の COLLECTION を足す
 */
export function withStereoGroups(molblock: string, order: string[], doc: Doc): string {
  const groups = new Map<string, number[]>();
  const abs: number[] = [];
  // くさびを消して不斉中心でなくなった原子の組は書かない
  const centers = new Set(stereoCenters(doc, order));
  order.forEach((id, i) => {
    const g = doc.atoms[id]?.stereoGroup;
    if (!g || !centers.has(id)) return;
    const key = `${g.type === 'and' ? 'STERAC' : 'STEREL'}${g.n}`;
    groups.set(key, [...(groups.get(key) ?? []), i + 1]);
  });
  if (!groups.size) return molblock;
  // 組に入れていない不斉中心は abs にする（RDKit と同じ決まり）
  order.forEach((id, i) => centers.has(id) && !doc.atoms[id].stereoGroup && abs.push(i + 1));
  const m = getRDKit().get_mol(molblock, JSON.stringify({ removeHs: false }));
  if (!m) return molblock;
  let v3: string;
  try {
    v3 = m.get_v3Kmolblock();
  } finally {
    m.delete();
  }
  const lines = ['M  V30 BEGIN COLLECTION'];
  const coll = (name: string, idx: number[]) => lines.push(...wrapV30(`MDLV30/${name} ATOMS=(${idx.length} ${idx.join(' ')})`));
  if (abs.length) coll('STEABS', abs);
  for (const [k, idx] of groups) coll(k, idx);
  lines.push('M  V30 END COLLECTION');
  return v3.replace(/^M {2}V30 END CTAB$/m, `${lines.join('\n')}\nM  V30 END CTAB`);
}

/** V3000 の 1 行は 80 文字まで。長い行は末尾の「-」で次の行へ続ける */
function wrapV30(body: string): string[] {
  const out: string[] = [];
  let rest = body;
  while (rest.length > 70) {
    const cut = rest.lastIndexOf(' ', 70);
    out.push(`M  V30 ${rest.slice(0, cut)} -`);
    rest = rest.slice(cut + 1);
  }
  out.push(`M  V30 ${rest}`);
  return out;
}

/** RDKit の分子（SMILES・V3000 から読んだもの）の組を、原子の番号（0 始まり）ごとに読む */
export function readStereoGroups(json: string): Map<number, { type: StereoGroupType; n: number }> {
  const out = new Map<number, { type: StereoGroupType; n: number }>();
  try {
    const mol = JSON.parse(json).molecules?.[0];
    const count: Record<StereoGroupType, number> = { and: 0, or: 0 };
    for (const g of mol?.stereoGroups ?? []) {
      if (g.type !== 'and' && g.type !== 'or') continue;
      const n = ++count[g.type as StereoGroupType];
      for (const i of g.atoms as number[]) out.set(i, { type: g.type, n });
    }
  } catch {
    // 組が読めなくても、構造は読める
  }
  return out;
}

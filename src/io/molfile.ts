// MDL Molfile（V2000）の読み書き。座標は Å・y 上向きなので、pt・y 下向きと変換する。

import type { Atom, Bond, BondOrder, BondStereo, Doc } from '../chem/model';
import { newId } from '../chem/model';
import { BOND_LEN } from '../chem/style';
import { drawnOnly } from '../chem/hydrogens';

/** Molfile の結合長（RDKit の既定） */
export const MOL_BOND_LEN = 1.5;
const SCALE = BOND_LEN / MOL_BOND_LEN;

const pad = (s: string | number, n: number) => String(s).padStart(n);
const fx = (v: number) => v.toFixed(4).padStart(10);

export interface MolfileOut {
  molblock: string;
  /** Molfile の原子番号（0 始まり）→ 原子 id */
  order: string[];
}

/** 略号を含まない doc を Molfile にする。atomIds を渡すとその原子だけ */
export function writeMolfile(doc: Doc, atomIds?: string[]): MolfileOut {
  const ids = atomIds ?? Object.keys(doc.atoms);
  const index = new Map(ids.map((id, i) => [id, i + 1]));
  // 配位結合と点線の結合（水素結合・部分結合）は構造に入れない（Molfile の V2000 に決まった書き方が無いため。図の上の印として持つ）
  const bonds = Object.values(doc.bonds).filter((b) => index.has(b.a1) && index.has(b.a2) && !drawnOnly(b));
  const lines: string[] = ['', '  ai-chem-editor  2D', ''];
  lines.push(`${pad(ids.length, 3)}${pad(bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`);
  const charges: [number, number][] = [];
  const radicals: number[] = [];
  const isotopes: [number, number][] = [];
  for (const id of ids) {
    const a = doc.atoms[id];
    const sym = a.abbr || a.element === '*' ? 'R' : a.element;
    lines.push(`${fx(a.x / SCALE)}${fx(-a.y / SCALE)}${fx(0)} ${sym.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`);
    if (a.charge) charges.push([index.get(id)!, a.charge]);
    if (a.radical) radicals.push(index.get(id)!);
    if (a.isotope) isotopes.push([index.get(id)!, a.isotope]);
  }
  for (const b of bonds) {
    const st = b.stereo === 'wedge' ? 1 : b.stereo === 'hash' ? 6 : b.stereo === 'wavy' ? 4 : 0;
    lines.push(`${pad(index.get(b.a1)!, 3)}${pad(index.get(b.a2)!, 3)}${pad(b.order, 3)}${pad(st, 3)}`);
  }
  for (let i = 0; i < charges.length; i += 8) {
    const chunk = charges.slice(i, i + 8);
    lines.push(`M  CHG${pad(chunk.length, 3)}${chunk.map(([n, c]) => `${pad(n, 4)}${pad(c, 4)}`).join('')}`);
  }
  // ラジカルは 2（doublet、不対電子 1 個）
  for (let i = 0; i < radicals.length; i += 8) {
    const chunk = radicals.slice(i, i + 8);
    lines.push(`M  RAD${pad(chunk.length, 3)}${chunk.map((n) => `${pad(n, 4)}${pad(2, 4)}`).join('')}`);
  }
  for (let i = 0; i < isotopes.length; i += 8) {
    const chunk = isotopes.slice(i, i + 8);
    lines.push(`M  ISO${pad(chunk.length, 3)}${chunk.map(([n, m]) => `${pad(n, 4)}${pad(m, 4)}`).join('')}`);
  }
  lines.push('M  END');
  return { molblock: lines.join('\n') + '\n', order: ids };
}

export interface ParsedMol {
  atoms: { x: number; y: number; element: string; charge: number; isotope?: number; radical?: boolean }[];
  bonds: { a1: number; a2: number; order: BondOrder; stereo: BondStereo }[];
}

/** V2000 を読む（V3000 は RDKit で V2000 に直してから渡す） */
export function parseMolfile(text: string): ParsedMol {
  const lines = text.replace(/\r/g, '').split('\n');
  const counts = lines[3] ?? '';
  if (/V3000/.test(counts)) throw new Error('V3000 はこの関数では読めません');
  const nA = parseInt(counts.slice(0, 3), 10);
  const nB = parseInt(counts.slice(3, 6), 10);
  if (!(nA >= 0) || !(nB >= 0)) throw new Error('Molfile の counts 行が読めません');
  const atoms: ParsedMol['atoms'] = [];
  for (let i = 0; i < nA; i++) {
    const l = lines[4 + i];
    const x = parseFloat(l.slice(0, 10));
    const y = parseFloat(l.slice(10, 20));
    const element = l.slice(31, 34).trim();
    const cc = parseInt(l.slice(36, 39), 10) || 0;
    const charge = cc === 0 ? 0 : 4 - cc;
    atoms.push({ x, y, element, charge });
  }
  const bonds: ParsedMol['bonds'] = [];
  for (let i = 0; i < nB; i++) {
    const l = lines[4 + nA + i];
    const a1 = parseInt(l.slice(0, 3), 10) - 1;
    const a2 = parseInt(l.slice(3, 6), 10) - 1;
    const t = parseInt(l.slice(6, 9), 10);
    const s = parseInt(l.slice(9, 12), 10) || 0;
    const order = (t >= 1 && t <= 3 ? t : 1) as BondOrder;
    const stereo: BondStereo = order === 1 ? (s === 1 ? 'wedge' : s === 6 ? 'hash' : s === 4 ? 'wavy' : 'none') : 'none';
    bonds.push({ a1, a2, order, stereo });
  }
  // M  CHG があれば、atom ブロックの電荷を置き換える
  let chgSeen = false;
  for (let i = 4 + nA + nB; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('M  END')) break;
    if (l.startsWith('M  CHG')) {
      if (!chgSeen) {
        atoms.forEach((a) => (a.charge = 0));
        chgSeen = true;
      }
      const n = parseInt(l.slice(6, 9), 10);
      for (let k = 0; k < n; k++) {
        const idx = parseInt(l.slice(9 + k * 8, 13 + k * 8), 10) - 1;
        const c = parseInt(l.slice(13 + k * 8, 17 + k * 8), 10);
        if (atoms[idx]) atoms[idx].charge = c;
      }
    }
    // 同位体（M  ISO）とラジカル（M  RAD。2 が不対電子 1 個）
    if (l.startsWith('M  ISO') || l.startsWith('M  RAD')) {
      const n = parseInt(l.slice(6, 9), 10);
      for (let k = 0; k < n; k++) {
        const idx = parseInt(l.slice(9 + k * 8, 13 + k * 8), 10) - 1;
        const v = parseInt(l.slice(13 + k * 8, 17 + k * 8), 10);
        if (!atoms[idx]) continue;
        if (l.startsWith('M  ISO')) atoms[idx].isotope = v;
        else if (v === 2) atoms[idx].radical = true;
      }
    }
  }
  return { atoms, bonds };
}

/** 読んだ分子を doc に足す。結合長を ACS の長さにそろえ、中心を center に置く */
export function addParsedMol(doc: Doc, mol: ParsedMol, center: { x: number; y: number }): { doc: Doc; atomIds: string[] } {
  const d = structuredClone(doc);
  const lens = mol.bonds.map((b) => Math.hypot(mol.atoms[b.a1].x - mol.atoms[b.a2].x, mol.atoms[b.a1].y - mol.atoms[b.a2].y));
  lens.sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : MOL_BOND_LEN;
  const k = median > 1e-6 ? BOND_LEN / median : SCALE;
  const cx = mol.atoms.reduce((s, a) => s + a.x, 0) / Math.max(1, mol.atoms.length);
  const cy = mol.atoms.reduce((s, a) => s + a.y, 0) / Math.max(1, mol.atoms.length);
  const ids: string[] = [];
  for (const a of mol.atoms) {
    const atom: Atom = {
      id: newId(d, 'a'),
      x: center.x + (a.x - cx) * k,
      y: center.y - (a.y - cy) * k,
      element: a.element === 'R' || a.element === 'R#' || a.element === 'A' ? '*' : a.element,
      charge: a.charge,
      ...(a.isotope ? { isotope: a.isotope } : {}),
      ...(a.radical ? { radical: true } : {}),
    };
    d.atoms[atom.id] = atom;
    ids.push(atom.id);
  }
  for (const b of mol.bonds) {
    const bond: Bond = { id: newId(d, 'b'), a1: ids[b.a1], a2: ids[b.a2], order: b.order, stereo: b.stereo, doublePos: 'auto' };
    d.bonds[bond.id] = bond;
  }
  return { doc: d, atomIds: ids };
}


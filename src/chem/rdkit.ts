// RDKit.js（WebAssembly）の置き場所。ブラウザでは main.tsx、テストでは tests/setup で読み込んで setRDKit する。
import type { MainModule, Mol } from '@rdkit/rdkit';

let mod: MainModule | null = null;

export function setRDKit(m: MainModule) {
  mod = m;
}

export function getRDKit(): MainModule {
  if (!mod) throw new Error('RDKit がまだ読み込まれていません');
  return mod;
}

export const hasRDKit = () => mod !== null;

/** Mol を使ったあと必ず delete する（WASM のメモリを返す） */
export function withMol<T>(input: string, fn: (m: Mol) => T, details?: Record<string, unknown>): T | null {
  const R = getRDKit();
  const m = details ? R.get_mol(input, JSON.stringify(details)) : R.get_mol(input);
  if (!m) return null;
  try {
    if (!m.is_valid()) return null;
    return fn(m);
  } finally {
    m.delete();
  }
}

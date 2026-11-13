// 基質のまとまりが生成物に残っているかの確かめ
//
// 2026-10-26 の文章からの評価で、click の生成物を 1-フェニル-4-ベンジル体と書いた（正しくは 1-ベンジル-4-フェニル体）。
// 原子の数は同じなので、元素のつじつまでは見つからない。ベンジルアジドの「ベンゼン環 - CH2 - N」が生成物に無いことで見つける。
//
// まとまり（アンカー）: 基質の芳香環（ヘテロ芳香環を含む。縮環はまとめて 1 つ）と、環の炭素に単結合でついた C。
// ついた C が sp3（CH2・CH など）なら、その先の C・N も入れる（ベンジル位の CH2-N など。メチレンの先の N は外れることが少ない）。ここで止める（Boc・Cbz の炭素まで入れると、脱保護で外れるため）。
// 入れないもの（2026-10-26 に決めた）:
//   - 脂肪族の環（環の形成・組み替えで変わりやすい）。芳香環が壊れる反応（脱芳香族化）は少ない
//   - 環に直接ついた O・N・ハロゲン・S・B など（Ar-OH → Ar-F、Ar-OTf のカップリング、Sandmeyer の Ar-NH2 → Ar-Cl で置き換わる）
//   - C=O・C=N・C=C の先（反応の中心になりやすい）、環の N の先（N-Boc などは外れる）
// 元素とつながりだけを比べ、結合の次数と芳香族かは問わない（環の芳香族化・還元・アジドの環化で変わるため）。
//
// 芳香環そのもの（コア）は生成物にあるのに、まわりを含めたまとまりが無いときだけ知らせる。
// コアも無いとき（保護基の脱離、環の拡大・縮小などの転位）は、取り違えかどうか決められないので知らせない
import { getRDKit } from '../chem/rdkit';

const SYMBOL: Record<number, string> = { 5: 'B', 6: 'C', 7: 'N', 8: 'O', 9: 'F', 14: 'Si', 15: 'P', 16: 'S', 17: 'Cl', 35: 'Br', 53: 'I' };

export interface Anchor {
  /** 環だけの SMARTS */
  core: string;
  /** 環とまわりの SMARTS */
  full: string;
  /** 利用者に見せる書き方（芳香族の原子は小文字。結合の次数は書かない） */
  label: string;
}

type Graph = { z: number[]; aromatic: Set<number>; adj: number[][]; multiple: Set<number>; single: Set<string>; rings: number[][] };
const edge = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function graphOf(smiles: string): Graph | null {
  const m = getRDKit().get_mol(smiles);
  if (!m) return null;
  try {
    const mol = JSON.parse(m.get_json()).molecules[0] as {
      atoms: { z?: number }[];
      bonds?: { bo?: number; atoms: [number, number] }[];
      extensions?: { name: string; aromaticAtoms?: number[]; atomRings?: number[][] }[];
    };
    const z = mol.atoms.map((a) => a.z ?? 6);
    const adj: number[][] = z.map(() => []);
    // 二重・三重結合を持つ原子（sp3 でない）
    const multiple = new Set<number>();
    const single = new Set<string>();
    for (const b of mol.bonds ?? []) {
      const [a, c] = b.atoms;
      adj[a].push(c);
      adj[c].push(a);
      if ((b.bo ?? 1) > 1) (multiple.add(a), multiple.add(c));
      else single.add(edge(a, c));
    }
    const ext = mol.extensions?.find((e) => e.name === 'rdkitRepresentation');
    const aromatic = new Set(ext?.aromaticAtoms ?? []);
    return { z, aromatic, adj, multiple, single, rings: ext?.atomRings ?? [] };
  } finally {
    m.delete();
  }
}

/** 原子の組（つながっていること）を、元素とつながりだけの SMARTS と、見せる書き方にする */
function write(g: Graph, atoms: Set<number>): { smarts: string; label: string } {
  const start = Math.min(...atoms);
  const seen = new Set<number>();
  const children = new Map<number, number[]>();
  const closures = new Map<number, number[]>();
  const done = new Set<string>();
  let ring = 0;
  const visit = (a: number, parent: number) => {
    seen.add(a);
    children.set(a, []);
    for (const n of g.adj[a]) {
      if (!atoms.has(n) || n === parent) continue;
      const key = edge(a, n);
      if (done.has(key)) continue;
      done.add(key);
      if (seen.has(n)) {
        ring++;
        (closures.get(n) ?? closures.set(n, []).get(n)!).push(ring);
        (closures.get(a) ?? closures.set(a, []).get(a)!).push(ring);
      } else {
        children.get(a)!.push(n);
        visit(n, a);
      }
    }
  };
  visit(start, -1);
  const digit = (d: number) => (d < 10 ? String(d) : `%${d}`);
  const emit = (a: number, smarts: boolean): string => {
    const sym = SYMBOL[g.z[a]] ?? `#${g.z[a]}`;
    const atom = smarts ? `[#${g.z[a]}]` : g.aromatic.has(a) && sym.length === 1 ? sym.toLowerCase() : sym;
    const rc = (closures.get(a) ?? []).map((d) => (smarts ? `~${digit(d)}` : digit(d))).join('');
    const kids = children.get(a) ?? [];
    const bond = smarts ? '~' : '';
    return atom + rc + kids.map((c, i) => (i < kids.length - 1 ? `(${bond}${emit(c, smarts)})` : `${bond}${emit(c, smarts)}`)).join('');
  };
  return { smarts: emit(start, true), label: emit(start, false) };
}

/** 基質のまとまり（芳香環ごと）。まわりに足す原子が無い環は除く */
export function anchorsOf(smiles: string): Anchor[] {
  const g = graphOf(smiles);
  if (!g) return [];
  // 芳香環（すべての原子が芳香族の環）だけを、縮環（原子を共有する環）ごとにまとめる
  const systems: Set<number>[] = [];
  for (const r of g.rings) {
    if (!r.every((a) => g.aromatic.has(a))) continue;
    const hit = systems.filter((s) => r.some((a) => s.has(a)));
    const merged = new Set(r);
    for (const s of hit) for (const a of s) merged.add(a);
    systems.splice(0, systems.length, ...systems.filter((s) => !hit.includes(s)), merged);
  }
  const cn = (a: number) => g.z[a] === 6 || g.z[a] === 7;
  const out: Anchor[] = [];
  for (const sys of systems) {
    const full = new Set(sys);
    for (const a of sys) {
      if (g.z[a] !== 6) continue;
      for (const n of g.adj[a]) {
        if (sys.has(n) || g.z[n] !== 6 || !g.single.has(edge(a, n))) continue;
        full.add(n);
        // sp3 の炭素なら、その先の C・N も
        if (g.z[n] === 6 && !g.multiple.has(n) && !g.aromatic.has(n)) for (const m of g.adj[n]) if (!sys.has(m) && cn(m)) full.add(m);
      }
    }
    if (full.size === sys.size) continue;
    const f = write(g, full);
    out.push({ core: write(g, sys).smarts, full: f.smarts, label: f.label });
  }
  return out;
}

function has(smiles: string, smarts: string): boolean {
  const R = getRDKit();
  const m = R.get_mol(smiles);
  if (!m) return false;
  const q = R.get_qmol(smarts);
  try {
    return !!q && m.get_substruct_match(q) !== '{}';
  } finally {
    m.delete();
    q?.delete();
  }
}

/** 基質のまとまりのうち、環は生成物にあるのに、まわりを含めると生成物のどれにも無いもの */
export function missingAnchors(substrate: string, products: string[]): Anchor[] {
  return anchorsOf(substrate).filter((a) => products.some((p) => has(p, a.core)) && !products.some((p) => has(p, a.full)));
}

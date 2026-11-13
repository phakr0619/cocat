// 環の検出。結合ごとに、それを含む最小の環を幅優先探索で探す。
import type { Doc } from './model';
import { adjacency, otherEnd, type Adjacency } from './model';

/** 結合 id → その結合を含む最小の環の原子 id（順番どおり）。環に入らない結合は無い */
export function smallestRings(doc: Doc, adj: Adjacency = adjacency(doc)): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of Object.values(doc.bonds)) {
    const ring = shortestPath(adj, b.a1, b.a2, b.id);
    if (ring) out.set(b.id, ring);
  }
  return out;
}

/** a から z への最短経路（結合 skip を使わない）。経路が環になる */
function shortestPath(adj: Adjacency, a: string, z: string, skip: string): string[] | null {
  const prev = new Map<string, string>();
  prev.set(a, '');
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === z) break;
    for (const b of adj.bondsOf.get(cur) ?? []) {
      if (b.id === skip) continue;
      const n = otherEnd(b, cur);
      if (prev.has(n)) continue;
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!prev.has(z)) return null;
  const path: string[] = [];
  for (let c = z; c; c = prev.get(c)!) path.push(c);
  return path.reverse();
}

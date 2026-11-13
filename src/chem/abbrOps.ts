// 略号の展開と縮約。展開の形は RDKit の2D座標から作る。
import { getAbbr } from './abbreviations';
import { add, angleOf, len, rotate, sub, type P } from './geometry';
import type { Doc } from './model';
import { adjacency, edit, fragments, neighbors, newId } from './model';
import { addBondIn } from './ops';
import { getRDKit } from './rdkit';
import { BOND_LEN } from './style';
import { parseMolfile, type ParsedMol } from '../io/molfile';

const templateCache = new Map<string, ParsedMol>();

function template(abbr: string): ParsedMol {
  const def = getAbbr(abbr);
  if (!def) throw new Error(`略号 ${abbr} は表にありません`);
  // 利用者の辞書は書き換わるので、SMILES ごとに覚える
  const hit = templateCache.get(def.smiles);
  if (hit) return hit;
  const m = getRDKit().get_mol(def.smiles);
  if (!m) throw new Error(`略号 ${abbr} の SMILES が読めません`);
  try {
    m.set_new_coords();
    const t = parseMolfile(m.get_v2Kmolblock());
    templateCache.set(def.smiles, t);
    return t;
  } finally {
    m.delete();
  }
}

/** 略号の原子を、本来の原子に展開する。つながっていた原子 id はそのまま残す */
export function expandAbbr(doc: Doc, atomId: string, record = true): Doc {
  const x = doc.atoms[atomId];
  if (!x?.abbr) return doc;
  const abbr = x.abbr;
  const t = template(abbr);
  const dummy = t.atoms.findIndex((a) => a.element === 'R' || a.element === '*' || a.element === 'R#');
  const firstBond = t.bonds.find((b) => b.a1 === dummy || b.a2 === dummy)!;
  const first = firstBond.a1 === dummy ? firstBond.a2 : firstBond.a1;
  const adj = adjacency(doc);
  const ns = neighbors(adj, atomId);
  const pX: P = { x: x.x, y: x.y };
  const pN: P = ns.length ? doc.atoms[ns[0]] : { x: x.x - BOND_LEN, y: x.y };
  const k = BOND_LEN / 1.5;
  // テンプレートは y 上向きなので反転してから、dummy→first を N→X に重ねる
  const tp = (i: number): P => ({ x: t.atoms[i].x * k, y: -t.atoms[i].y * k });
  const tv = sub(tp(first), tp(dummy));
  const dv = sub(pX, pN);
  const rot = angleOf(dv) - angleOf(tv);
  const scale = len(tv) > 1e-6 ? BOND_LEN / len(tv) : 1;
  const map = (i: number): P => add(pX, rotate({ x: (tp(i).x - tp(first).x) * scale, y: (tp(i).y - tp(first).y) * scale }, rot));
  return edit(doc, (d) => {
    const ids: string[] = [];
    t.atoms.forEach((a, i) => {
      if (i === dummy) {
        ids.push('');
        return;
      }
      if (i === first) {
        const xa = d.atoms[atomId];
        xa.element = a.element;
        xa.charge = a.charge;
        delete xa.abbr;
        ids.push(atomId);
        return;
      }
      const p = map(i);
      const id = newId(d, 'a');
      d.atoms[id] = { id, x: p.x, y: p.y, element: a.element, charge: a.charge };
      ids.push(id);
    });
    for (const b of t.bonds) {
      if (b.a1 === dummy || b.a2 === dummy) continue;
      const nb = addBondIn(d, ids[b.a1], ids[b.a2], b.order, b.stereo);
      // テンプレートの向きのまま。くさびは略号の表に無い
      if (nb) nb.stereo = 'none';
    }
    // 対イオン（BF3K の K⁺）のように離れた原子があれば、分子と同じまとまり（塩）にする
    const firstIdx = t.atoms.findIndex((_, i) => ids[i] === atomId);
    const linked = new Set<number>([firstIdx]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of t.bonds) {
        if (b.a1 === dummy || b.a2 === dummy) continue;
        if (linked.has(b.a1) !== linked.has(b.a2)) (linked.add(b.a1), linked.add(b.a2), (grew = true));
      }
    }
    const loose = ids.filter((id, i) => id && i !== dummy && !linked.has(i));
    if (loose.length) {
      const unit = d.atoms[atomId].unit ?? newId(d, 'u');
      for (const f of fragments(d, adjacency(d))) if (f.includes(atomId)) for (const id of f) d.atoms[id].unit = unit;
      for (const id of loose) d.atoms[id].unit = unit;
    }
    if (record) {
      const gid = newId(d, 'g');
      d.groups[gid] = { id: gid, abbr, atomIds: ids.filter(Boolean), attachId: atomId };
    }
  });
}

/** 展開した略号を縮約に戻す */
export function contractGroup(doc: Doc, groupId: string): Doc {
  const g = doc.groups[groupId];
  if (!g) return doc;
  return edit(doc, (d) => {
    const drop = new Set(g.atomIds.filter((id) => id !== g.attachId));
    for (const id of drop) delete d.atoms[id];
    for (const b of Object.values(d.bonds)) if (drop.has(b.a1) || drop.has(b.a2)) delete d.bonds[b.id];
    const a = d.atoms[g.attachId];
    a.element = '*';
    a.abbr = g.abbr;
    a.charge = 0;
    delete d.groups[groupId];
  });
}

/** 書き出し用: すべての略号を展開した複製 */
export function expandAllAbbr(doc: Doc): Doc {
  let d = doc;
  for (const a of Object.values(doc.atoms)) if (a.abbr && getAbbr(a.abbr)) d = expandAbbr(d, a.id, false);
  return d;
}


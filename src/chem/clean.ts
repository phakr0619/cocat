// Clean Structure: RDKit の2D座標で形を整え、元の位置と向きに重ねる
import { parseMolfile, writeMolfile, MOL_BOND_LEN } from '../io/molfile';
import { add, type P } from './geometry';
import type { Doc } from './model';
import { adjacency, edit, fragments, kindOf } from './model';
import { getRDKit } from './rdkit';
import { BOND_LEN } from './style';

export interface CleanResult {
  doc: Doc;
  failed: number;
}

/** sel に掛かる分子（sel が空なら全部）を整える */
export function cleanStructure(doc: Doc, sel: Set<string>): CleanResult {
  const frags = fragments(doc, adjacency(doc)).filter((f) => f.length > 1);
  const selAtoms = new Set<string>();
  for (const id of sel) {
    if (kindOf(id) === 'atom') selAtoms.add(id);
    else if (doc.bonds[id]) {
      selAtoms.add(doc.bonds[id].a1);
      selAtoms.add(doc.bonds[id].a2);
    }
  }
  const targets = sel.size ? frags.filter((f) => f.some((id) => selAtoms.has(id))) : frags;
  let failed = 0;
  let out = doc;
  for (const f of targets) {
    const r = cleanFragment(out, f);
    if (r) out = r;
    else failed++;
  }
  return { doc: out, failed };
}

function cleanFragment(doc: Doc, atomIds: string[]): Doc | null {
  const { molblock, order } = writeMolfile(doc, atomIds);
  // 価数エラーがあっても整えられるよう、読めなければ sanitize なしで読み直す
  const R = getRDKit();
  const m = R.get_mol(molblock, JSON.stringify({ removeHs: false })) ?? R.get_mol(molblock, JSON.stringify({ sanitize: false, removeHs: false }));
  if (!m) return null;
  let mb: string;
  try {
    m.set_new_coords();
    mb = m.get_v2Kmolblock();
  } finally {
    m.delete();
  }
  const parsed = parseMolfile(mb);
  if (parsed.atoms.length !== order.length) return null;
  const k = BOND_LEN / MOL_BOND_LEN;
  const fresh: P[] = parsed.atoms.map((a) => ({ x: a.x * k, y: -a.y * k }));
  const old: P[] = order.map((id) => ({ x: doc.atoms[id].x, y: doc.atoms[id].y }));
  const plain = align(fresh, old);
  const mirrored = align(fresh.map((p) => ({ x: -p.x, y: p.y })), old);
  // 元の向きに近い方（鏡像を含む）を使う。鏡像にしたら、くさびの実線と破線を入れ替える
  const useMirror = mirrored.err < plain.err * 0.8;
  const pts = useMirror ? mirrored.pts : plain.pts;
  const index = new Map(order.map((id, i) => [id, i]));
  return edit(doc, (d) => {
    order.forEach((id, i) => {
      d.atoms[id].x = pts[i].x;
      d.atoms[id].y = pts[i].y;
    });
    // RDKit がくさびを付け直したもの（立体中心から伸ばす）を使う
    const bonds = Object.values(d.bonds).filter((b) => index.has(b.a1) && index.has(b.a2));
    if (bonds.length !== parsed.bonds.length) return;
    bonds.forEach((b, i) => {
      const nb = parsed.bonds[i];
      if (b.stereo === 'wavy') return;
      if (nb.stereo === 'wedge' || nb.stereo === 'hash') {
        b.a1 = order[nb.a1];
        b.a2 = order[nb.a2];
        b.stereo = useMirror ? (nb.stereo === 'wedge' ? 'hash' : 'wedge') : nb.stereo;
      } else if (b.stereo === 'wedge' || b.stereo === 'hash') {
        b.stereo = 'none';
      }
    });
  });
}

/** fresh を回転・平行移動して old に重ねる（最小二乗） */
function align(fresh: P[], old: P[]): { pts: P[]; err: number } {
  const n = fresh.length;
  const cf = centroid(fresh);
  const co = centroid(old);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const a = { x: fresh[i].x - cf.x, y: fresh[i].y - cf.y };
    const b = { x: old[i].x - co.x, y: old[i].y - co.y };
    sxx += a.x * b.x + a.y * b.y;
    sxy += a.x * b.y - a.y * b.x;
  }
  const th = Math.atan2(sxy, sxx);
  const c = Math.cos(th);
  const s = Math.sin(th);
  let err = 0;
  const pts = fresh.map((p, i) => {
    const dx = p.x - cf.x;
    const dy = p.y - cf.y;
    const q = add(co, { x: dx * c - dy * s, y: dx * s + dy * c });
    err += (q.x - old[i].x) ** 2 + (q.y - old[i].y) ** 2;
    return q;
  });
  return { pts, err };
}

function centroid(ps: P[]): P {
  const s = ps.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / ps.length, y: s.y / ps.length };
}

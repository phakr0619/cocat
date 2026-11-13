// ラベルに書いた塩（「NH2Cl」「NH·HCl」）の対イオンを、書き出し・計算のために原子として足す。docs/salt-design.md
import type { Atom, Doc } from './model';
import { edit, newId } from './model';

/** 対イオンを置く距離（ラベルの右。図には出さないので、書き出しの CDXML でラベルに重ならない程度） */
const OFFSET = 22;

/**
 * 塩のラベルの原子を、陽イオン（ion）か中性の原子（dot）に直し、対イオン X⁻ か HX を原子として足す。
 * 足した原子は元の原子と同じまとまり（unit）に入れる。counters は 元の原子 id → 足した原子 id
 */
export function expandSalts(doc: Doc): { doc: Doc; counters: Map<string, string> } {
  const counters = new Map<string, string>();
  if (!Object.values(doc.atoms).some((a) => a.salt)) return { doc, counters };
  const out = edit(doc, (d) => {
    for (const a of Object.values(d.atoms)) {
      const salt = a.salt;
      if (!salt) continue;
      delete a.salt;
      a.unit ??= newId(d, 'u');
      if (salt.style === 'ion') a.charge += 1;
      const id = newId(d, 'a');
      const x: Atom = { id, x: a.x + OFFSET, y: a.y, element: salt.x, charge: salt.style === 'ion' ? -1 : 0, unit: a.unit };
      if (a.ref) x.ref = a.ref;
      if (a.lib) x.lib = a.lib;
      d.atoms[id] = x;
      counters.set(a.id, id);
    }
  });
  return { doc: out, counters };
}

/** 画面に出すラベルの付け足し。右向きなら「NH2」のあとに付け、左向きなら「H2N」の前に付ける */
export function saltLabelText(salt: NonNullable<Atom['salt']>, side: 'left' | 'right'): string {
  if (salt.style === 'ion') return salt.x;
  return side === 'right' ? `·H${salt.x}` : `H${salt.x}·`;
}

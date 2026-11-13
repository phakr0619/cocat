// 原子ラベル（元素記号・水素・電荷・略号）の配置
import { getAbbr } from '../chem/abbreviations';
import { add, fromAngle, angleOf, normAngle, sub, type P, type Rect } from '../chem/geometry';
import { implicitHydrogens } from '../chem/hydrogens';
import { saltLabelText } from '../chem/saltLabel';
import type { Adjacency, Atom, Doc } from '../chem/model';
import { neighbors } from '../chem/model';
import { ACS } from '../chem/style';
import { CAP_HEIGHT, formulaRuns, SUB_SCALE, SUP_RISE, textWidth, type Run } from './text';

export interface AtomLabel {
  runs: Run[];
  /** 結合を切る範囲（余白を含まない） */
  boxes: Rect[];
}


export function chargeText(charge: number): string {
  if (!charge) return '';
  const n = Math.abs(charge);
  return `${n > 1 ? n : ''}${charge > 0 ? '+' : '−'}`;
}

function runBox(r: Run): Rect {
  return { x1: r.x, y1: r.y - CAP_HEIGHT * r.size, x2: r.x + textWidth(r.text, r.size), y2: r.y };
}

/** 隣の原子が右にあれば 'left'（ラベルの付け足しを左へ伸ばす） */
function growSide(atom: Atom, doc: Doc, adj: Adjacency): 'left' | 'right' {
  let sx = 0;
  for (const n of neighbors(adj, atom.id)) {
    const o = doc.atoms[n];
    const dx = o.x - atom.x;
    const l = Math.hypot(dx, o.y - atom.y) || 1;
    sx += dx / l;
  }
  return sx > 0.1 ? 'left' : 'right';
}

/** 結合の無い向きのうち、最も空いている向き */
export function freeDirection(atom: Atom, doc: Doc, adj: Adjacency): number {
  const angs = neighbors(adj, atom.id)
    .map((n) => angleOf(sub(doc.atoms[n], atom)))
    .sort((a, b) => a - b);
  if (angs.length === 0) return -Math.PI / 4;
  if (angs.length === 1) return normAngle(angs[0] + Math.PI);
  let best = 0;
  let bestGap = -1;
  for (let i = 0; i < angs.length; i++) {
    const a = angs[i];
    const b = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
    if (b - a > bestGap) {
      bestGap = b - a;
      best = a + (b - a) / 2;
    }
  }
  return normAngle(best);
}

export function atomLabel(atom: Atom, doc: Doc, adj: Adjacency): AtomLabel | null {
  const degree = adj.bondsOf.get(atom.id)?.length ?? 0;
  const baseline = atom.y + (CAP_HEIGHT * ACS.labelSize) / 2;
  const side = growSide(atom, doc, adj);

  if (atom.abbr) {
    // R1・R2 の番号は上付き（R¹）にする
    const rg = !getAbbr(atom.abbr) && atom.abbr.match(/^(R|Ar|X)(\d+)$/);
    if (rg) {
      const f = formulaRuns(rg[1], ACS.labelSize, baseline, rg[2]);
      return place(f.runs, atom.x - textWidth(rg[1][0], ACS.labelSize) / 2);
    }
    const def = getAbbr(atom.abbr);
    const text = def ? (side === 'left' ? def.reversed : def.label) : atom.abbr;
    const f = formulaRuns(text, ACS.labelSize, baseline, chargeText(atom.charge));
    // 結合がつながる文字（左から来るなら先頭、右から来るなら末尾）を原子の位置に置く
    const idx = side === 'left' ? lastCapitalIndex(text) : 0;
    const cx = f.charX[idx] + textWidth(text[idx], ACS.labelSize) / 2;
    return place(f.runs, atom.x - cx);
  }

  // 置換基のつなぐ点（波線の結合の先の R）は、記号を出さない
  if (atom.element === '*' && degree === 1 && adj.bondsOf.get(atom.id)![0].stereo === 'wavy') return null;

  if (atom.element === 'C' && degree > 0 && !atom.isotope) {
    if (!atom.charge) return null;
    // 炭素の電荷は記号なしで、空いている向きに置く
    const p: P = add(atom, fromAngle(freeDirection(atom, doc, adj), 6));
    const s = chargeText(atom.charge);
    const run: Run = { text: s, x: p.x - textWidth(s, ACS.labelSize * 0.75) / 2, y: p.y + (CAP_HEIGHT * ACS.labelSize * 0.75) / 2, size: ACS.labelSize * 0.75 };
    return { runs: [run], boxes: [] };
  }

  const h = implicitHydrogens(atom, adj);
  const hText = h > 0 ? `H${h > 1 ? h : ''}` : '';
  // 同位体: 重水素は D、ほかは質量数を記号の左上に（¹³C）
  const deuterium = atom.element === 'H' && atom.isotope === 2;
  const sym = deuterium ? 'D' : atom.element;
  const mass = atom.isotope && !deuterium ? String(atom.isotope) : '';
  const symW = textWidth(sym, ACS.labelSize);
  // ラベルに書いた塩（NH2Cl・NH·HCl）は、対イオンを付け足して書く（右向きは末尾、左向きは先頭）
  const saltSide = side === 'right' || !hText ? 'right' : 'left';
  const saltText = atom.salt ? saltLabelText(atom.salt, saltSide) : '';
  if (side === 'right' || !hText) {
    const f = formulaRuns(sym + hText + saltText, ACS.labelSize, baseline, chargeText(atom.charge));
    return withMass(place(f.runs, atom.x - symW / 2), mass, atom.x - symW / 2, baseline);
  }
  const hf = formulaRuns(saltText + hText, ACS.labelSize, baseline);
  const f = formulaRuns(saltText + hText + sym, ACS.labelSize, baseline, chargeText(atom.charge));
  return withMass(place(f.runs, atom.x - hf.width - symW / 2), mass, atom.x - symW / 2, baseline);
}

/** 質量数を、記号（左端が x）の左上に足す。記号より左の文字（左に伸びた H3 など）は、その分だけ左へずらす（H₃¹³C） */
function withMass(l: AtomLabel, mass: string, x: number, baseline: number): AtomLabel {
  if (!mass) return l;
  const size = ACS.labelSize * SUB_SCALE;
  const w = textWidth(mass, size);
  const runs = l.runs.map((r) => (r.x < x - 0.01 ? { ...r, x: r.x - w } : r));
  const run: Run = { text: mass, x: x - w, y: baseline - ACS.labelSize * SUP_RISE, size };
  return { runs: [run, ...runs], boxes: [runBox(run), ...runs.map(runBox)] };
}

function lastCapitalIndex(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) if (/[A-Z]/.test(text[i])) return i;
  return text.length - 1;
}

function place(runs: Run[], dx: number): AtomLabel {
  const placed = runs.map((r) => ({ ...r, x: r.x + dx }));
  return { runs: placed, boxes: placed.map(runBox) };
}

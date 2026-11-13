// 検討表の自動レイアウト: 題・共通の反応式（または母核）・罫線3本の表・注を、決まった規則で並べる。
// 置いた物には ref（表の id）を付け、描き直すときはそれを消して置き直す
import type { Rect } from '../chem/geometry';
import { rectUnion } from '../chem/geometry';
import type { Doc } from '../chem/model';
import { edit, emptyDoc, newId } from '../chem/model';
import { ACS, applyDrawStyle } from '../chem/style';
import { addSmiles } from '../io/smiles';
import { layout } from '../render/layout';
import { measure, setSchemeFollower, structureBox } from '../scheme/layout';
import type { Structure } from '../scheme/model';
import { structureFrom } from '../scheme/model';
import { cellText, headerText, isFormulaColumn, noteMark, supMark, type StudyTable } from './model';

/** 文字の行の高さ（図の設定の文字の大きさで変わるので、描くたびに読む） */
const lineH = () => ACS.captionSize * 1.25;
const capH = () => ACS.captionSize * 0.72;
const PAD_X = 7;
const PAD_Y = 3;
const GAP = 8;

export const tableKey = (tableId: string, part: 'core' | 'cell') => `${tableId}:${part}`;

/** 文書から、この表が置いた物を消す（反応式はスキームの持ち物なので消さない） */
export function clearTable(d: Doc, tableId: string) {
  const prefix = `${tableId}:`;
  for (const a of Object.values(d.atoms)) if (a.ref?.startsWith(prefix)) delete d.atoms[a.id];
  for (const b of Object.values(d.bonds)) if (!d.atoms[b.a1] || !d.atoms[b.a2]) delete d.bonds[b.id];
  for (const g of Object.values(d.groups)) if (g.atomIds.some((x) => !d.atoms[x])) delete d.groups[g.id];
  for (const r of Object.values(d.arrows)) if (r.ref === tableId) delete d.arrows[r.id];
  for (const t of Object.values(d.texts)) if (t.ref === tableId) delete d.texts[t.id];
}

// ---------------------------------------------------------------- 置換基の構造

const substituentCache = new Map<string, Structure | null>();

/**
 * 「*」つきの SMILES（*c1ccc(OC)cc1）を、つなぐ点が左を向いた構造にする。
 * つなぐ点への結合は波線にし、点そのものは記号を出さない（src/render/labels.ts）。読めなければ null
 */
export function substituentStructure(smiles: string): Structure | null {
  const key = smiles.trim();
  if (!key.includes('*')) return null;
  if (substituentCache.has(key)) return substituentCache.get(key)!;
  let out: Structure | null = null;
  try {
    const { doc, atomIds } = addSmiles(emptyDoc(), key, { x: 0, y: 0 });
    const star = atomIds.find((id) => doc.atoms[id].element === '*');
    const bond = star && Object.values(doc.bonds).find((b) => b.a1 === star || b.a2 === star);
    if (star && bond) {
      const nb = doc.atoms[bond.a1 === star ? bond.a2 : bond.a1];
      const s = doc.atoms[star];
      // つなぐ点が隣の原子の左に来るように回す
      const ang = Math.PI - Math.atan2(s.y - nb.y, s.x - nb.x);
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const ox = nb.x;
      const oy = nb.y;
      for (const id of atomIds) {
        const a = doc.atoms[id];
        const x = a.x - ox;
        const y = a.y - oy;
        a.x = x * cos - y * sin;
        a.y = x * sin + y * cos;
      }
      // 波線は、つなぐ点の側から描く
      bond.a1 = nb.id;
      bond.a2 = star;
      bond.stereo = 'wavy';
      bond.order = 1;
    }
    out = structureFrom(doc, atomIds);
  } catch {
    out = null;
  }
  substituentCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- 描く

interface Cell {
  text: string;
  formula: boolean;
  w: number;
  h: number;
  structure?: Structure;
  box?: Rect;
}

function measureCell(text: string, formula: boolean, structural: boolean): Cell {
  const s = structural ? substituentStructure(text) : null;
  if (s) {
    const box = structureBox(s);
    return { text, formula, w: box.x2 - box.x1, h: box.y2 - box.y1, structure: s, box };
  }
  return { text, formula, w: text ? measure(text, formula) : 0, h: capH() };
}

/** 文書の中で、ref が付いた物（スキームなら sid、母核なら tid:core）の範囲 */
function boundsOf(d: Doc, ref: string): Rect | null {
  const prefix = `${ref}:`;
  const sub = {
    ...emptyDoc(),
    atoms: Object.fromEntries(Object.entries(d.atoms).filter(([, a]) => a.ref === ref || a.ref?.startsWith(prefix))),
    arrows: Object.fromEntries(Object.entries(d.arrows).filter(([, r]) => r.ref === ref)),
    texts: Object.fromEntries(Object.entries(d.texts).filter(([, t]) => t.ref === ref)),
    pluses: Object.fromEntries(Object.entries(d.pluses).filter(([, p]) => p.ref === ref)),
  };
  sub.bonds = Object.fromEntries(Object.entries(d.bonds).filter(([, b]) => sub.atoms[b.a1] && sub.atoms[b.a2]));
  sub.groups = Object.fromEntries(Object.entries(d.groups).filter(([, g]) => g.atomIds.every((x) => sub.atoms[x])));
  return layout(sub).bbox;
}

function addText(d: Doc, tableId: string, x: number, y: number, text: string, opt: { bold?: boolean; formula?: boolean } = {}) {
  const id = newId(d, 't');
  d.texts[id] = { id, x, y, text, ref: tableId, ...(opt.bold ? { bold: true } : {}), ...(opt.formula ? { formula: true } : {}) };
}

function addRule(d: Doc, tableId: string, x1: number, x2: number, y: number) {
  const id = newId(d, 'r');
  d.arrows[id] = { id, x1, y1: y, x2, y2: y, kind: 'line', ref: tableId };
}

function placeStructure(d: Doc, s: Structure, ref: string, dx: number, dy: number) {
  const map = new Map<string, string>();
  for (const a of Object.values(s.atoms)) {
    const id = newId(d, 'a');
    map.set(a.id, id);
    d.atoms[id] = { ...a, id, x: a.x + dx, y: a.y + dy, ref };
  }
  for (const b of Object.values(s.bonds)) {
    const id = newId(d, 'b');
    d.bonds[id] = { ...b, id, a1: map.get(b.a1)!, a2: map.get(b.a2)! };
  }
  for (const g of Object.values(s.groups)) {
    const id = newId(d, 'g');
    d.groups[id] = { ...g, id, atomIds: g.atomIds.map((a) => map.get(a)!), attachId: map.get(g.attachId)! };
  }
}

/** 題の行の高さ（題が無ければ 0） */
function titleHeight(t: StudyTable): number {
  return t.number?.trim() || t.title?.trim() ? lineH() + 4 : 0;
}

/** 表を描き直した文書を返す。反応式があれば、反応式の置き場所を基準にする */
export function renderTable(doc: Doc, tableId: string): Doc {
  // 図の設定（線の太さ・文字の大きさ）を当ててから描く
  const restore = applyDrawStyle(doc.drawStyle);
  try {
    return renderTableNow(doc, tableId);
  } finally {
    restore();
  }
}

function renderTableNow(doc: Doc, tableId: string): Doc {
  const t0 = doc.tables?.[tableId];
  if (!t0) return doc;
  return edit(doc, (d) => {
    const t = d.tables![tableId];
    clearTable(d, tableId);
    const scheme = t.schemeId ? d.schemes?.[t.schemeId] : undefined;
    if (t.schemeId && !scheme) delete t.schemeId;
    if (scheme) t.origin = { x: scheme.origin.x, y: scheme.origin.y - titleHeight(t) };
    const x0 = t.origin.x;
    let y = t.origin.y;

    // 題: 「Table 1.」は太字、続けて題
    if (titleHeight(t)) {
      const head = `Table${t.number?.trim() ? ` ${t.number.trim()}` : ''}.`;
      addText(d, tableId, x0, y + capH(), head, { bold: true });
      if (t.title?.trim()) addText(d, tableId, x0 + measure(head, false) * 1.08 + 4, y + capH(), t.title.trim());
      y += titleHeight(t);
    }

    // 表の大きさを先に測る（母核を表の幅の中央に置くため）
    const cols = t.columns;
    const header = cols.map((c) => measureCell(headerText(c), false, false));
    const body = t.rows.map((_, ri) => cols.map((c) => measureCell(cellText(t, ri, c), isFormulaColumn(c), c.kind === 'structure')));
    const widths = cols.map((_, ci) => Math.max(header[ci].w, ...body.map((r) => r[ci].w)) + PAD_X * 2);
    const tableW = widths.reduce((s, w) => s + w, 0);

    // 共通の反応式（スキームが描いた物）か、母核
    let top: Rect | null = null;
    if (scheme) top = boundsOf(d, scheme.id);
    else if (t.core && Object.keys(t.core.atoms).length) {
      const box = structureBox(t.core);
      const cx = x0 + Math.max(tableW, box.x2 - box.x1) / 2;
      placeStructure(d, t.core, tableKey(tableId, 'core'), cx - (box.x1 + box.x2) / 2, y - box.y1);
      top = { x1: cx - (box.x2 - box.x1) / 2, y1: y, x2: cx + (box.x2 - box.x1) / 2, y2: y + box.y2 - box.y1 };
    }
    if (top) y = top.y2 + GAP;

    // 罫線3本（上・見出しの下・下）と中身
    const x2 = x0 + tableW;
    addRule(d, tableId, x0, x2, y);
    let cx = x0;
    header.forEach((h, ci) => {
      addText(d, tableId, cx + (widths[ci] - h.w) / 2, y + PAD_Y + 1 + capH(), h.text);
      cx += widths[ci];
    });
    y += lineH() + PAD_Y * 2;
    addRule(d, tableId, x0, x2, y);
    y += PAD_Y;
    body.forEach((row) => {
      const h = Math.max(lineH(), ...row.map((c) => (c.structure ? c.h + PAD_Y * 2 : 0)));
      let x = x0;
      row.forEach((c, ci) => {
        const mid = x + widths[ci] / 2;
        if (c.structure && c.box) {
          placeStructure(d, c.structure, tableKey(tableId, 'cell'), mid - (c.box.x1 + c.box.x2) / 2, y + h / 2 - (c.box.y1 + c.box.y2) / 2);
        } else if (c.text) {
          addText(d, tableId, mid - c.w / 2, y + (h + capH()) / 2, c.text, { formula: c.formula });
        }
        x += widths[ci];
      });
      y += h;
    });
    y += PAD_Y;
    addRule(d, tableId, x0, x2, y);

    // 注
    y += 4;
    t.notes.forEach((n, i) => {
      if (!n.trim()) return;
      addText(d, tableId, x0, y + capH(), `${supMark(noteMark(i))}${n.trim()}`);
      y += lineH();
    });
  });
}

/** 表の全体の範囲（反応式・母核を含む） */
export function tableBounds(doc: Doc, tableId: string): Rect | null {
  const t = doc.tables?.[tableId];
  if (!t) return null;
  const own = boundsOf(doc, tableId);
  const sch = t.schemeId ? boundsOf(doc, t.schemeId) : null;
  return sch ? rectUnion(own, sch) : own;
}

/** スキームを描き直したら、それを反応式に使う表も描き直す（反応式の高さが変わるため） */
setSchemeFollower((doc, schemeId) => {
  let out = doc;
  for (const t of Object.values(doc.tables ?? {})) if (t.schemeId === schemeId) out = renderTable(out, t.id);
  return out;
});


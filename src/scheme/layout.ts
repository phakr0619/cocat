// スキームの自動レイアウト: データと書式から、分子・＋・矢印・文字を決まった規則で並べる。
// 置いた物には ref（スキーム id）を付け、描き直すときはそれを消して置き直す
import type { Rect } from '../chem/geometry';
import type { Doc } from '../chem/model';
import { edit, emptyDoc, newId, remapUnits } from '../chem/model';
import { ACS, applyDrawStyle, BOND_LEN } from '../chem/style';
import { layout } from '../render/layout';
import { formulaRuns, textWidth } from '../render/text';
import type { Compound, Scheme, Structure } from './model';
import { compoundLabel, schemeCompounds } from './model';
import { arrowTexts, footnoteText, getStyle, stepMark, wrapAtOf, yieldText, type SchemeStyle } from './style';
import { pageDims } from '../chem/page';

const GAP = 10;
const PLUS_W = 16;
/** 文字の行の高さ（図の設定の文字の大きさで変わるので、描くたびに読む） */
const lineH = () => ACS.captionSize * 1.25;
const capH = () => ACS.captionSize * 0.72;

type Item =
  | { kind: 'compound'; id: string; productOf?: number }
  | { kind: 'plus' }
  | { kind: 'arrow'; step: number };

export const compoundKey = (schemeId: string, compoundId: string) => `${schemeId}:${compoundId}`;

/** 文字の幅（化学式の書き方なら下付きを考える） */
export function measure(text: string, formula = true): number {
  if (!formula) return textWidth(text, ACS.captionSize);
  return formulaRuns(text, ACS.captionSize, 0).width;
}

/** 構造をそのまま描いたときの範囲（ラベルを含む）。中心が原点の座標で */
export function structureBox(s: Structure): Rect {
  const d = { ...emptyDoc(), atoms: s.atoms, bonds: s.bonds, groups: s.groups };
  return layout(d).bbox ?? { x1: -6, y1: -6, x2: 6, y2: 6 };
}

/** 段の並びを、左から順の項目にする */
export function schemeItems(scheme: Scheme): Item[] {
  const items: Item[] = [];
  let prevTo: string[] = [];
  scheme.steps.forEach((st, i) => {
    const extra = i === 0 ? st.from : st.from.filter((c) => !prevTo.includes(c));
    extra.forEach((c, j) => {
      if (i > 0 || j > 0) items.push({ kind: 'plus' });
      items.push({ kind: 'compound', id: c });
    });
    items.push({ kind: 'arrow', step: i });
    st.to.forEach((c, j) => {
      if (j > 0) items.push({ kind: 'plus' });
      items.push({ kind: 'compound', id: c, productOf: i });
    });
    prevTo = st.to;
  });
  return items;
}

interface Measured {
  item: Item;
  w: number;
  up: number;
  down: number;
  box?: Rect;
  labels?: { text: string; bold: boolean }[];
  arrow?: { above: string[]; below: string[] };
}

function measureItem(item: Item, scheme: Scheme, compounds: Record<string, Compound>, style: SchemeStyle): Measured {
  if (item.kind === 'plus') return { item, w: PLUS_W, up: 4, down: 4 };
  if (item.kind === 'arrow') {
    const st = scheme.steps[item.step];
    const t = style.conditions === 'footnote' ? { above: [stepMark(item.step, style)], below: [] as string[] } : arrowTexts(st, style, (x) => measure(x));
    const w = Math.max(style.minArrow, ...t.above.map((a) => measure(a) + 12), ...t.below.map((b) => measure(b) + 12));
    return { item, w, up: t.above.length ? t.above.length * lineH() + 4 : 6, down: t.below.length * lineH() + 6, arrow: t };
  }
  const c = compounds[item.id];
  const box = c ? structureBox(c.structure) : { x1: -8, y1: -8, x2: 8, y2: 8 };
  const labels: { text: string; bold: boolean }[] = [];
  const lab = compoundLabel(c, style.showNickname);
  let first = lab ? lab.text : '';
  const bold = !!lab?.isNumber && style.boldNumber;
  if (style.yieldPosition === 'after-label' && item.productOf !== undefined) {
    const y = yieldText(scheme.steps[item.productOf].yield, style);
    if (y) first = first ? `${first} ${y}` : y;
  }
  if (first) labels.push({ text: first, bold });
  const labelW = Math.max(0, ...labels.map((l) => measure(l.text, false) * (l.bold ? 1.08 : 1)));
  const w = Math.max(box.x2 - box.x1, labelW);
  const cy = (box.y1 + box.y2) / 2;
  // 番号の行の分は、行ごとにそろえて足す（renderScheme）
  return { item, w, up: cy - box.y1, down: box.y2 - cy, box, labels };
}

/** 文書から、このスキームが置いた物を消す */
export function clearScheme(d: Doc, schemeId: string) {
  const prefix = `${schemeId}:`;
  for (const a of Object.values(d.atoms)) if (a.ref?.startsWith(prefix)) delete d.atoms[a.id];
  for (const b of Object.values(d.bonds)) if (!d.atoms[b.a1] || !d.atoms[b.a2]) delete d.bonds[b.id];
  for (const g of Object.values(d.groups)) if (g.atomIds.some((x) => !d.atoms[x])) delete d.groups[g.id];
  for (const r of Object.values(d.arrows)) if (r.ref === schemeId) delete d.arrows[r.id];
  for (const t of Object.values(d.texts)) if (t.ref === schemeId) delete d.texts[t.id];
  for (const p of Object.values(d.pluses)) if (p.ref === schemeId) delete d.pluses[p.id];
}

type Follower = (doc: Doc, schemeId: string) => Doc;
let follower: Follower | null = null;

/** スキームを描き直した後に呼ぶ処理を登録する（反応式をスキームに持つ検討表の描き直し。src/table/layout.ts） */
export function setSchemeFollower(fn: Follower) {
  follower = fn;
}

/** スキームを描き直した文書を返す（それを使う検討表も描き直す） */
export function renderScheme(doc: Doc, schemeId: string): Doc {
  const out = renderSchemeOnly(doc, schemeId);
  return follower && out !== doc ? follower(out, schemeId) : out;
}

/** スキームだけを描き直す */
export function renderSchemeOnly(doc: Doc, schemeId: string): Doc {
  // 図の設定（線の太さ・文字の大きさ）を当ててから描く
  const restore = applyDrawStyle(doc.drawStyle);
  try {
    return renderSchemeOnlyNow(doc, schemeId);
  } finally {
    restore();
  }
}

/** ページの右端と、行の右端との間（pt） */
export const PAGE_MARGIN = 36;

/**
 * 1 行の幅。ページの設定があれば、スキームの左端から、そのページの右端より PAGE_MARGIN 内側まで（狭すぎるときは 150 pt）。
 * ページが無いか、スキームの左端がページの外なら、書式の「行の幅」
 */
export function rowWidth(doc: Pick<Doc, 'page'>, left: number, styleWidth: number): number {
  if (!doc.page) return styleWidth;
  const { w } = pageDims(doc.page);
  const col = Math.floor(left / w);
  if (left < 0 || col >= doc.page.cols) return styleWidth;
  return Math.max(150, (col + 1) * w - PAGE_MARGIN - left);
}

/**
 * 並べる物を行に分ける。矢印と、＋でつないだ化合物のまとまりを 1 つずつ置き、
 * 行の幅に入らなければ、その行で最後に折り返してよい所（wrapAt で選んだ、矢印の後・化合物のまとまりの後）で折り返す。
 * 折り返してよい所が無ければ、はみ出して並べる
 */
export function wrapRows<T extends { item: Item; w: number }>(measured: T[], width: number, wrapAt: { arrow: boolean; compound: boolean }): T[][] {
  // まとまりに分ける: 矢印は 1 つで、化合物は＋でつないだものまで
  const units: T[][] = [];
  for (const m of measured) {
    const last = units.at(-1);
    const joins = last && (m.item.kind === 'plus' || last.at(-1)!.item.kind === 'plus');
    if (joins && m.item.kind !== 'arrow' && last.at(-1)!.item.kind !== 'arrow') last.push(m);
    else units.push([m]);
  }
  const unitW = (u: T[]) => u.reduce((n, m) => n + m.w + GAP, 0);
  const canBreakAfter = (u: T[]) => (u[0].item.kind === 'arrow' ? wrapAt.arrow : wrapAt.compound);
  const rows: T[][][] = [[]];
  for (const u of units) {
    let row = rows.at(-1)!;
    const used = row.reduce((n, x) => n + unitW(x), 0);
    if (row.length && used + unitW(u) - GAP > width) {
      // 最後に折り返してよい所を探し、その後ろを次の行へ送る
      let cut = -1;
      for (let i = row.length - 1; i >= 0; i--)
        if (canBreakAfter(row[i])) {
          cut = i;
          break;
        }
      if (cut >= 0) {
        const moved = row.splice(cut + 1);
        row = [...moved];
        rows.push(row);
        // 送った物と合わせても入らなければ、送った物の後ろでも折り返せるか試す（長い行を何度も折る）
        while (row.length && row.reduce((n, x) => n + unitW(x), 0) + unitW(u) - GAP > width) {
          let c2 = -1;
          for (let i = row.length - 1; i >= 0; i--)
            if (canBreakAfter(row[i])) {
              c2 = i;
              break;
            }
          if (c2 < 0) break;
          row = row.splice(c2 + 1);
          rows.push(row);
        }
      }
    }
    row.push(u);
  }
  return rows.map((r) => r.flat()).filter((r) => r.length);
}

function renderSchemeOnlyNow(doc: Doc, schemeId: string): Doc {
  const scheme = doc.schemes?.[schemeId];
  if (!scheme) return doc;
  const compounds = schemeCompounds(doc, scheme);
  const style = scheme.pinned?.style ?? getStyle(scheme.styleId, doc.styles);
  const measured = schemeItems(scheme).map((it) => measureItem(it, scheme, compounds, style));

  const rows = wrapRows(measured, rowWidth(doc, scheme.origin.x, style.maxRowWidth), wrapAtOf(style));

  return edit(doc, (d) => {
    clearScheme(d, schemeId);
    let top = scheme.origin.y;
    let maxRight = scheme.origin.x;
    for (const row of rows) {
      const up = Math.max(...row.map((m) => m.up));
      // 化合物番号は、行の中でいちばん下の分子にそろえる
      const boxDown = Math.max(0, ...row.filter((m) => m.box).map((m) => m.down));
      const labelLines = Math.max(0, ...row.map((m) => m.labels?.length ?? 0));
      const down = Math.max(...row.map((m) => m.down), boxDown + (labelLines ? labelLines * lineH() + 6 : 0));
      const cy = top + up;
      const labelY = cy + boxDown + 6 + capH();
      let cx = scheme.origin.x;
      for (const m of row) {
        placeItem(d, schemeId, m, cx, cy, labelY, compounds);
        cx += m.w + GAP;
      }
      maxRight = Math.max(maxRight, cx - GAP);
      top = cy + down + BOND_LEN * 1.5;
    }
    if (style.conditions === 'footnote' && scheme.steps.length) {
      const notes = scheme.steps.map((st, i) => footnoteText(st, i, style));
      // 脚注は図の幅で折り返す（狭すぎるときは 240pt）
      const width = Math.max(240, maxRight - scheme.origin.x);
      const body = notes.join('; ');
      const lines = wrapWords(`Reagents and conditions: ${body}${body.endsWith('.') ? '' : '.'}`, width);
      lines.forEach((line, i) => addText(d, schemeId, scheme.origin.x, top + capH() + i * lineH(), line, { formula: true }));
    }
  });
}

function addText(d: Doc, schemeId: string, x: number, y: number, text: string, opt: { bold?: boolean; formula?: boolean }) {
  const id = newId(d, 't');
  d.texts[id] = { id, x, y, text, ref: schemeId, ...(opt.bold ? { bold: true } : {}), ...(opt.formula ? { formula: true } : {}) };
}

function placeItem(d: Doc, schemeId: string, m: Measured, x: number, cy: number, labelY: number, compounds: Record<string, Compound>) {
  const item = m.item;
  if (item.kind === 'plus') {
    const id = newId(d, 'p');
    d.pluses[id] = { id, x: x + m.w / 2, y: cy, ref: schemeId };
    return;
  }
  if (item.kind === 'arrow') {
    const id = newId(d, 'r');
    d.arrows[id] = { id, x1: x, y1: cy, x2: x + m.w, y2: cy, kind: 'normal', ref: schemeId };
    const { above, below } = m.arrow!;
    above.forEach((a, i) => addText(d, schemeId, x + (m.w - measure(a)) / 2, cy - 6 - (above.length - 1 - i) * lineH(), a, { formula: true }));
    below.forEach((b, i) => addText(d, schemeId, x + (m.w - measure(b)) / 2, cy + 6 + capH() + i * lineH(), b, { formula: true }));
    return;
  }
  const c = compounds[item.id];
  const box = m.box!;
  // 構造の範囲の中心を、項目の幅の中心と行の中心に合わせる
  const dx = x + m.w / 2 - (box.x1 + box.x2) / 2;
  const dy = cy - (box.y1 + box.y2) / 2;
  if (c) {
    const map = new Map<string, string>();
    for (const a of Object.values(c.structure.atoms)) {
      const id = newId(d, 'a');
      map.set(a.id, id);
      d.atoms[id] = { ...a, id, x: a.x + dx, y: a.y + dy, ref: compoundKey(schemeId, c.id) };
    }
    remapUnits([...map.values()].map((id) => d.atoms[id]), () => newId(d, 'u'));
    for (const b of Object.values(c.structure.bonds)) {
      const id = newId(d, 'b');
      d.bonds[id] = { ...b, id, a1: map.get(b.a1)!, a2: map.get(b.a2)! };
    }
    for (const g of Object.values(c.structure.groups)) {
      const id = newId(d, 'g');
      d.groups[id] = { ...g, id, atomIds: g.atomIds.map((a) => map.get(a)!), attachId: map.get(g.attachId)! };
    }
  }
  let ly = labelY;
  for (const l of m.labels ?? []) {
    const w = measure(l.text, false) * (l.bold ? 1.08 : 1);
    addText(d, schemeId, x + (m.w - w) / 2, ly, l.text, { bold: l.bold });
    ly += lineH();
  }
}

function wrapWords(text: string, width: number): string[] {
  const words = text.split(/(?<=[,;] )|(?<= )/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && measure(cur + w) > width) {
      lines.push(cur.trimEnd());
      cur = w;
    } else cur += w;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

// 検討表の図の文字が、表のどの行・どの列のセルかを引く。図の文字をダブルクリックしたとき、下の表のそのセルへ入れるために使う
import type { Doc } from '../chem/model';
import { measure } from '../scheme/layout';

export interface TableCellTarget {
  tableId: string;
  /** 行の番号（0 から）。見出しを押したときは -1 */
  row: number;
  /** 列の番号（0 から） */
  col: number;
}

/** 文字 id が指すセル。表の文字でない・題や注の文字なら null */
export function tableCellOf(doc: Doc, textId: string): TableCellTarget | null {
  const hit = doc.texts[textId];
  const table = hit?.ref ? doc.tables?.[hit.ref] : undefined;
  if (!hit || !table) return null;
  // 表の罫線（上・見出しの下・下）の間にある文字だけを見る
  const rules = Object.values(doc.arrows)
    .filter((r) => r.ref === table.id && Math.abs(r.y1 - r.y2) < 0.01)
    .map((r) => r.y1)
    .sort((a, b) => a - b);
  if (rules.length < 3) return null;
  const [top, mid, bottom] = [rules[0], rules[1], rules[rules.length - 1]];
  // 題（上の罫線より上）と注（下の罫線より下）はセルではない
  if (hit.y < top || hit.y > bottom + 0.01) return null;
  const texts = Object.values(doc.texts).filter((t) => t.ref === table.id && t.y > top && t.y < bottom + 0.01);
  const center = (t: { x: number; text: string; formula?: boolean }) => t.x + measure(t.text.split('\n')[0], !!t.formula) / 2;
  // 見出しの文字（上の罫線と見出しの下の罫線の間）を左から並べると、列の順になる
  const header = texts.filter((t) => t.y < mid).sort((a, b) => a.x - b.x);
  if (header.length !== table.columns.length) return null;
  const cx = center(hit);
  let col = 0;
  header.forEach((h, i) => {
    if (Math.abs(center(h) - cx) < Math.abs(center(header[col]) - cx)) col = i;
  });
  if (hit.y < mid) return { tableId: table.id, row: -1, col };
  // 行: 行の番号の列（いちばん左の見出しの下）の文字を上から並べると、行の順になる
  const firstX = center(header[0]);
  const entries = texts.filter((t) => t.y > mid && Math.abs(center(t) - firstX) < 12).sort((a, b) => a.y - b.y);
  if (entries.length !== table.rows.length) return null;
  let row = 0;
  entries.forEach((e, i) => {
    if (Math.abs(e.y - hit.y) < Math.abs(entries[row].y - hit.y)) row = i;
  });
  return { tableId: table.id, row, col };
}

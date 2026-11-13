// ページ（紙）の設定。A4 か PowerPoint のスライド 1 枚を単位に、横と縦に何枚並べるかでキャンバスの大きさを決める。
// ページは文書の座標の (0, 0) から右と下へ並べる（CDXML の page と同じ置き方）。単位は pt（1/72 インチ）
import type { Rect } from './geometry';

export type PageSize = 'a4' | 'slide16x9' | 'slide4x3';

export interface PageSetup {
  size: PageSize;
  /** A4 の向き（スライドは横の形で決まっているので使わない） */
  landscape?: boolean;
  /** 横に並べる枚数・縦に並べる枚数（1 以上） */
  cols: number;
  rows: number;
}

export const PAGE_SIZES: Record<PageSize, { name: string; w: number; h: number; mm: [number, number] }> = {
  a4: { name: 'A4', w: (210 / 25.4) * 72, h: (297 / 25.4) * 72, mm: [210, 297] },
  // PowerPoint の既定のスライド（ワイド画面 13.333 × 7.5 インチ、標準 10 × 7.5 インチ）
  slide16x9: { name: 'スライド（16:9）', w: 960, h: 540, mm: [338.67, 190.5] },
  slide4x3: { name: 'スライド（4:3）', w: 720, h: 540, mm: [254, 190.5] },
};

export const MAX_PAGES = 10;

/** 1 枚の大きさ（pt）と、印刷のときの紙の大きさ（mm） */
export function pageDims(p: PageSetup): { w: number; h: number; mmW: number; mmH: number } {
  const s = PAGE_SIZES[p.size];
  const turn = p.size === 'a4' && !!p.landscape;
  return turn ? { w: s.h, h: s.w, mmW: s.mm[1], mmH: s.mm[0] } : { w: s.w, h: s.h, mmW: s.mm[0], mmH: s.mm[1] };
}

/** ページの並び（左上から横へ、行ごとに下へ） */
export function pageRects(p: PageSetup): Rect[] {
  const { w, h } = pageDims(p);
  const out: Rect[] = [];
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) out.push({ x1: c * w, y1: r * h, x2: (c + 1) * w, y2: (r + 1) * h });
  return out;
}

/** ページ全体の範囲 */
export function pagesBox(p: PageSetup): Rect {
  const { w, h } = pageDims(p);
  return { x1: 0, y1: 0, x2: p.cols * w, y2: p.rows * h };
}

const clampPages = (n: number) => Math.min(MAX_PAGES, Math.max(1, Math.round(n) || 1));

/** 正しい形に直す（枚数は 1〜MAX_PAGES） */
export function normalizePage(p: PageSetup): PageSetup {
  const size: PageSize = p.size in PAGE_SIZES ? p.size : 'a4';
  return { size, ...(size === 'a4' && p.landscape ? { landscape: true } : {}), cols: clampPages(p.cols), rows: clampPages(p.rows) };
}

/** 図（の範囲）が収まる枚数。図が無ければ 1 枚 */
export function pagesToFit(p: PageSetup, box: Rect | null): PageSetup {
  if (!box) return normalizePage({ ...p, cols: 1, rows: 1 });
  const { w, h } = pageDims(p);
  return normalizePage({ ...p, cols: Math.ceil(Math.max(1, box.x2) / w), rows: Math.ceil(Math.max(1, box.y2) / h) });
}

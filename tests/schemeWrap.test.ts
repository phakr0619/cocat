// スキームの行の折り返し位置
import { describe, expect, it } from 'vitest';
import { PAGE_MARGIN, rowWidth, wrapRows } from '../src/scheme/layout';
import { wrapAtOf } from '../src/scheme/style';

// 化合物 100、矢印 80、＋ 20 の幅（並べるときの間 GAP も足される）
const c = (id: string) => ({ item: { kind: 'compound' as const, id }, w: 100 });
const a = (step: number) => ({ item: { kind: 'arrow' as const, step }, w: 80 });
const plus = () => ({ item: { kind: 'plus' as const }, w: 20 });
const names = (rows: ReturnType<typeof wrapRows>) =>
  rows.map((r) => r.map((m) => (m.item.kind === 'compound' ? m.item.id : m.item.kind === 'arrow' ? '→' : '+')).join(' '));

// A → B → C → D
const chain = [c('A'), a(0), c('B'), a(1), c('C'), a(2), c('D')];

describe('行の折り返し位置', () => {
  it('化合物の後だけ（今までと同じ）: 行の右端はいつも化合物、次の行は矢印から', () => {
    expect(names(wrapRows(chain, 450, { arrow: false, compound: true }))).toEqual(['A → B', '→ C → D']);
  });

  it('矢印の後だけ: 行の右端はいつも矢印、次の行は化合物から', () => {
    expect(names(wrapRows(chain, 450, { arrow: true, compound: false }))).toEqual(['A → B →', 'C → D']);
  });

  it('両方: 入る所まで詰める', () => {
    expect(names(wrapRows(chain, 450, { arrow: true, compound: true }))).toEqual(['A → B →', 'C → D']);
    expect(names(wrapRows(chain, 380, { arrow: true, compound: true }))).toEqual(['A → B', '→ C →', 'D']);
  });

  it('＋でつないだ化合物の途中では折り返さない', () => {
    const items = [c('A'), plus(), c('B'), a(0), c('C'), plus(), c('D')];
    expect(names(wrapRows(items, 300, { arrow: true, compound: true }))).toEqual(['A + B', '→', 'C + D']);
  });

  it('折り返してよい所が無ければ、はみ出して並べる。長い並びは何度でも折る', () => {
    expect(names(wrapRows(chain, 50, { arrow: false, compound: true }))).toEqual(['A', '→ B', '→ C', '→ D']);
    expect(names(wrapRows([c('A'), plus(), c('B')], 50, { arrow: true, compound: true }))).toEqual(['A + B']);
  });

  it('古い書式（折り返し位置が無い・両方外れている）は、化合物の後だけ', () => {
    expect(wrapAtOf({})).toEqual({ arrow: false, compound: true });
    expect(wrapAtOf({ wrapAt: { arrow: false, compound: false } })).toEqual({ arrow: false, compound: true });
    expect(wrapAtOf({ wrapAt: { arrow: true, compound: false } })).toEqual({ arrow: true, compound: false });
  });
});

describe('行の幅', () => {
  it('ページが無ければ書式の行の幅。あれば、スキームの左端からページの右端の少し内側まで', () => {
    expect(rowWidth({}, 40, 500)).toBe(500);
    const page = { size: 'slide16x9' as const, cols: 2, rows: 1 };
    expect(rowWidth({ page }, 40, 500)).toBe(960 - PAGE_MARGIN - 40);
    // 2 枚目のページから始まるスキームは、2 枚目の右端まで
    expect(rowWidth({ page }, 1000, 500)).toBe(1920 - PAGE_MARGIN - 1000);
    // 右端の近くから始まると狭すぎるので 150、ページの外なら書式の行の幅
    expect(rowWidth({ page }, 900, 500)).toBe(150);
    expect(rowWidth({ page }, 2000, 500)).toBe(500);
    expect(rowWidth({ page }, -10, 500)).toBe(500);
  });
});

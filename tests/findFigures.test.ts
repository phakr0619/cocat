import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { figureToCrop, parseFigures } from '../src/llm/findFigures';

describe('図の位置の答え', () => {
  it('box_2d（[ymin, xmin, ymax, xmax]、0〜1000）を割合の四角にし、上から並べる', () => {
    const f = parseFigures({
      figures: [
        { box_2d: [500, 100, 700, 900], kind: 'reaction-scheme', label: ' Scheme 2 ' },
        { box_2d: [100, 200, 300, 800], kind: 'structure' },
      ],
    });
    expect(f.map((x) => x.kind)).toEqual(['structure', 'reaction-scheme']);
    expect(f[1]).toEqual({ x: 0.1, y: 0.5, width: expect.closeTo(0.8), height: expect.closeTo(0.2), label: 'Scheme 2', kind: 'reaction-scheme' });
  });
  it('形のおかしい四角・小さすぎる四角は捨て、はみ出しは切り、逆向きは直す。知らない kind は other', () => {
    const f = parseFigures({
      figures: [{ box_2d: [1, 2, 3] }, { box_2d: [10, 10, 12, 12], kind: 'reaction-scheme' }, { box_2d: [900, 1200, -50, 0], kind: 'plot' }, { box_2d: ['a', 0, 1, 1] }],
    });
    expect(f).toEqual([{ x: 0, y: 0, width: 1, height: 0.9, label: '', kind: 'other' }]);
    expect(parseFigures(null)).toEqual([]);
    expect(parseFigures({ figures: 'x' })).toEqual([]);
  });
  it('PDF の座標にし、余白を足す（ページの外には出さない）', () => {
    const page = { width: 600, height: 800 };
    expect(figureToCrop({ x: 0.1, y: 0.5, width: 0.5, height: 0.25, label: '', kind: 'reaction-scheme' }, page, 6)).toEqual({ x: 54, y: 394, width: 312, height: 212 });
    expect(figureToCrop({ x: 0, y: 0.9, width: 1, height: 0.1, label: '', kind: 'reaction-scheme' }, page, 6)).toEqual({ x: 0, y: 714, width: 600, height: 86 });
  });
});

// 本物の Gemini の答え（npm run eval:llm-figures を RECORD=1 で回したもの）から、同じ範囲を作れること
const REC = 'tests/llm-eval/recorded-figures/gemini-3.8-flash-low.json';
describe.skipIf(!existsSync(REC))('記録した図の位置の答え', () => {
  const rec = JSON.parse(readFileSync(REC, 'utf8')) as { page: { width: number; height: number }; pad: number; cases: Record<string, { crop?: unknown; raw: unknown }> };
  it(`記録した ${Object.keys(rec.cases).length} 件すべてで、記録と同じ範囲になる`, () => {
    const changed = Object.entries(rec.cases).filter(([, c]) => {
      const schemes = parseFigures(c.raw).filter((f) => f.kind === 'reaction-scheme');
      const crop = schemes.length === 1 ? figureToCrop(schemes[0], rec.page, rec.pad) : undefined;
      return JSON.stringify(crop) !== JSON.stringify(c.crop);
    });
    expect(changed.map(([id]) => id)).toEqual([]);
  });
});

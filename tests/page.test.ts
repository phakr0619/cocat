// ページの設定（A4・スライドを単位に並べるキャンバス）と、ページごとの印刷
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { normalizePage, pageDims, pageRects, pagesToFit } from '../src/chem/page';
import { writeCdxml } from '../src/io/cdxml';
import { importText } from '../src/io/convert';
import { parseDocFile, serializeDoc } from '../src/io/docfile';
import { printHtml } from '../src/io/print';
import { setPage } from '../src/ui/PageSetupDialog';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

describe('ページの大きさと並び', () => {
  it('A4 は 595 × 842 pt（横なら入れ替え）、スライドは PowerPoint の既定の大きさ', () => {
    expect(pageDims({ size: 'a4', cols: 1, rows: 1 })).toMatchObject({ mmW: 210, mmH: 297 });
    expect(pageDims({ size: 'a4', cols: 1, rows: 1 }).w).toBeCloseTo(595.28, 1);
    expect(pageDims({ size: 'a4', landscape: true, cols: 1, rows: 1 }).h).toBeCloseTo(595.28, 1);
    expect(pageDims({ size: 'slide16x9', cols: 1, rows: 1 })).toMatchObject({ w: 960, h: 540 });
    expect(pageDims({ size: 'slide4x3', cols: 1, rows: 1 })).toMatchObject({ w: 720, h: 540 });
  });
  it('左上から横へ、行ごとに下へ並べる', () => {
    const r = pageRects({ size: 'slide16x9', cols: 2, rows: 2 });
    expect(r.map((x) => [x.x1, x.y1])).toEqual([[0, 0], [960, 0], [0, 540], [960, 540]]);
  });
  it('枚数は 1〜10 に直し、スライドには向きを持たせない', () => {
    expect(normalizePage({ size: 'a4', cols: 0, rows: 99 })).toEqual({ size: 'a4', cols: 1, rows: 10 });
    expect(normalizePage({ size: 'slide16x9', landscape: true, cols: 2, rows: 1 })).toEqual({ size: 'slide16x9', cols: 2, rows: 1 });
  });
  it('「図に合わせる」は、図の右下が入る枚数', () => {
    const p = { size: 'slide16x9' as const, cols: 1, rows: 1 };
    expect(pagesToFit(p, { x1: 10, y1: 10, x2: 1000, y2: 500 })).toMatchObject({ cols: 2, rows: 1 });
    expect(pagesToFit(p, null)).toMatchObject({ cols: 1, rows: 1 });
  });
});

describe('ページの設定のある文書', () => {
  const withPage = () => setPage(importText(emptyDoc(), 'CCO').doc, { size: 'a4', landscape: true, cols: 2, rows: 1 });

  it('文書のファイルに残り、ページをやめると消える', () => {
    const d = withPage();
    expect(parseDocFile(serializeDoc(d)).page).toEqual({ size: 'a4', landscape: true, cols: 2, rows: 1 });
    expect(setPage(d, null).page).toBeUndefined();
  });

  it('印刷は 1 ページずつ、ページと同じ大きさの紙に原寸で出す', () => {
    const h = printHtml(withPage(), 'Letter');
    expect(h).toContain('@page { size: 297mm 210mm; margin: 0; }');
    expect(h.match(/class="page"/g)).toHaveLength(2);
    expect(h).toContain('data-pages="2"');
    // 2 ページ目は、キャンバスの右のページの範囲を切り出す
    expect(h).toMatch(/data-page="2"><svg[^>]*viewBox="841\.89 0 841\.89 595\.28"/);
    expect(h).toMatch(/width="297mm" height="210mm"/);
  });

  it('ページの設定が無ければ、今までどおり図を紙に収める', () => {
    expect(printHtml(importText(emptyDoc(), 'CCO').doc, 'A4')).toContain('data-paper="A4"');
  });

  it('CDXML の page に、ページの大きさと枚数を書く', () => {
    const x = writeCdxml(setPage(importText(emptyDoc(), 'CCO').doc, { size: 'slide16x9', cols: 3, rows: 2 }));
    expect(x).toMatch(/<page [^>]*BoundingBox="0 0 2880 1080"[^>]*HeightPages="2" WidthPages="3"/);
    expect(writeCdxml(importText(emptyDoc(), 'CCO').doc)).toMatch(/<page [^>]*BoundingBox="0 0 540 720"/);
  });
});

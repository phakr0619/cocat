// 文字の書式（上付き・下付き・斜体・太字）と、物の色
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc, type Doc } from '../src/chem/model';
import { setColor } from '../src/chem/ops';
import { addArrow, setText } from '../src/chem/schemeOps';
import { addShape } from '../src/editor/tools3';
import { cdxmlToCdx, cdxToCdxml } from '../src/io/cdx';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { exportSvg, importText } from '../src/io/convert';
import { layout, textRuns } from '../src/render/layout';
import { parseRich } from '../src/render/text';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const viaCdxml = (d: Doc) => readCdxml(writeCdxml(d));
const viaCdx = (d: Doc) => readCdxml(cdxToCdxml(cdxmlToCdx(writeCdxml(d))));

describe('文字の書き方', () => {
  it('^{…}・^x は上付き、_{…}・_x は下付き、*…* は斜体、**…** は太字。\\ の次はそのまま。* が 1 つだけなら文字', () => {
    expect(parseRich('Pd^{2+}')).toEqual([{ text: 'Pd' }, { text: '2+', script: 'sup' }]);
    expect(parseRich('k_{obs} = 3')).toEqual([{ text: 'k' }, { text: 'obs', script: 'sub' }, { text: ' = 3' }]);
    expect(parseRich('*t*-BuOK')).toEqual([{ text: 't', italic: true }, { text: '-BuOK' }]);
    expect(parseRich('**1a**')).toEqual([{ text: '1a', bold: true }]);
    expect(parseRich('a\\*b')).toEqual([{ text: 'a*b' }]);
    expect(parseRich('R*')).toEqual([{ text: 'R*' }]);
    expect(parseRich('x^2')).toEqual([{ text: 'x' }, { text: '2', script: 'sup' }]);
  });

  it('描くと、上付きは小さく上に、斜体は斜体で。化学式の書き方と一緒にも使える。SVG にも出る', () => {
    const r = textRuns('Pd^{2+}', false);
    expect(r[1].size).toBeLessThan(r[0].size);
    expect(r[1].shift).toBeLessThan(0);
    const f = textRuns('*t*-BuOK in CH2Cl2', true);
    expect(f[0]).toMatchObject({ text: 't', italic: true });
    expect(f.some((x) => x.text === '2' && x.shift > 0)).toBe(true);
    const d = setText(emptyDoc(), null, { x: 0, y: 0 }, '*t*-BuOK, Cu^{I}');
    const svg = exportSvg(d);
    expect(svg).toContain('font-style="italic"');
    expect(svg).toMatch(/dy="-[\d.]+">I</);
  });

  it('CDXML と CDX に ChemDraw の文字の飾り（face）で書き、同じ書き方に読み戻せる', () => {
    let d = setText(emptyDoc(), null, { x: 0, y: 0 }, '*t*-BuOK, Pd^{2+}, k_{obs}, **1a**');
    d = setText(d, null, { x: 0, y: 30 }, 'R* と 5_0');
    const xml = writeCdxml(d);
    expect(xml).toMatch(/face="2"[^>]*>t</);
    expect(xml).toMatch(/face="64"[^>]*>2\+</);
    expect(xml).toMatch(/face="32"[^>]*>obs</);
    for (const back of [viaCdxml(d), viaCdx(d)]) {
      // 書き方の印の付け方（\ の有無）は変わってよいが、描く文字は同じ
      expect(Object.values(back.texts).map((t) => parseRich(t.text)).sort()).toEqual(Object.values(d.texts).map((t) => parseRich(t.text)).sort());
      expect(Object.values(back.texts).map((t) => t.text)).toContain('*t*-BuOK, Pd^{2+}, k_{obs}, **1a**');
    }
  });

  it('ChemDraw の文字に ^ や * がそのまま入っていても、書き方の印とは読まない', () => {
    const xml = writeCdxml(emptyDoc()).replace('</page>', '<t p="0 0"><s font="3" size="10" face="0">a^b *c*</s></t></page>');
    const t = Object.values(readCdxml(xml).texts)[0];
    expect(parseRich(t.text)).toEqual([{ text: 'a^b *c*' }]);
  });
});

describe('色', () => {
  it('選んだ物の色を変え、原子どうしの結合も同じ色にする。黒に戻せる', () => {
    let d = importText(emptyDoc(), 'CCO').doc;
    const ids = Object.keys(d.atoms);
    d = setColor(d, ids, '#d32f2f');
    expect(Object.values(d.bonds).every((b) => b.color === '#d32f2f')).toBe(true);
    const o = Object.values(d.atoms).find((a) => a.element === 'O')!;
    expect(layout(d).prims.filter((p) => p.owner === o.id).every((p) => p.color === '#d32f2f')).toBe(true);
    expect(exportSvg(d)).toContain('fill="#d32f2f"');
    d = setColor(d, ids, undefined);
    expect(Object.values(d.bonds).some((b) => b.color)).toBe(false);
  });

  it('CDXML と CDX の色の表に書き、原子・結合・文字・矢印・図形・＋の色を読み戻せる', () => {
    let d = importText(emptyDoc(), 'CO').doc;
    d = addArrow(d, { x: 0, y: 60 }, { x: 40, y: 60 }, 'normal');
    d = setText(d, null, { x: 0, y: 90 }, 'rt');
    d = addShape(d, 'rect', { x: 0, y: 100 }, { x: 40, y: 130 });
    const all = [...Object.keys(d.atoms), ...Object.keys(d.arrows), ...Object.keys(d.texts), ...Object.keys(d.shapes!)];
    d = setColor(d, all.slice(0, 2), '#1e5bd8');
    d = setColor(d, all.slice(2), '#2e7d32');
    const xml = writeCdxml(d);
    expect(xml).toContain('<color r="0.12" g="0.36" b="0.85"/>');
    for (const back of [viaCdxml(d), viaCdx(d)]) {
      expect(Object.values(back.atoms).map((a) => a.color)).toEqual(['#1f5cd9', '#1f5cd9']);
      expect(Object.values(back.bonds).map((b) => b.color)).toEqual(['#1f5cd9']);
      expect(Object.values(back.arrows)[0].color).toBe('#2e7d33');
      expect(Object.values(back.texts)[0].color).toBe('#2e7d33');
      expect(Object.values(back.shapes!)[0].color).toBe('#2e7d33');
    }
  });
});

describe('図の設定（線の太さ・文字の大きさ）', () => {
  it('文書ごとに線の太さと文字の大きさを変え、描いたあとは元の値に戻る。CDXML の頭にも書く。保存で残る', async () => {
    const { setDrawStyle } = await import('../src/ui/DrawStyleDialog');
    const { ACS } = await import('../src/chem/style');
    const { parseDocFile, serializeDoc } = await import('../src/io/docfile');
    const { SAMPLES } = await import('../src/samples');
    let d = importText(emptyDoc(), 'CCO').doc;
    d = setDrawStyle(d, { lineWidth: 1.0, fontSize: 12 });
    const lay = layout(d);
    expect(lay.prims.filter((p) => p.k === 'line').every((p) => p.k === 'line' && p.w === 1.0)).toBe(true);
    const o = Object.values(d.atoms).find((a) => a.element === 'O')!;
    expect(lay.labels.get(o.id)!.runs[0].size).toBe(12);
    expect(ACS.lineWidth).toBe(0.6);
    expect(ACS.labelSize).toBe(10);
    expect(writeCdxml(d)).toMatch(/LineWidth="1(\.00?)?"[^>]* LabelSize|LabelSize="12"/);
    expect(parseDocFile(serializeDoc(d)).drawStyle).toEqual({ lineWidth: 1.0, fontSize: 12 });
    // 既定の値に戻すと、設定ごと外す
    expect(setDrawStyle(d, { lineWidth: 0.6, fontSize: 10 }).drawStyle).toBeUndefined();
    // スキームの条件の文字は、大きい文字の分だけ行の間を広げて描き直す
    const r = SAMPLES.find((x) => x.id === 'coupling')!.build();
    const big = setDrawStyle(r, { fontSize: 14 });
    // 条件の行どうしの間（いちばん狭いもの）
    const gap = (x: Doc) => {
      const ys = Object.values(x.texts).map((t) => t.y).sort((a, b) => a - b);
      return Math.min(...ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 1));
    };
    expect(Object.keys(r.schemes!)).toHaveLength(1);
    expect(gap(big)).toBeGreaterThan(gap(r));
  });
});

describe('印刷・PDF', () => {
  it('図を紙に収めたページを作る。横長の図は横向き、大きな図は縮める、小さな図は原寸', async () => {
    const { printHtml } = await import('../src/io/print');
    const small = importText(emptyDoc(), 'CCO').doc;
    const h1 = printHtml(small, 'A4');
    expect(h1).toContain('@page { size: A4');
    expect(h1).toContain('data-scale="1.000"');
    // 横に長い図（矢印を遠くまで）
    let wide = importText(emptyDoc(), 'CCO').doc;
    wide = addArrow(wide, { x: 0, y: 0 }, { x: 1500, y: 0 }, 'normal');
    const h2 = printHtml(wide, 'Letter');
    expect(h2).toContain('size: Letter landscape');
    const k = parseFloat(h2.match(/data-scale="([\d.]+)"/)![1]);
    expect(k).toBeLessThan(1);
    expect(h2).toContain('<svg');
  });
});

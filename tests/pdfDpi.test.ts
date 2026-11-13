import { describe, expect, it } from 'vitest';
import { isLowRes, LOW_RES_DPI, lowestDpi, placedImages, type Matrix, type PdfOps } from '../src/llm/pdf';

// pdfjs-dist 6.4.299 の OPS（node_modules/pdfjs-dist/build/pdf.worker.mjs）
const OPS: PdfOps & { paintImageMaskXObject: number } = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
};

type Op = [number, unknown];
const run = (ops: Op[]) => placedImages(OPS, ops.map((o) => o[0]), ops.map((o) => o[1]));
const near = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('placedImages: 描く命令の並びから、画像の紙の上の大きさと解像度', () => {
  it('単位正方形を CTM で写した大きさが、紙の上の大きさ。200 px を 144 pt に置けば 100 dpi', () => {
    const [im] = run([
      [OPS.save, []],
      [OPS.transform, [144, 0, 0, 72, 50, 100]],
      [OPS.paintImageXObject, ['img_1', 200, 100]],
      [OPS.restore, []],
    ]);
    near(im.ptWidth, 144);
    near(im.ptHeight, 72);
    near(im.dpi, 100);
    expect(im.box).toEqual([50, 100, 194, 172]);
  });

  it('縦横の dpi が違えば、低いほう', () => {
    const [im] = run([[OPS.transform, [72, 0, 0, 72, 0, 0]], [OPS.paintImageXObject, ['a', 144, 72]]]);
    near(im.dpi, 72);
  });

  it('save/restore で CTM が戻る。restore の後の画像は、外側の変換だけで置かれる', () => {
    const images = run([
      [OPS.transform, [0.5, 0, 0, 0.5, 0, 0]],
      [OPS.save, []],
      [OPS.transform, [200, 0, 0, 200, 10, 10]],
      [OPS.paintImageXObject, ['a', 100, 100]], // 100 pt に 100 px = 72 dpi
      [OPS.restore, []],
      [OPS.save, []],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ['b', 100, 100]], // 50 pt に 100 px = 144 dpi
      [OPS.restore, []],
    ]);
    expect(images).toHaveLength(2);
    near(images[0].dpi, 72);
    near(images[1].dpi, 144);
    expect(images[0].box).toEqual([5, 5, 105, 105]);
  });

  it('フォーム（paintFormXObjectBegin の行列）の中で CTM が掛かり、End で戻る', () => {
    const images = run([
      [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 0, 0], [0, 0, 100, 100]]],
      [OPS.save, []],
      [OPS.transform, [36, 0, 0, 36, 5, 5]], // フォームの 2 倍で 72 pt
      [OPS.paintImageXObject, ['a', 72, 72]], // 72 dpi
      [OPS.restore, []],
      [OPS.paintFormXObjectEnd, []],
      [OPS.transform, [72, 0, 0, 72, 0, 0]],
      [OPS.paintImageXObject, ['b', 144, 144]], // フォームの外: 144 dpi
    ]);
    near(images[0].dpi, 72);
    expect(images[0].box).toEqual([10, 10, 82, 82]);
    near(images[1].dpi, 144);
  });

  it('beginGroup/endGroup は CTM を戻す。フォームの行列が無い（null）フォームも扱える', () => {
    const images = run([
      [OPS.beginGroup, [{}]],
      [OPS.paintFormXObjectBegin, [null, null]],
      [OPS.transform, [72, 0, 0, 72, 0, 0]],
      [OPS.paintImageXObject, ['a', 72, 72]],
      [OPS.paintFormXObjectEnd, []],
      [OPS.endGroup, [{}]],
      [OPS.paintImageXObject, ['b', 72, 72]], // 戻った後は単位正方形（1 pt）。小さすぎて数えない
    ]);
    expect(images).toHaveLength(1);
    near(images[0].dpi, 72);
  });

  it('回転・傾きがあっても、列ベクトルの長さで大きさを出す（90 度回した画像）', () => {
    // 100 px を、x 軸を (0, 144) 、y 軸を (-72, 0) に写す: 幅 144 pt・高さ 72 pt
    const [im] = run([[OPS.transform, [0, 144, -72, 0, 200, 50]], [OPS.paintImageXObject, ['a', 288, 144]]]);
    near(im.ptWidth, 144);
    near(im.ptHeight, 72);
    near(im.dpi, 144);
    expect(im.box).toEqual([128, 50, 200, 194]);
  });

  it('インライン画像は args[0] の width/height。束ねたもの（Group）は map の 1 つずつ', () => {
    const images = run([
      [OPS.transform, [1, 0, 0, 1, 10, 10]],
      [OPS.save, []],
      [OPS.transform, [72, 0, 0, 72, 0, 0]],
      [OPS.paintInlineImageXObject, [{ width: 144, height: 144, data: new Uint8Array(0) }]],
      [OPS.restore, []],
      [OPS.paintInlineImageXObjectGroup, [{ width: 1, height: 1 }, [
        { transform: [36, 0, 0, 36, 200, 0], x: 0, y: 0, w: 36, h: 36 },
        { transform: [36, 0, 0, 36, 300, 0], x: 40, y: 0, w: 72, h: 72 },
      ]]],
    ]);
    expect(images).toHaveLength(3);
    near(images[0].dpi, 144);
    near(images[1].dpi, 72);
    near(images[2].dpi, 144);
    expect(images[1].box[0]).toBe(210);
  });

  it('マスク（paintImageMaskXObject）は数えない。ピクセル数が分からない・極端に小さい画像も数えない', () => {
    expect(
      run([
        [OPS.transform, [200, 0, 0, 200, 0, 0]],
        [OPS.paintImageMaskXObject, [{ width: 10, height: 10 }]],
        [OPS.paintImageXObject, ['a']],
      ]),
    ).toEqual([]);
    expect(run([[OPS.transform, [3, 0, 0, 3, 0, 0]], [OPS.paintImageXObject, ['a', 1, 1]]])).toEqual([]);
  });

  it('restore が多すぎても落ちない', () => {
    expect(() => run([[OPS.restore, []], [OPS.paintFormXObjectEnd, []], [OPS.transform, 'x'], [OPS.paintImageXObject, undefined]])).not.toThrow();
  });
});

describe('lowestDpi: 範囲に重なる画像のうち最も低い dpi', () => {
  // A4（595×842 pt）。PDF のユーザー空間は左下が原点（上向き）なので、画面（左上原点）にする変換 [1, 0, 0, -1, 0, 842] を渡す
  const view: Matrix = [1, 0, 0, -1, 0, 842];
  const page = { width: 595, height: 842 };
  // 紙の上の (100, 200)-(300, 400)（左上原点）に 72 dpi の画像
  const fig = { box: [100, 842 - 400, 300, 842 - 200] as [number, number, number, number], pxWidth: 200, pxHeight: 200, ptWidth: 200, ptHeight: 200, dpi: 72 };
  const bg = { box: [0, 0, 595, 842] as [number, number, number, number], pxWidth: 1240, pxHeight: 1754, ptWidth: 595, ptHeight: 842, dpi: 150 };

  it('画像が無ければ null（線の図）', () => {
    expect(lowestDpi([], view, page)).toBeNull();
    expect(lowestDpi([], view, page, { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
  });
  it('範囲が画像に重なれば、その dpi。離れていれば null', () => {
    expect(lowestDpi([fig], view, page, { x: 90, y: 190, width: 220, height: 220 })).toBe(72);
    expect(lowestDpi([fig], view, page, { x: 400, y: 500, width: 100, height: 100 })).toBeNull();
    // 縦方向がずれている範囲（上下を取り違えていれば重なってしまう位置）
    expect(lowestDpi([fig], view, page, { x: 100, y: 600, width: 200, height: 100 })).toBeNull();
  });
  it('範囲なしはページ全体。複数の画像があれば最も低いもの', () => {
    expect(lowestDpi([bg, fig], view, page)).toBe(72);
    expect(lowestDpi([bg], view, page)).toBe(150);
  });
  it('ほんの端が触れているだけの画像は数えない（重なりが小さいほうの 2 割未満）', () => {
    expect(lowestDpi([fig], view, page, { x: 295, y: 395, width: 100, height: 100 })).toBeNull();
    expect(lowestDpi([fig], view, page, { x: 250, y: 350, width: 100, height: 100 })).toBe(72);
  });
  it('ページが回転していても、画面の座標にしてから比べる（90 度回転: x 軸と y 軸が入れ替わる）', () => {
    // 回転 90 度の viewport 変換: 画面 x = y_user、画面 y = x_user（ページは 842×595 に見える）
    const rot: Matrix = [0, 1, 1, 0, 0, 0];
    const rotPage = { width: 842, height: 595 };
    const img = { ...fig, box: [100, 200, 300, 400] as [number, number, number, number] };
    expect(lowestDpi([img], rot, rotPage, { x: 200, y: 100, width: 200, height: 200 })).toBe(72);
    expect(lowestDpi([img], rot, rotPage, { x: 100, y: 200, width: 100, height: 100 })).toBeNull();
  });
});

describe('しきい値', () => {
  it('150 dpi 未満が低解像度。150 は警告しない（測った値の揺れ 149.9 も 150 とみなす）', () => {
    expect(LOW_RES_DPI).toBe(150);
    expect(isLowRes(72)).toBe(true);
    expect(isLowRes(149)).toBe(true);
    expect(isLowRes(149.9)).toBe(false);
    expect(isLowRes(150)).toBe(false);
    expect(isLowRes(200)).toBe(false);
    expect(isLowRes(null)).toBe(false);
    expect(isLowRes(undefined)).toBe(false);
  });
});

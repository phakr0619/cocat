import { describe, expect, it } from 'vitest';
import { cropScale, MAX_PDF_BYTES, parsePdfImageName, pdfFileError, pdfImageName } from '../src/llm/pdf';

describe('pdfFileError', () => {
  it('PDF は受ける（型でも拡張子でも）', () => {
    expect(pdfFileError({ type: 'application/pdf', size: 1000, name: 'paper.pdf' })).toBeNull();
    expect(pdfFileError({ type: '', size: 1000, name: 'Paper.PDF' })).toBeNull();
  });
  it('PDF でないものは断る', () => {
    expect(pdfFileError({ type: 'image/png', size: 1000, name: 'a.png' })).not.toBeNull();
  });
  it('100 MB を超えるものは断る', () => {
    expect(pdfFileError({ type: 'application/pdf', size: MAX_PDF_BYTES, name: 'a.pdf' })).toBeNull();
    expect(pdfFileError({ type: 'application/pdf', size: MAX_PDF_BYTES + 1, name: 'a.pdf' })).toBe('PDF が大きすぎます（100 MB まで）');
  });
});

describe('cropScale', () => {
  it('長辺が 2048 px になる倍率', () => {
    const r = cropScale(612, 792);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(792 * r.scale).toBeCloseTo(2048, 6);
  });
  it('小さい範囲は 600 dpi 相当（600/72）で止める', () => {
    const r = cropScale(100, 50);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.scale).toBeCloseTo(600 / 72, 10);
  });
  it('600 dpi 相当で描いても長辺が 300 px に満たなければ、小さすぎる', () => {
    expect(cropScale(30, 20)).toMatchObject({ ok: false, error: expect.stringContaining('範囲が小さすぎます') });
    expect(cropScale(0, 0)).toMatchObject({ ok: false });
    // ちょうど 300 px になる大きさは受ける
    expect(cropScale(36, 10)).toMatchObject({ ok: true });
  });
  it('大きい範囲は縮める', () => {
    const r = cropScale(5000, 3000);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.scale).toBeCloseTo(2048 / 5000, 10);
  });
});

describe('pdfImageName', () => {
  it('ページと範囲を名前にする', () => {
    expect(pdfImageName('paper.pdf', 3, true)).toBe('paper.pdf p.3 (crop)');
    expect(pdfImageName('paper.pdf', 3, false)).toBe('paper.pdf p.3');
  });
  it('名前から PDF のファイル名とページを読み戻せる。画像の名前は読まない', () => {
    expect(parsePdfImageName('my paper.pdf p.12 (crop)')).toEqual({ file: 'my paper.pdf', page: 12 });
    expect(parsePdfImageName('paper.pdf p.1')).toEqual({ file: 'paper.pdf', page: 1 });
    expect(parsePdfImageName('scheme.png')).toBeNull();
  });
});

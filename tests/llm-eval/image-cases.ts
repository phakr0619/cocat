// 画像からスキームの評価の件。画像は e2e/make-eval-images.spec.ts で、このアプリで描いて書き出したもの
import { readFileSync } from 'node:fs';
import { imageSummary } from '../../src/llm/image';
import type { LlmImage } from '../../src/llm/types';
import imageCases from './image-cases.json';
import { CASES, type EvalCase } from './score';

export interface ImageCase extends EvalCase {
  /** 正解を借りる件（cases.json） */
  base: string;
  /** 書式・解像度・番号の有無（難しさ） */
  variant: string;
  /** tests/llm-eval/images/ の中の名前 */
  file: string;
}

/** 正解は base の件と同じ。文章は送らない（画像だけ） */
export const IMAGE_CASES: ImageCase[] = imageCases.cases.map((c) => {
  const base = CASES.find((b) => b.id === c.base);
  if (!base) throw new Error(`image-cases.json: 無い件 ${c.base}`);
  return { ...base, id: c.id, title: `${base.title}（${c.variant}）`, text: '', existing: undefined, base: c.base, variant: c.variant, file: `${c.id}.png` };
});

/** PNG の幅と高さ（IHDR） */
export function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** アプリが送るのと同じ形（画像の説明と、base64 の画像） */
export function imageInput(c: ImageCase): { summary: string; images: LlmImage[] } {
  const buf = readFileSync(`tests/llm-eval/images/${c.file}`);
  const data = buf.toString('base64');
  return { summary: imageSummary({ name: c.file, mimeType: 'image/png', data, ...pngSize(buf), bytes: buf.length }), images: [{ mimeType: 'image/png', data }] };
}

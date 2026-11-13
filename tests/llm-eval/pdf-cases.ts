// PDF からスキームの評価の件。PDF と画像は e2e/make-eval-pdfs.spec.ts で、このアプリで描いた図から作ったもの
import { existsSync, readFileSync } from 'node:fs';
import { imageSummary } from '../../src/llm/image';
import type { LlmImage } from '../../src/llm/types';
import { IMAGE_CASES, type ImageCase } from './image-cases';
import pdfCases from './pdf-cases.json';

/** 図の位置を Gemini に見つけさせて切り出した件（MAKE_EVAL_PDFS=auto で作る。無ければ空） */
const AUTO_JSON = 'tests/llm-eval/pdf-auto-cases.json';
type RawCase = (typeof pdfCases.cases)[number] & { crop?: { x: number; y: number; width: number; height: number } };
const autoCases: RawCase[] = existsSync(AUTO_JSON) ? (JSON.parse(readFileSync(AUTO_JSON, 'utf8')) as { cases: RawCase[] }).cases : [];

export type PdfForm = 'png' | 'svg' | 'scan';
/** page: ページ全体、crop: 図の範囲（本当の位置）、auto: Gemini が見つけた図の範囲 */
export type PdfSend = 'page' | 'crop' | 'auto';
export const PDF_FORMS: PdfForm[] = ['png', 'svg', 'scan'];
export const PDF_SENDS: PdfSend[] = ['page', 'crop', 'auto'];

export interface PdfCase extends ImageCase {
  /** もとの画像の件の id（image-cases.json、例: amide-hatu-acs-200）。base は、画像の件と同じく文章の件の id（例: amide-hatu） */
  imageId: string;
  form: PdfForm;
  send: PdfSend;
  /** tests/llm-eval/pdfs/ の PDF */
  pdf: string;
  /** tests/llm-eval/pdf-images/ の PNG（アプリの cropToImage の出力そのもの） */
  png: string;
  width: number;
  height: number;
  bytes: number;
  /** 画像の説明に使う名前（例: 「x-svg.pdf p.1 (crop)」） */
  name: string;
  /** 切り出した範囲（PDF の座標、pt） */
  crop?: { x: number; y: number; width: number; height: number };
}

/** 正解は、もとの画像の件（image-cases → cases.json）と同じ。文章は送らない（画像だけ） */
export const PDF_CASES: PdfCase[] = [...(pdfCases.cases as RawCase[]), ...autoCases].map((c) => {
  const base = IMAGE_CASES.find((b) => b.id === c.base);
  if (!base) throw new Error(`pdf-cases.json: 無い件 ${c.base}`);
  return {
    ...base,
    id: c.id,
    imageId: c.base,
    title: `${base.title}［${c.form}・${c.send}］`,
    form: c.form as PdfForm,
    send: c.send as PdfSend,
    pdf: c.pdf,
    png: c.png,
    width: c.width,
    height: c.height,
    bytes: c.bytes,
    name: c.name,
    ...(c.crop ? { crop: c.crop } : {}),
  };
});

const pngPath = (c: PdfCase) => `tests/llm-eval/pdf-images/${c.png}`;

/** 画像があるか。ページ全体の PNG はリポジトリに入れていない（MAKE_EVAL_PDFS=pages で作る） */
export const hasPdfImage = (c: PdfCase): boolean => existsSync(pngPath(c));

/** アプリが送るのと同じ形（画像の説明と、base64 の画像） */
export function pdfInput(c: PdfCase): { summary: string; images: LlmImage[] } {
  if (!hasPdfImage(c))
    throw new Error(`${pngPath(c)} がありません。ページ全体の PNG は、先に MAKE_EVAL_PDFS=pages npx playwright test e2e/make-eval-pdfs.spec.ts で作ってください`);
  const data = readFileSync(pngPath(c)).toString('base64');
  return { summary: imageSummary({ name: c.name, mimeType: 'image/png', data, width: c.width, height: c.height, bytes: c.bytes }), images: [{ mimeType: 'image/png', data }] };
}

/** 記録した答えの流し直し用。画像が無ければ、説明は同じで中身の無い画像にする（答えは記録から返すので、画像の中身は使わない） */
export function pdfReplayInput(c: PdfCase): { summary: string; images: LlmImage[] } {
  if (hasPdfImage(c)) return pdfInput(c);
  return { summary: imageSummary({ name: c.name, mimeType: 'image/png', data: '', width: c.width, height: c.height, bytes: c.bytes }), images: [{ mimeType: 'image/png', data: '' }] };
}

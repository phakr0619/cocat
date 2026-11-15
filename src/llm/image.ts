// 画像から作るときに送る画像の用意
//
// 画像はブラウザの中で縮めてから送る。文書・下書きには画像を残さない（下書きに残すのはファイル名だけ）

import { providerInfo, PROVIDERS, type ProviderId } from './providers';
import type { LlmImage } from './types';

/** 既定の会社（Gemini）に送れる形式（値は接続の型の一覧 providers.ts にある） */
export const LLM_IMAGE_TYPES = PROVIDERS.gemini.imageTypes;
/** 受け付ける元のファイルの大きさ（Gemini の値） */
export const MAX_IMAGE_FILE_BYTES = PROVIDERS.gemini.maxImageFileBytes;
/** 縮めた後の長辺（px）。Gemini 3 は画像を決まったトークン数（既定で 1120）に収めるので、これより大きく送っても読み取りは良くならない */
export const MAX_IMAGE_SIDE = 2048;

/** 送る画像と、画面に出す説明 */
export type PreparedImage = LlmImage & { name: string; width?: number; height?: number; bytes: number };

/** 送れるファイルか。だめなら理由。形式と大きさの条件は、送り先の会社（既定は Gemini）の値 */
export function imageFileError(file: { type: string; size: number }, provider: ProviderId = 'gemini'): string | null {
  const info = providerInfo(provider);
  if (!info.imageTypes.includes(file.type)) return info.imageTypeText;
  if (file.size > info.maxImageFileBytes) return info.imageSizeText;
  return null;
}

/** 長辺が max を超えるときだけ、縦横の比を保って縮める */
export function fitSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export const blobToBase64 = (b: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/**
 * 送る形にする（ブラウザでだけ使える）。小さければそのまま、大きければ長辺を MAX_IMAGE_SIDE に縮める。
 * 縮めるとき、PNG（線画の図）は PNG のまま、写真は JPEG にする。透明な所は白で塗る
 */
export async function prepareImage(file: File, provider: ProviderId = 'gemini'): Promise<{ ok: true; image: PreparedImage } | { ok: false; error: string }> {
  const err = imageFileError(file, provider);
  if (err) return { ok: false, error: err };
  const name = file.name || '貼り付けた画像';
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // HEIC など、ブラウザで描けない形式はそのまま送る
    if (file.type === 'image/heic' || file.type === 'image/heif') return { ok: true, image: { name, mimeType: file.type, data: await blobToBase64(file), bytes: file.size } };
    return { ok: false, error: '画像を読めませんでした' };
  }
  try {
    const { width, height } = bitmap;
    const fit = fitSize(width, height);
    if (fit.width === width && file.size <= providerInfo(provider).keepAsIsImageBytes) return { ok: true, image: { name, mimeType: file.type, data: await blobToBase64(file), width, height, bytes: file.size } };
    const canvas = document.createElement('canvas');
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: '画像を縮められませんでした' };
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, fit.width, fit.height);
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    let type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const encode = (t: string) => new Promise<Blob | null>((res) => canvas.toBlob(res, t, 0.92));
    let blob = await encode(type);
    const limit = providerInfo(provider).maxSendImageBytes;
    // 送り先の 1 枚の上限を超えたら、JPEG にし直す（PNG の写真は大きくなりやすい）
    if (blob && limit && blob.size > limit && type !== 'image/jpeg') {
      type = 'image/jpeg';
      blob = await encode(type);
    }
    if (!blob) return { ok: false, error: '画像を縮められませんでした' };
    if (limit && blob.size > limit) return { ok: false, error: '縮めても画像が大きすぎて、送れませんでした' };
    return { ok: true, image: { name, mimeType: type, data: await blobToBase64(blob), width: fit.width, height: fit.height, bytes: blob.size } };
  } finally {
    bitmap.close();
  }
}

/** 「送る内容を見る」に出す画像の説明 */
export function imageSummary(i: PreparedImage): string {
  const kb = Math.max(1, Math.round(i.bytes / 1024));
  return `IMAGE: ${i.name}（${i.mimeType}${i.width ? `、${i.width}×${i.height} px` : ''}、${kb} KB）`;
}

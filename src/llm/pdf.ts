// 論文の PDF から、図の範囲を画像にする
//
// PDF はブラウザの中（pdf.js の Web Worker）で開き、どこにも送らない・残さない。送るのは、選んだ範囲を描いた画像だけ。
// pdf.js は大きいので、PDF を開いたときにだけ import() で読む（はじめの読み込みには入れない）

import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { blobToBase64, MAX_IMAGE_SIDE, type PreparedImage } from './image';
import { linesOf, toItems, type TextLine } from './pdfText';

/** 受け付ける PDF の大きさ */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
/** 画像にするときの倍率の上限（600 dpi 相当。PDF の 1 pt = 1/72 インチ） */
export const MAX_PDF_SCALE = 600 / 72;
/** 画像にした長辺がこれ（px）より小さくなる範囲は、小さすぎて読めないので受けない */
export const MIN_CROP_SIDE = 300;

/** ページの上の範囲。PDF の座標（倍率 1、向きを直した後の CSS px、左上が原点） */
export type PdfCrop = { x: number; y: number; width: number; height: number };

export const isPdfFile = (file: { type: string; name: string }): boolean => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/** 開ける PDF か。だめなら理由 */
export function pdfFileError(file: { type: string; size: number; name: string }): string | null {
  if (!isPdfFile(file)) return 'PDF ではありません';
  if (file.size > MAX_PDF_BYTES) return 'PDF が大きすぎます（100 MB まで）';
  return null;
}

/**
 * 範囲（cropW × cropH、倍率 1 のとき）を画像に描く倍率。長辺が MAX_IMAGE_SIDE（2048 px）になる倍率で、600 dpi 相当を超えない。
 * 超えない倍率で描いても長辺が 300 px に満たない範囲は、小さすぎる
 */
export function cropScale(cropW: number, cropH: number): { ok: true; scale: number } | { ok: false; error: string } {
  const long = Math.max(cropW, cropH);
  if (!(long > 0) || !Number.isFinite(long)) return { ok: false, error: '範囲が小さすぎます' };
  const scale = Math.min(MAX_IMAGE_SIDE / long, MAX_PDF_SCALE);
  if (long * scale < MIN_CROP_SIDE) return { ok: false, error: '範囲が小さすぎます。もう少し広く選んでください' };
  return { ok: true, scale };
}

/** 添付欄・「送る内容を見る」・下書きに出す名前。例: 「paper.pdf p.3 (crop)」 */
export function pdfImageName(fileName: string, pageNumber: number, cropped: boolean): string {
  return `${fileName} p.${pageNumber}${cropped ? ' (crop)' : ''}`;
}

/** 下書きに残した画像の名前（pdfImageName の形）から、PDF のファイル名とページ。PDF からでなければ null */
export function parsePdfImageName(name: string): { file: string; page: number } | null {
  const m = /^(.+\.pdf) p\.(\d+)(?: \(crop\))?$/i.exec(name);
  return m ? { file: m[1], page: Number(m[2]) } : null;
}

/** 画像として貼られた図の解像度がこれ（dpi）未満なら、読み違いが起きやすいので警告する（評価の 72・150・200 dpi からの目安） */
export const LOW_RES_DPI = 150;
/** 解像度が低いか。測った値の揺れ（150 dpi の画像が 149.9 と出る）で境目の件を警告しないよう、整数に丸めて比べる */
export const isLowRes = (dpi: number | null | undefined): dpi is number => typeof dpi === 'number' && Math.round(dpi) < LOW_RES_DPI;
/** 画像が範囲に重なっているとみなす割合（重なる面積が、画像か範囲の小さいほうの面積のこれ以上） */
const MIN_OVERLAP = 0.2;
/** これ（pt）より小さく描かれた画像は、図ではない（飾り・下地など）ので数えない */
const MIN_IMAGE_PT = 8;

/** 2 次元の変換 [a, b, c, d, e, f]（x' = a·x + c·y + e、y' = b·x + d·y + f。PDF の cm と同じ） */
export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** outer の座標の中で inner を使う変換（canvas の transform と同じ。inner を先に当てる） */
function compose(o: Matrix, i: Matrix): Matrix {
  return [
    o[0] * i[0] + o[2] * i[1],
    o[1] * i[0] + o[3] * i[1],
    o[0] * i[2] + o[2] * i[3],
    o[1] * i[2] + o[3] * i[3],
    o[0] * i[4] + o[2] * i[5] + o[4],
    o[1] * i[4] + o[3] * i[5] + o[5],
  ];
}

const isMatrix = (m: unknown): m is number[] => Array.isArray(m) && m.length >= 6 && m.slice(0, 6).every((v) => typeof v === 'number' && Number.isFinite(v));
const six = (m: number[]): Matrix => m.slice(0, 6) as Matrix;

/** ページの上に貼られた画像 1 枚 */
export interface PlacedImage {
  /** ユーザー空間（pt）での外接の四角 [x0, y0, x1, y1] */
  box: [number, number, number, number];
  /** 画像のピクセル数 */
  pxWidth: number;
  pxHeight: number;
  /** 紙の上の大きさ（pt） */
  ptWidth: number;
  ptHeight: number;
  /** 実効の解像度（dpi）。縦横のうち低いほう */
  dpi: number;
}

/** pdf.js の命令の番号のうち、ここで使うもの（pdfjs-dist の OPS）。import() で読む部品なので、呼ぶ側から渡す */
export type PdfOps = Record<
  'save' | 'restore' | 'transform' | 'paintFormXObjectBegin' | 'paintFormXObjectEnd' | 'beginGroup' | 'endGroup' | 'paintImageXObject' | 'paintInlineImageXObject' | 'paintInlineImageXObjectGroup',
  number
>;

/**
 * ページの描く命令の並び（page.getOperatorList() の fnArray・argsArray）から、画像として貼られた図の位置と解像度を出す。
 * 画像は単位正方形を CTM（今の変換）で写して描かれるので、save/restore/transform と、フォーム（paintFormXObjectBegin/End）の行列で CTM を追い、
 * 列ベクトルの長さを紙の上の大きさ（pt）にする。マスク（paintImageMaskXObject）は数えない。
 * paintImageXObjectRepeat（同じ画像を 3 回以上並べたもの）は、命令にピクセル数が無いので数えない（低く見積もらないため）
 */
export function placedImages(ops: PdfOps, fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): PlacedImage[] {
  const out: PlacedImage[] = [];
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  const place = (m: Matrix, pxW: unknown, pxH: unknown) => {
    if (typeof pxW !== 'number' || typeof pxH !== 'number' || !(pxW > 0) || !(pxH > 0)) return;
    const ptW = Math.hypot(m[0], m[1]);
    const ptH = Math.hypot(m[2], m[3]);
    if (!(ptW >= MIN_IMAGE_PT) || !(ptH >= MIN_IMAGE_PT)) return;
    const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
    const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
    out.push({
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      pxWidth: pxW,
      pxHeight: pxH,
      ptWidth: ptW,
      ptHeight: ptH,
      dpi: Math.min(pxW / (ptW / 72), pxH / (ptH / 72)),
    });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null | undefined;
    switch (fn) {
      case ops.save:
      case ops.beginGroup:
        stack.push(ctm);
        break;
      case ops.restore:
      case ops.endGroup:
      case ops.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case ops.transform:
        if (isMatrix(args)) ctm = compose(ctm, six(args));
        break;
      case ops.paintFormXObjectBegin:
        stack.push(ctm);
        if (isMatrix(args?.[0])) ctm = compose(ctm, six(args[0] as number[]));
        break;
      case ops.paintImageXObject:
        place(ctm, args?.[1], args?.[2]);
        break;
      case ops.paintInlineImageXObject: {
        const img = args?.[0] as { width?: number; height?: number } | undefined;
        place(ctm, img?.width, img?.height);
        break;
      }
      case ops.paintInlineImageXObjectGroup: {
        // 小さい画像を 1 枚に束ねたもの。map の 1 つずつが、自分の変換と大きさを持つ
        const map = args?.[1];
        if (Array.isArray(map)) {
          for (const e of map as { transform?: unknown; w?: number; h?: number }[]) {
            if (isMatrix(e?.transform)) place(compose(ctm, six(e.transform)), e.w, e.h);
          }
        }
        break;
      }
    }
  }
  return out;
}

/**
 * 範囲（PdfCrop と同じ、倍率 1・向きを直した後・左上原点。なければページ全体）と重なる画像のうち、最も低い dpi。画像が無ければ null（線の図）。
 * viewport は page.getViewport({ scale: 1 }).transform（ユーザー空間 → 画面の座標）
 */
export function lowestDpi(images: PlacedImage[], viewport: Matrix, page: { width: number; height: number }, crop?: PdfCrop): number | null {
  const c = crop ?? { x: 0, y: 0, width: page.width, height: page.height };
  const cropArea = c.width * c.height;
  let min: number | null = null;
  for (const im of images) {
    const [x0, y0, x1, y1] = im.box;
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [viewport[0] * x + viewport[2] * y + viewport[4], viewport[1] * x + viewport[3] * y + viewport[5]]);
    const bx0 = Math.min(...pts.map((p) => p[0]));
    const bx1 = Math.max(...pts.map((p) => p[0]));
    const by0 = Math.min(...pts.map((p) => p[1]));
    const by1 = Math.max(...pts.map((p) => p[1]));
    const ow = Math.min(bx1, c.x + c.width) - Math.max(bx0, c.x);
    const oh = Math.min(by1, c.y + c.height) - Math.max(by0, c.y);
    if (!(ow > 0) || !(oh > 0)) continue;
    const small = Math.min((bx1 - bx0) * (by1 - by0), cropArea);
    if (!(small > 0) || ow * oh < MIN_OVERLAP * small) continue;
    if (min === null || im.dpi < min) min = im.dpi;
  }
  return min;
}

export interface OpenedPdf {
  numPages: number;
  /** ページを canvas に描く（canvas の大きさは scale 倍に合わせる）。同じ canvas の前の描画は取り消す */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, scale: number): Promise<void>;
  /** ページの大きさ（倍率 1） */
  pageSize(pageNumber: number): Promise<{ width: number; height: number }>;
  /** 範囲（なければページ全体）を PNG の画像にする */
  cropToImage(pageNumber: number, crop?: PdfCrop): Promise<{ ok: true; image: PreparedImage } | { ok: false; error: string }>;
  /**
   * 範囲（なければページ全体）に重なる、画像として貼られた図の最も低い解像度（dpi）。画像が無ければ null（線で描かれた図）。
   * 描く命令の並びから計算する（外へは送らない）。測れなければ null
   */
  imageDpi(pageNumber: number, crop?: PdfCrop): Promise<number | null>;
  /** ページの文字の行（外へは送らない）。文字が無い（スキャン）・読めなければ空 */
  textLines(pageNumber: number): Promise<TextLine[]>;
  /** PDF を捨てる（Worker も止める） */
  destroy(): void;
}

const BASE = `${import.meta.env.BASE_URL}pdfjs/`;

/** PDF を開く（ブラウザの中だけ）。PDF の中身はメモリにだけ置く */
export async function openPdf(file: File): Promise<{ ok: true; pdf: OpenedPdf } | { ok: false; error: string }> {
  const err = pdfFileError(file);
  if (err) return { ok: false, error: err };
  let lib: typeof import('pdfjs-dist');
  try {
    lib = await import('pdfjs-dist');
  } catch {
    return { ok: false, error: 'PDF を開く部品を読み込めませんでした。ネットワークを確かめて、もう一度お試しください' };
  }
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  let doc: PDFDocumentProxy;
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    // フォームや PDF の中の JavaScript は使わない（isEvalSupported は 6.x で無くなった。PDF のフォントから関数を作る道ごと消えている）
    enableXfa: false,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    wasmUrl: `${BASE}wasm/`,
  });
  // パスワードを聞かれたら、入れさせずに断る
  task.onPassword = () => void task.destroy();
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    if (e instanceof lib.PasswordException || (e as { name?: string })?.name === 'PasswordException') {
      return { ok: false, error: 'パスワードの付いた PDF は開けません。パスワードを外してから入れてください' };
    }
    return { ok: false, error: 'PDF を読めませんでした' };
  }
  const renders = new WeakMap<HTMLCanvasElement, RenderTask>();
  /** 同じ canvas に続けて頼まれたとき、古い頼みは描かずにやめる */
  const turns = new WeakMap<HTMLCanvasElement, number>();
  const isCancel = (e: unknown) => e instanceof lib.RenderingCancelledException || (e as { name?: string })?.name === 'RenderingCancelledException';
  let destroyed = false;
  /** ページごとの、貼られた画像の一覧（命令の並びは一度読めばよい） */
  const placed = new Map<number, Promise<PlacedImage[]>>();
  const texts = new Map<number, Promise<TextLine[]>>();
  return {
    ok: true,
    pdf: {
      numPages: doc.numPages,
      async renderPage(pageNumber, canvas, scale) {
        const turn = (turns.get(canvas) ?? 0) + 1;
        turns.set(canvas, turn);
        renders.get(canvas)?.cancel();
        const page = await doc.getPage(pageNumber);
        if (destroyed || turns.get(canvas) !== turn) return;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const rt = page.render({ canvas, viewport, background: '#ffffff' });
        renders.set(canvas, rt);
        try {
          await rt.promise;
        } catch (e) {
          if (!isCancel(e)) throw e;
        }
      },
      async pageSize(pageNumber) {
        const v = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
        return { width: v.width, height: v.height };
      },
      async cropToImage(pageNumber, crop) {
        const page = await doc.getPage(pageNumber);
        const full = page.getViewport({ scale: 1 });
        // ページの外にはみ出した所は切る
        const x0 = Math.max(0, crop?.x ?? 0);
        const y0 = Math.max(0, crop?.y ?? 0);
        const x1 = Math.min(full.width, (crop?.x ?? 0) + (crop?.width ?? full.width));
        const y1 = Math.min(full.height, (crop?.y ?? 0) + (crop?.height ?? full.height));
        const w = x1 - x0;
        const h = y1 - y0;
        const k = cropScale(w, h);
        if (!k.ok) return k;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * k.scale));
        canvas.height = Math.max(1, Math.round(h * k.scale));
        try {
          await page.render({
            canvas,
            viewport: page.getViewport({ scale: k.scale }),
            transform: [1, 0, 0, 1, -x0 * k.scale, -y0 * k.scale],
            background: '#ffffff',
          }).promise;
          const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
          if (!blob) return { ok: false, error: '範囲を画像にできませんでした' };
          return {
            ok: true,
            image: {
              name: pdfImageName(file.name, pageNumber, !!crop),
              mimeType: 'image/png',
              data: await blobToBase64(blob),
              width: canvas.width,
              height: canvas.height,
              bytes: blob.size,
            },
          };
        } catch {
          return { ok: false, error: '範囲を画像にできませんでした' };
        }
      },
      async imageDpi(pageNumber, crop) {
        try {
          const page = await doc.getPage(pageNumber);
          let images = placed.get(pageNumber);
          if (!images) {
            images = page.getOperatorList().then((l) => placedImages(lib.OPS as unknown as PdfOps, l.fnArray, l.argsArray));
            placed.set(pageNumber, images);
          }
          const v = page.getViewport({ scale: 1 });
          return lowestDpi(await images, v.transform as Matrix, { width: v.width, height: v.height }, crop);
        } catch {
          return null;
        }
      },
      async textLines(pageNumber) {
        let got = texts.get(pageNumber);
        if (!got) {
          got = (async () => {
            try {
              const page = await doc.getPage(pageNumber);
              return linesOf(toItems((await page.getTextContent()).items), pageNumber, page.getViewport({ scale: 1 }).width);
            } catch {
              return [];
            }
          })();
          texts.set(pageNumber, got);
        }
        return got;
      },
      destroy() {
        destroyed = true;
        void task.destroy();
      },
    },
  };
}

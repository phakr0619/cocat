// PowerPoint のファイル（pptx）の中から、Cocat のデータが入った図（PNG）を探す（docs/reopen-figure.md）。
// pptx は zip。画像は ppt/media/ に、どのスライドがどの画像を使うかは ppt/slides/_rels/slideN.xml.rels にある。
// PowerPoint は同じ中身の画像を 1 つにまとめるので、1 つの図を複数のスライドが使うことがある。中の文字やほかのファイルは読まない
import type { Doc } from '../chem/model';
import { isPngBytes, readPngData } from './figureData';
import { unzip } from './zip';

export interface SlideFigure {
  /** pptx の中の画像のパス（ppt/media/image2.png） */
  media: string;
  /** この図を使っているスライドの番号（小さい順。どこからも使っていなければ空） */
  slides: number[];
  /** 図の画像（一覧の小さな絵に使う） */
  png: Uint8Array;
  doc: Doc;
}

export const isZipBytes = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** スライドの番号の小さい順に、Cocat のデータが入った図を返す */
export async function findSlideFigures(bytes: Uint8Array): Promise<SlideFigure[]> {
  const files = await unzip(bytes, (n) => /^ppt\/media\/[^/]+\.png$/i.test(n) || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(n));
  const uses = new Map<string, number[]>();
  for (const [name, data] of files) {
    const m = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/.exec(name);
    if (!m) continue;
    for (const t of new TextDecoder().decode(data).matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
      const media = `ppt/media/${t[1]}`;
      uses.set(media, [...(uses.get(media) ?? []), Number(m[1])]);
    }
  }
  const out: SlideFigure[] = [];
  for (const [name, data] of files) {
    if (!name.startsWith('ppt/media/') || !isPngBytes(data)) continue;
    let doc: Doc | null = null;
    try {
      doc = await readPngData(data);
    } catch {
      continue; // 印はあるが読めない（壊れた・新しすぎる版）。開ける図だけを出す
    }
    if (doc) out.push({ media: name, slides: [...new Set(uses.get(name) ?? [])].sort((a, b) => a - b), png: data, doc });
  }
  const first = (f: SlideFigure) => f.slides[0] ?? Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => first(a) - first(b) || a.media.localeCompare(b.media));
}

// 図の画像（PNG）の中に、あとで Cocat で開き直すためのデータを入れる・読む（docs/reopen-figure.md）
//
// PNG の iTXt の塊（キーワード cocat、zlib で圧縮）に、.acedoc と同じ JSON を入れる。画像の見た目は変わらない。
// PowerPoint にファイルから挿入した・Cocat のコピー（HTML の中の画像）で貼った PNG は、pptx の中でもそのまま残る
import { edit, type Doc } from '../chem/model';
import { parseDocFile, serializeDoc } from './docfile';
import { crc32 } from './zip';

/** PNG の iTXt のキーワード */
export const PNG_KEYWORD = 'cocat';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const enc = new TextEncoder();
const dec = new TextDecoder();

export const isPngBytes = (b: Uint8Array) => b.length > 33 && SIG.every((x, i) => b[i] === x);

/** 図の中の物（原子・矢印・文字・＋）を置いたスキーム・検討表の id。原子の ref は「スキーム id:化合物 id」（表なら「表 id」か「表 id:…」） */
function ownerOf(ref: string | undefined): string | undefined {
  return ref ? ref.split(':')[0] : undefined;
}

/** 文書の中で、スキーム・表 owner が置いた物の id */
function placedBy(doc: Doc): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (owner: string | undefined, id: string) => {
    if (!owner) return;
    if (!out.has(owner)) out.set(owner, new Set());
    out.get(owner)!.add(id);
  };
  for (const a of Object.values(doc.atoms)) add(ownerOf(a.ref), a.id);
  for (const r of Object.values(doc.arrows)) add(r.ref, r.id);
  for (const t of Object.values(doc.texts)) add(t.ref, t.id);
  for (const p of Object.values(doc.pluses)) add(p.ref, p.id);
  return out;
}

/**
 * part（doc から取り出した部分。extract は文書のスキーム・化合物・表・書式をすべて持ったまま）に入れるデータを、
 * 図に描いてある物に関わる分だけに絞る（docs/reopen-figure.md の「入れるデータ」）。
 * - スキーム・検討表は、その図が描いた物を**すべて**含むときだけ残す。一部だけなら、データを外してただの絵にする（描いていない化合物の構造を入れないため）
 * - 化合物・書式・略号の辞書は、残したものが使う分だけ
 * - 化合物のメモ・ライブラリとのつながり・実験の量・AI に送った文章は入れない
 */
export function figureData(doc: Doc, part: Doc): Doc {
  const inDoc = placedBy(doc);
  const inPart = placedBy(part);
  const keep = new Set<string>();
  for (const [owner, ids] of inPart) {
    const all = inDoc.get(owner);
    if (all && all.size === ids.size && [...all].every((id) => ids.has(id))) keep.add(owner);
  }
  return edit(part, (d) => {
    const drop = (ref: string | undefined) => !!ref && !keep.has(ownerOf(ref)!);
    for (const a of Object.values(d.atoms)) {
      if (drop(a.ref)) delete a.ref;
      delete a.lib;
    }
    for (const r of Object.values(d.arrows)) if (drop(r.ref)) delete r.ref;
    for (const t of Object.values(d.texts)) if (drop(t.ref)) delete t.ref;
    for (const p of Object.values(d.pluses)) if (drop(p.ref)) delete p.ref;

    const schemes = Object.fromEntries(Object.entries(d.schemes ?? {}).filter(([id]) => keep.has(id)));
    const tables = Object.fromEntries(Object.entries(d.tables ?? {}).filter(([id]) => keep.has(id)));
    for (const t of Object.values(tables)) if (t.schemeId && !schemes[t.schemeId]) delete t.schemeId;

    const usedCompounds = new Set<string>();
    for (const s of Object.values(schemes)) {
      for (const st of s.steps) {
        for (const id of [...st.from, ...st.to]) usedCompounds.add(id);
        delete st.scale;
        delete st.substrateEquiv;
      }
      if (s.draft) s.draft.text = '';
      for (const c of Object.values(s.pinned?.compounds ?? {})) delete c.note;
    }
    for (const a of Object.values(d.atoms)) {
      const [owner, compound] = (a.ref ?? '').split(':');
      if (owner && compound && schemes[owner]) usedCompounds.add(compound);
    }
    const compounds = Object.fromEntries(Object.entries(d.compounds ?? {}).filter(([id]) => usedCompounds.has(id)));
    for (const c of Object.values(compounds)) delete c.note;

    const usedStyles = new Set(Object.values(schemes).map((s) => s.styleId));
    const styles = Object.fromEntries(Object.entries(d.styles ?? {}).filter(([id]) => usedStyles.has(id)));

    const usedAbbr = new Set<string>([...Object.values(d.atoms).map((a) => a.abbr ?? ''), ...Object.values(d.groups).map((g) => g.abbr)]);
    const abbrDefs = Object.fromEntries(Object.entries(d.abbrDefs ?? {}).filter(([name]) => usedAbbr.has(name)));

    d.schemes = schemes;
    d.tables = tables;
    d.compounds = compounds;
    if (d.styles) d.styles = styles;
    if (d.abbrDefs) d.abbrDefs = abbrDefs;
  });
}

async function zlib(data: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG の塊を順に返す */
function* chunks(png: Uint8Array): Generator<{ type: string; data: Uint8Array; start: number; end: number }> {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 12 <= png.length) {
    const len = v.getUint32(p);
    const type = dec.decode(png.subarray(p + 4, p + 8));
    yield { type, data: png.subarray(p + 8, p + 8 + len), start: p, end: p + 12 + len };
    if (type === 'IEND') return;
    p += 12 + len;
  }
}

/** PNG に図のデータを入れる（前に入っていたものは取り除く）。IHDR のすぐ後に置く */
export async function addPngData(png: Uint8Array, data: Doc): Promise<Uint8Array> {
  if (!isPngBytes(png)) throw new Error('PNG ではありません');
  // iTXt: キーワード \0 圧縮の印(1) 圧縮の方式(0) 言語 \0 訳したキーワード \0 本文
  const head = enc.encode(`${PNG_KEYWORD}\0`);
  const body = await zlib(enc.encode(serializeDoc(data)), 'compress');
  const itxt = new Uint8Array(head.length + 4 + body.length);
  itxt.set(head, 0);
  itxt.set([1, 0, 0, 0], head.length);
  itxt.set(body, head.length + 4);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  for (const c of chunks(png)) {
    if (c.type === 'iTXt' && keywordOf(c.data) === PNG_KEYWORD) continue;
    parts.push(png.subarray(c.start, c.end));
    if (c.type === 'IHDR') parts.push(chunk('iTXt', itxt));
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of parts) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

function keywordOf(data: Uint8Array): string {
  const z = data.indexOf(0);
  return z < 0 ? '' : dec.decode(data.subarray(0, z));
}

/** PNG から図のデータを読む。入っていなければ null。入っているが読めなければ投げる */
export async function readPngData(png: Uint8Array): Promise<Doc | null> {
  if (!isPngBytes(png)) return null;
  for (const c of chunks(png)) {
    if (c.type !== 'iTXt' || keywordOf(c.data) !== PNG_KEYWORD) continue;
    const d = c.data;
    let q = d.indexOf(0) + 1;
    const compressed = d[q] === 1;
    q += 2;
    q = d.indexOf(0, q) + 1; // 言語
    q = d.indexOf(0, q) + 1; // 訳したキーワード
    const body = d.subarray(q);
    const text = dec.decode(compressed ? await zlib(body, 'decompress') : body);
    return parseDocFile(text);
  }
  return null;
}

/** 図の PNG に、その図のデータ（figureData で絞ったもの）を入れたもの */
export async function pngWithData(png: Blob, source: Doc, part: Doc): Promise<Blob> {
  const bytes = await addPngData(new Uint8Array(await png.arrayBuffer()), figureData(source, part));
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}

/** クリップボードの HTML（データ入りの PNG を中に含む）。PowerPoint・Word はこの画像をそのまま使う */
export async function pngHtml(png: Blob): Promise<Blob> {
  const b = new Uint8Array(await png.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return new Blob([`<img src="data:image/png;base64,${btoa(s)}" alt="Cocat">`], { type: 'text/html' });
}

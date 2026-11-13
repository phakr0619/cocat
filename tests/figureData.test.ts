// 図の PNG に Cocat のデータを入れる・読む、入れるデータの絞り方、pptx の中の図を探す（docs/reopen-figure.md）
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { edit, type Doc } from '../src/chem/model';
import { extract } from '../src/chem/transform';
import { addPngData, figureData, isPngBytes, readPngData } from '../src/io/figureData';
import { findSlideFigures } from '../src/io/pptx';
import { crc32, makeZip } from '../src/io/zip';
import { SAMPLES } from '../src/samples';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const build = (id: string) => SAMPLES.find((s) => s.id === id)!.build();
const PNG = new Uint8Array(readFileSync('tests/llm-eval/images/amide-hatu-acs-200.png'));
const allIds = (d: Doc) => [...Object.keys(d.atoms), ...Object.keys(d.bonds), ...Object.keys(d.arrows), ...Object.keys(d.texts), ...Object.keys(d.pluses)];

/** PNG の塊の種類と中身（画素の IDAT が変わらないかを見る） */
function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  for (let p = 8; p + 12 <= png.length; ) {
    const len = v.getUint32(p);
    out.push({ type: new TextDecoder().decode(png.subarray(p + 4, p + 8)), data: png.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

describe('PNG の中のデータ', () => {
  it('入れて読み戻せる。画素（IDAT）はそのまま、IHDR のすぐ後に 1 つだけ入る', async () => {
    const doc = build('multistep');
    const out = await addPngData(PNG, doc);
    expect(isPngBytes(out)).toBe(true);
    const back = await readPngData(out);
    expect(back).toEqual(JSON.parse(JSON.stringify(doc)));
    const before = chunks(PNG).filter((c) => c.type === 'IDAT');
    const after = chunks(out);
    expect(after[1].type).toBe('iTXt');
    expect(after.filter((c) => c.type === 'IDAT')).toEqual(before);
    // 入れ直すと、前のデータは取り除いて 1 つにする
    const again = await addPngData(out, build('aspirin'));
    expect(chunks(again).filter((c) => c.type === 'iTXt')).toHaveLength(1);
    expect(Object.keys((await readPngData(again))!.atoms)).toHaveLength(Object.keys(build('aspirin').atoms).length);
  });

  it('入っていない PNG・PNG でないものは null', async () => {
    expect(await readPngData(PNG)).toBeNull();
    expect(await readPngData(new TextEncoder().encode('not a png at all, just some text here'))).toBeNull();
  });
});

describe('入れるデータを、その図に関わる分だけに絞る', () => {
  it('スキーム全体なら、スキーム・使う化合物・書式を残し、メモ・ライブラリ・実験の量・AI に送った文章は入れない', () => {
    const doc = edit(build('coupling'), (d) => {
      const s = Object.values(d.schemes!)[0];
      s.steps[0].scale = { value: 100, unit: 'mg' };
      s.steps[0].substrateEquiv = { x: 1.2 };
      s.draft = { text: '秘密の指示', issues: [], questions: [], model: 'm' };
      for (const c of Object.values(d.compounds!)) c.note = '未発表のメモ';
      d.compounds!.cExtra = { id: 'cExtra', structure: { atoms: {}, bonds: {}, groups: {} }, nickname: '関係ない化合物' };
      Object.values(d.atoms)[0].lib = 'lib1';
      d.abbrDefs = { Foo: '*C', Boc: '*C(=O)OC(C)(C)C' };
    });
    const part = figureData(doc, extract(doc, allIds(doc)));
    const s = Object.values(part.schemes!)[0];
    expect(s).toBeDefined();
    expect(s.steps[0].scale).toBeUndefined();
    expect(s.steps[0].substrateEquiv).toBeUndefined();
    expect(s.draft?.text).toBe('');
    expect(Object.keys(part.compounds!).sort()).toEqual(Object.keys(doc.compounds!).filter((id) => id !== 'cExtra').sort());
    expect(Object.values(part.compounds!).every((c) => c.note === undefined)).toBe(true);
    expect(Object.values(part.atoms).every((a) => a.lib === undefined)).toBe(true);
    // 図の原子のスキームへのつながりは残る（開き直すとスキームとして直せる）
    expect(Object.values(part.atoms).some((a) => a.ref?.startsWith(`${s.id}:`))).toBe(true);
    // 略号の辞書は、図で使っているものだけ
    expect(Object.keys(part.abbrDefs ?? {})).not.toContain('Foo');
    // 元の文書は変わらない
    expect(Object.values(doc.compounds!)[0].note).toBe('未発表のメモ');
  });

  it('スキームの一部だけなら、スキームと化合物のデータは入れず、ただの絵にする', () => {
    const doc = build('coupling');
    const s = Object.values(doc.schemes!)[0];
    // 1 つ目の化合物の原子だけを選ぶ
    const firstCompound = Object.values(doc.atoms).find((a) => a.ref?.startsWith(`${s.id}:`))!.ref!;
    const sel = Object.values(doc.atoms).filter((a) => a.ref === firstCompound).map((a) => a.id);
    const part = figureData(doc, extract(doc, sel));
    expect(part.schemes).toEqual({});
    expect(part.compounds).toEqual({});
    expect(Object.values(part.atoms).length).toBeGreaterThan(0);
    expect(Object.values(part.atoms).every((a) => a.ref === undefined)).toBe(true);
  });
});

/** deflate で圧縮した zip（PowerPoint の pptx と同じ形）。makeZip は格納だけなので、テストで作る */
function deflateZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length + comp.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(comp, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const x of [...locals, ...centrals, end]) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

const rels = (...media: string[]) =>
  new TextEncoder().encode(`<?xml version="1.0"?><Relationships>${media.map((m, i) => `<Relationship Id="rId${i + 2}" Target="../media/${m}"/>`).join('')}</Relationships>`);

describe('pptx の中の図を探す', () => {
  it('Cocat のデータが入った PNG だけを、使っているスライドの番号つきで、スライドの順に返す（同じ画像を 2 枚で使う場合も）', async () => {
    const multi = await addPngData(PNG, build('multistep'));
    const aspirin = await addPngData(PNG, build('aspirin'));
    const pptx = deflateZip([
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels('image3.png') },
      { name: 'ppt/slides/_rels/slide2.xml.rels', data: rels('image1.png') },
      { name: 'ppt/slides/_rels/slide3.xml.rels', data: rels('image2.png', 'image1.png') },
      { name: 'ppt/slides/_rels/slide4.xml.rels', data: rels('image2.png') },
      { name: 'ppt/media/image1.png', data: multi },
      { name: 'ppt/media/image2.png', data: PNG }, // データの無い画像（図として保存したもの・ほかの画像）
      { name: 'ppt/media/image3.png', data: aspirin },
      { name: 'ppt/slides/slide1.xml', data: new TextEncoder().encode('<p:sld/>') },
    ]);
    const figs = await findSlideFigures(pptx);
    expect(figs.map((f) => [f.media, f.slides])).toEqual([
      ['ppt/media/image3.png', [1]],
      ['ppt/media/image1.png', [2, 3]],
    ]);
    expect(Object.keys(figs[1].doc.schemes ?? {})).toHaveLength(Object.keys(build('multistep').schemes ?? {}).length);
  });

  it('格納形式の zip も読める。図が無ければ空', async () => {
    const pptx = makeZip([
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels('image1.png') },
      { name: 'ppt/media/image1.png', data: PNG },
    ]);
    expect(await findSlideFigures(pptx)).toEqual([]);
  });
});

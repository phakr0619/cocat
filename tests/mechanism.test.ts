// 反応機構の記号（曲がった矢印・ローンペア・ラジカル・部分電荷）、矢印の種類（共鳴・点線・進まない）、同位体
import { beforeAll, describe, expect, it } from 'vitest';
import { parseLabel } from '../src/chem/label';
import { edit, emptyDoc, type Doc } from '../src/chem/model';
import { addArrow } from '../src/chem/schemeOps';
import { flipSelection } from '../src/chem/transform';
import { atomMark, defaultControl } from '../src/editor/tools3';
import { arrowDist } from '../src/editor/hit';
import { cdxmlToCdx, cdxToCdxml } from '../src/io/cdx';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { importText } from '../src/io/convert';
import { parseMolfile, writeMolfile } from '../src/io/molfile';
import { docToSmiles } from '../src/io/smiles';
import { layout } from '../src/render/layout';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const viaCdxml = (d: Doc) => readCdxml(writeCdxml(d));
const viaCdx = (d: Doc) => readCdxml(cdxToCdxml(cdxmlToCdx(writeCdxml(d))));
const only = <T,>(r: Record<string, T>) => Object.values(r)[0];

describe('曲がった矢印（電子の動き）', () => {
  const curved = (half = false) => {
    const tail = { x: 0, y: 0 };
    const head = { x: 40, y: 0 };
    const c = defaultControl(tail, head);
    return addArrow(emptyDoc(), tail, head, 'curved', { cx: c.x, cy: c.y, ...(half ? { half: true } : {}) });
  };

  it('進む向きの左（左から右なら上）にふくらみ、曲線と矢頭を描く', () => {
    const r = only(curved().arrows);
    expect(r.cy).toBeLessThan(0);
    const prims = layout(curved()).prims;
    expect(prims.some((p) => p.k === 'path' && /Q/.test(p.d))).toBe(true);
    expect(prims.filter((p) => p.k === 'poly')).toHaveLength(1);
    // 当たり判定は曲線に沿う（弦の中ほどは遠い）
    const mid = { x: 0.25 * r.x1 + 0.5 * r.cx! + 0.25 * r.x2, y: 0.25 * r.y1 + 0.5 * r.cy! + 0.25 * r.y2 };
    expect(arrowDist(r, mid)).toBeLessThan(0.5);
    expect(arrowDist(r, { x: 20, y: 0 })).toBeGreaterThan(5);
  });

  it('左右反転すると、ふくらむ側も反対になる', () => {
    const d = curved();
    const id = Object.keys(d.arrows)[0];
    const f = flipSelection(d, new Set([id]), 'v');
    expect(Math.sign(only(f.arrows).cy! - only(f.arrows).y1)).toBe(-Math.sign(only(d.arrows).cy! - only(d.arrows).y1));
  });

  it('CDXML と CDX に円弧（ChemDraw の曲がった矢印の形）で書き、同じ形に読み戻せる。片側の矢頭も残る', () => {
    for (const half of [false, true]) {
      const d = curved(half);
      const xml = writeCdxml(d);
      expect(xml).toMatch(/<arrow [^>]*AngularSize="/);
      for (const back of [viaCdxml(d), viaCdx(d)]) {
        const a = only(d.arrows);
        const b = only(back.arrows);
        expect(b.kind).toBe('curved');
        expect(!!b.half).toBe(half);
        // 結合長でそろえ直すので、尾と頭の向きと、ふくらみの比で比べる
        const k = (b.x2 - b.x1) / (a.x2 - a.x1);
        expect((b.cy! - b.y1) / k).toBeCloseTo(a.cy! - a.y1, 0);
        expect((b.cx! - b.x1) / k).toBeCloseTo(a.cx! - a.x1, 0);
      }
    }
  });
});

describe('矢印の種類', () => {
  it('共鳴・点線・進まないを描き、CDXML と CDX に書いて読み戻せる', () => {
    let d = emptyDoc();
    d = addArrow(d, { x: 0, y: 0 }, { x: 40, y: 0 }, 'resonance');
    d = addArrow(d, { x: 0, y: 20 }, { x: 40, y: 20 }, 'normal', { dashed: true });
    d = addArrow(d, { x: 0, y: 40 }, { x: 40, y: 40 }, 'normal', { noGo: true });
    // 共鳴は両端に矢頭、点線は短い線に分ける、進まないは ✕ の 2 本
    const owner = (i: number) => Object.keys(d.arrows)[i];
    const prims = layout(d).prims;
    expect(prims.filter((p) => p.owner === owner(0) && p.k === 'poly')).toHaveLength(2);
    expect(prims.filter((p) => p.owner === owner(1) && p.k === 'line').length).toBeGreaterThan(5);
    expect(prims.filter((p) => p.owner === owner(2) && p.k === 'line')).toHaveLength(3);
    for (const back of [viaCdxml(d), viaCdx(d)]) {
      const rs = Object.values(back.arrows).sort((a, b) => a.y1 - b.y1);
      expect(rs.map((r) => [r.kind, !!r.dashed, !!r.noGo])).toEqual([
        ['resonance', false, false],
        ['normal', true, false],
        ['normal', false, true],
      ]);
    }
  });
});

describe('原子の印と同位体', () => {
  const methane = () => importText(emptyDoc(), 'C').doc;
  const atom = (d: Doc) => Object.values(d.atoms)[0];

  it('ラジカルは水素が 1 つ減り、SMILES と Molfile に入る', () => {
    const d = atomMark(methane(), atom(methane()).id, 'radical');
    expect(atom(d).radical).toBe(true);
    expect(docToSmiles(d).smiles).toBe('[CH3]');
    const back = parseMolfile(writeMolfile(d).molblock);
    expect(back.atoms[0].radical).toBe(true);
    // もう一度押すと外れる
    expect(atom(atomMark(d, atom(d).id, 'radical')).radical).toBeUndefined();
  });

  it('ローンペアは押すたびに 1・2・3・なし。点を 2 つずつ描き、CDXML で読み戻せる', () => {
    let d = importText(emptyDoc(), 'CO').doc;
    const o = Object.values(d.atoms).find((a) => a.element === 'O')!;
    d = atomMark(d, o.id, 'lone-pair');
    d = atomMark(d, o.id, 'lone-pair');
    expect(d.atoms[o.id].lonePairs).toBe(2);
    const dots = layout(d).prims.filter((p) => p.owner === o.id && p.k === 'poly');
    expect(dots).toHaveLength(4);
    // 点は O のラベルの外にある
    for (const p of dots) {
      if (p.k !== 'poly') continue;
      const c = { x: p.pts.reduce((s, q) => s + q.x, 0) / 8, y: p.pts.reduce((s, q) => s + q.y, 0) / 8 };
      expect(Math.hypot(c.x - o.x, c.y - o.y)).toBeGreaterThan(4);
    }
    for (const back of [viaCdxml(d), viaCdx(d)]) expect(Object.values(back.atoms).find((a) => a.element === 'O')!.lonePairs).toBe(2);
    d = atomMark(atomMark(d, o.id, 'lone-pair'), o.id, 'lone-pair');
    expect(d.atoms[o.id].lonePairs).toBeUndefined();
  });

  it('部分電荷は、原子の右上に δ+ / δ− の文字を置く', () => {
    const d = atomMark(methane(), atom(methane()).id, 'delta-minus');
    expect(Object.values(d.texts).map((t) => t.text)).toEqual(['δ−']);
  });

  it('同位体: 「13C」「D」を読み、¹³C（質量数は左上）・D と描く。SMILES・Molfile・CDXML に入る', () => {
    expect(parseLabel('13C')).toEqual({ kind: 'element', element: 'C', charge: 0, isotope: 13 });
    expect(parseLabel('D')).toEqual({ kind: 'element', element: 'H', charge: 0, isotope: 2 });
    let d = importText(emptyDoc(), 'CC').doc;
    const c = Object.values(d.atoms)[0];
    d = edit(d, (x) => void (x.atoms[c.id].isotope = 13));
    const runs = layout(d).labels.get(c.id)!.runs;
    // 質量数は小さく、記号の C のすぐ左上（左に伸びるラベルなら H3 と C のあいだ）
    const sym = runs.find((r) => r.text.startsWith('C'))!;
    expect(runs[0].text).toBe('13');
    expect(runs[0].size).toBeLessThan(sym.size);
    expect(runs[0].x).toBeLessThan(sym.x);
    expect(runs[0].y).toBeLessThan(sym.y);
    // H3 と質量数が重ならない
    const hRun = runs.find((r) => r.text === 'H');
    if (hRun) expect(hRun.x + 1).toBeLessThan(runs[0].x);
    expect(docToSmiles(d).smiles).toBe('C[13CH3]');
    expect(parseMolfile(writeMolfile(d).molblock).atoms[0].isotope).toBe(13);
    for (const back of [viaCdxml(d), viaCdx(d)]) expect(Object.values(back.atoms).some((a) => a.isotope === 13)).toBe(true);
    let h = importText(emptyDoc(), '[2H]C').doc;
    h = edit(h, (x) => {
      for (const a of Object.values(x.atoms)) if (a.element === 'H') a.isotope = 2;
    });
    const dAtom = Object.values(h.atoms).find((a) => a.element === 'H')!;
    expect(layout(h).labels.get(dAtom.id)!.runs[0].text).toBe('D');
  });
});

describe('結合の種類（太い・点線・配位）', () => {
  it('描き分け、配位結合と点線の結合は構造と価数に入れない。CDXML・CDX に書いて読み戻せる', () => {
    let d = importText(emptyDoc(), 'CC.CC.NB').doc;
    const bonds = Object.values(d.bonds);
    const kinds = ['bold', 'dashed', 'dative'] as const;
    d = edit(d, (x) => bonds.forEach((b, i) => (x.bonds[b.id].stereo = kinds[i])));
    const nb = bonds[2];
    // N が a1（供与する側）になるようにそろえる
    if (d.atoms[nb.a1].element !== 'N') d = edit(d, (x) => ([x.bonds[nb.id].a1, x.bonds[nb.id].a2] = [nb.a2, nb.a1]));
    const prims = layout(d).prims;
    expect(prims.filter((p) => p.owner === bonds[0].id && p.k === 'poly')).toHaveLength(1);
    expect(prims.filter((p) => p.owner === bonds[1].id && p.k === 'line').length).toBeGreaterThan(2);
    expect(prims.filter((p) => p.owner === nb.id && p.k === 'poly')).toHaveLength(1);
    // 配位結合と点線の結合（水素結合・部分結合）は構造に入れないので、NH3 と BH3、点線の C···C は 2 つの CH4 のまま
    expect(docToSmiles(d).smiles).toBe('B.C.C.CC.N');
    const n = Object.values(d.atoms).find((a) => a.element === 'N')!;
    expect(layout(d).labels.get(n.id)!.runs.map((r) => r.text).join('')).toBe('NH3');
    for (const back of [viaCdxml(d), viaCdx(d)]) {
      expect(Object.values(back.bonds).map((b) => b.stereo).sort()).toEqual(['bold', 'dashed', 'dative']);
      const bb = Object.values(back.bonds).find((b) => b.stereo === 'dative')!;
      expect(back.atoms[bb.a1].element).toBe('N');
    }
  });
});

describe('図形（四角・楕円・括弧）', () => {
  it('描いて、選んで動かし、コピーして、消せる。保存・CDXML・CDX で読み戻せる', async () => {
    const { addShape } = await import('../src/editor/tools3');
    const { shapeDist } = await import('../src/editor/hit');
    const { extract, insertDoc, moveSelection } = await import('../src/chem/transform');
    const { deleteItems } = await import('../src/chem/ops');
    const { parseDocFile, serializeDoc } = await import('../src/io/docfile');
    let d = importText(emptyDoc(), 'CC(=O)O').doc;
    const kinds = ['rect', 'oval', 'bracket-square', 'bracket-round', 'bracket-curly'] as const;
    kinds.forEach((k, i) => (d = addShape(d, k, { x: 200 + i * 60, y: 100 }, { x: 240 + i * 60, y: 140 })));
    const ids = Object.keys(d.shapes!);
    expect(ids.every((id) => id.startsWith('h'))).toBe(true);
    const prims = layout(d).prims;
    expect(prims.filter((p) => p.owner === ids[0] && p.k === 'line')).toHaveLength(4);
    expect(prims.filter((p) => p.owner === ids[1] && p.k === 'path')).toHaveLength(1);
    expect(prims.filter((p) => p.owner === ids[2] && p.k === 'line')).toHaveLength(6);
    // 線の近くは当たり、中は当たらない
    expect(shapeDist(d.shapes![ids[0]], { x: 200, y: 120 })).toBeLessThan(0.5);
    expect(shapeDist(d.shapes![ids[0]], { x: 220, y: 120 })).toBeGreaterThan(5);
    expect(shapeDist(d.shapes![ids[1]], { x: 260, y: 120 })).toBeLessThan(0.5);
    // 動かす・コピー・消す
    const moved = moveSelection(d, [ids[0]], { x: 10, y: 5 });
    expect(moved.shapes![ids[0]].x1).toBe(210);
    const part = extract(d, [ids[0]]);
    expect(Object.keys(part.shapes!)).toEqual([ids[0]]);
    expect(Object.keys(insertDoc(d, part, { x: 0, y: 50 }).doc.shapes!)).toHaveLength(6);
    expect(Object.keys(deleteItems(d, [ids[0]]).shapes!)).toHaveLength(4);
    // 保存の形式・CDXML・CDX
    expect(parseDocFile(serializeDoc(d)).shapes).toEqual(d.shapes);
    for (const back of [viaCdxml(d), viaCdx(d)]) {
      const got = Object.values(back.shapes ?? {}).sort((a, b) => a.x1 - b.x1);
      expect(got.map((s) => s.kind)).toEqual([...kinds]);
      // 結合長でそろえ直すので、幅と高さの比で比べる
      for (const s of got) expect((s.x2 - s.x1) / (s.y2 - s.y1)).toBeCloseTo(1, 1);
    }
  });
});

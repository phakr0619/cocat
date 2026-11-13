import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { cdxmlToCdx, cdxToCdxml, isCdx } from '../src/io/cdx';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { importText } from '../src/io/convert';
import { canonical, docToSmiles, documentSmiles } from '../src/io/smiles';
import { emptyDoc, type Doc } from '../src/chem/model';
import { setAbbr } from '../src/chem/ops';
import { loadRDKit } from './rdkit';
import { ASPIRIN, moleculeDoc, reactionDoc } from './samples';

beforeAll(loadRDKit);

const smi = (d: Doc) => canonical(docToSmiles(d).smiles!);
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/cdx/${name}`));

describe('CDX（ChemDraw のバイナリ）', () => {
  it('ほかのソフト（Indigo）が書いた CDX の分子を読める（立体・電荷を含む）', () => {
    const b = fixture('indigo-mol.cdx');
    expect(isCdx(b)).toBe(true);
    const d = readCdxml(cdxToCdxml(b));
    expect(smi(d)).toBe(canonical('CC(=O)O[C@@H]1CC=C(Cl)C=C1[N+](=O)[O-]'));
  });

  it('ほかのソフト（Indigo）が書いた CDX の反応を読める（矢印と＋）', () => {
    const d = readCdxml(cdxToCdxml(fixture('indigo-rxn.cdx')));
    expect(Object.values(d.arrows)).toHaveLength(1);
    expect(Object.values(d.pluses)).toHaveLength(1);
    const [re, pr] = documentSmiles(d).smiles!.split('>>');
    expect(re.split('.').map((x) => canonical(x)).sort()).toEqual(['CC(=O)O', 'CCO'].map((x) => canonical(x)).sort());
    expect(canonical(pr)).toBe(canonical('CC(=O)OCC'));
  });

  it('書いた CDX を読み戻すと、同じ分子・反応・文字になる', () => {
    let d = moleculeDoc(ASPIRIN);
    const r = reactionDoc();
    const back = readCdxml(cdxToCdxml(cdxmlToCdx(writeCdxml(d))));
    expect(smi(back)).toBe(canonical(ASPIRIN));
    const back2 = readCdxml(cdxToCdxml(cdxmlToCdx(writeCdxml(r))));
    expect(documentSmiles(back2).smiles).toBe(documentSmiles(r).smiles);
    expect(Object.values(back2.texts).map((t) => t.text).sort()).toEqual(Object.values(r.texts).map((t) => t.text).sort());
    // 略号（中に構造を持つ Fragment のノード）と、くさび
    d = importText(emptyDoc(), 'CN[C@@H](C)C(=O)O').doc;
    // N の先のメチルを Boc にする
    const n = Object.values(d.atoms).find((a) => a.element === 'N')!;
    const me = Object.values(d.bonds).map((x) => (x.a1 === n.id ? x.a2 : x.a2 === n.id ? x.a1 : null)).find((id) => id && Object.values(d.bonds).filter((x) => x.a1 === id || x.a2 === id).length === 1)!;
    d = setAbbr(d, me, 'Boc');
    const back3 = readCdxml(cdxToCdxml(cdxmlToCdx(writeCdxml(d))));
    expect(smi(back3)).toBe(smi(d));
    expect(Object.values(back3.atoms).some((a) => a.abbr === 'Boc')).toBe(true);
  });

  it('日本語の文字も読み戻せる。CDX でないファイルは知らせる', () => {
    const d = importText(emptyDoc(), 'c1ccccc1').doc;
    d.texts.t1 = { id: 't1', x: 0, y: 40, text: '室温、2 時間' };
    const back = readCdxml(cdxToCdxml(cdxmlToCdx(writeCdxml(d))));
    expect(Object.values(back.texts).map((t) => t.text)).toEqual(['室温、2 時間']);
    expect(() => cdxToCdxml(new TextEncoder().encode('<CDXML/>'))).toThrow('CDX のファイルではありません');
  });

  it('検証用に out/ に書き出す（tools/verify_cdxml.py が RDKit の ChemDraw の部品で読む）', () => {
    mkdirSync('out', { recursive: true });
    writeFileSync('out/aspirin-cdx.cdx', cdxmlToCdx(writeCdxml(moleculeDoc(ASPIRIN))));
    writeFileSync('out/aspirin-cdx.expected.smi', `${canonical(ASPIRIN)}\n`);
  });
});

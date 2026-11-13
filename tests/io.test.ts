import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc, type Doc } from '../src/chem/model';
import { analyzeScheme } from '../src/chem/reaction';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { exportMol, exportSvg, importText } from '../src/io/convert';
import { canonical, docToSmiles, documentSmiles } from '../src/io/smiles';
import { parseXml } from '../src/io/xml';
import { loadRDKit } from './rdkit';
import { ASPIRIN, BOC_COUPLING, moleculeDoc, reactionDoc } from './samples';
import { bondAtPoint, setAbbr } from '../src/chem/ops';

beforeAll(loadRDKit);

const smi = (d: Doc) => canonical(docToSmiles(d).smiles!);

describe('MOL', () => {
  it('書き出して読み直すと同じ構造（立体を含む）', () => {
    const d = moleculeDoc('C[C@H](N)C(=O)O');
    const mol = exportMol(d);
    expect(mol).toContain('V2000');
    const back = importText(emptyDoc(), mol).doc;
    expect(smi(back)).toBe(canonical('C[C@H](N)C(=O)O'));
  });
});

describe('反応スキーム', () => {
  it('矢印の左右と上下を、反応物・生成物・条件に分ける', () => {
    const d = reactionDoc();
    const [st] = analyzeScheme(d);
    expect(st.reactants.filter((o) => o.kind === 'fragment')).toHaveLength(2);
    expect(st.products.filter((o) => o.kind === 'fragment')).toHaveLength(1);
    expect(st.pluses).toHaveLength(1);
    expect(st.above.map((o) => o.kind)).toEqual(['text']);
    expect(st.below.map((o) => o.kind)).toEqual(['text']);
    const r = documentSmiles(d).smiles!;
    const [reac, , prod] = r.split('>');
    const [er, , ep] = BOC_COUPLING.split('>');
    expect(reac.split('.').map(canonical).sort()).toEqual(er.split('.').map(canonical).sort());
    expect(canonical(prod)).toBe(canonical(ep));
  });
});

describe('CDXML', () => {
  it('XML として読め、ACS 1996 の設定を持つ', () => {
    const x = writeCdxml(moleculeDoc(ASPIRIN));
    const root = parseXml(x);
    const cdxml = root.children.find((c) => c.name === 'CDXML')!;
    expect(cdxml.attrs.BondLength).toBe('14.40');
    expect(cdxml.attrs.LineWidth).toBe('0.60');
    expect(x).toMatch(/face="96">(OH|HO)<\/s>/);
  });

  it('分子を書き出して読み直すと同じ構造', () => {
    for (const s of [ASPIRIN, 'C[C@H](N)C(=O)O', 'c1ccc2ccccc2c1', 'C[N+](C)(C)C.[Cl-]', 'O=C1CCCC1C#N']) {
      const back = readCdxml(writeCdxml(moleculeDoc(s)));
      expect(smi(back)).toBe(canonical(s));
    }
  });

  it('略号は Fragment ノードとして書き出し、読み直すと略号に戻る', () => {
    let d = bondAtPoint(emptyDoc(), { x: 50, y: 50 }, 'single');
    d = setAbbr(d, Object.values(d.atoms)[1].id, 'Boc');
    const x = writeCdxml(d);
    expect(x).toContain('NodeType="Fragment"');
    expect(x).toContain('NodeType="ExternalConnectionPoint"');
    const back = readCdxml(x);
    expect(Object.values(back.atoms).some((a) => a.abbr === 'Boc')).toBe(true);
    expect(smi(back)).toBe(canonical('CC(=O)OC(C)(C)C'));
  });

  it('反応スキームは scheme / step を持ち、読み直すと同じ反応', () => {
    const d = reactionDoc();
    const x = writeCdxml(d);
    const root = parseXml(x);
    const step = [...(function* w(n: ReturnType<typeof parseXml>): Generator<ReturnType<typeof parseXml>> { yield n; for (const c of n.children) yield* w(c); })(root)].find((n) => n.name === 'step')!;
    expect(step.attrs.ReactionStepReactants.split(' ')).toHaveLength(2);
    expect(step.attrs.ReactionStepProducts.split(' ')).toHaveLength(1);
    expect(step.attrs.ReactionStepArrows).toBeTruthy();
    expect(step.attrs.ReactionStepPlusses).toBeTruthy();
    expect(step.attrs.ReactionStepObjectsAboveArrow).toBeTruthy();
    expect(step.attrs.ReactionStepObjectsBelowArrow).toBeTruthy();
    const back = readCdxml(x);
    expect(Object.keys(back.arrows)).toHaveLength(1);
    expect(Object.values(back.texts).map((t) => t.text).sort()).toEqual(['DMF, rt', 'EDC, HOBt']);
    expect(documentSmiles(back).smiles).toBe(documentSmiles(d).smiles);
  });

  it('検証用のサンプルを out/ に書き出す', () => {
    mkdirSync('out', { recursive: true });
    const samples: Record<string, Doc> = {
      aspirin: moleculeDoc(ASPIRIN),
      alanine: moleculeDoc('C[C@H](N)C(=O)O'),
      reaction: reactionDoc(),
    };
    let abbr = bondAtPoint(emptyDoc(), { x: 50, y: 50 }, 'single');
    abbr = setAbbr(abbr, Object.values(abbr.atoms)[1].id, 'Boc');
    samples.abbreviation = abbr;
    for (const [name, d] of Object.entries(samples)) {
      writeFileSync(`out/${name}.cdxml`, writeCdxml(d));
      writeFileSync(`out/${name}.svg`, exportSvg(d));
      writeFileSync(`out/${name}.expected.smi`, (documentSmiles(d).smiles ?? '') + '\n');
    }
  });
});

describe('略号を含む反応', () => {
  it('分子ごとの SMILES に、ほかの分子の略号の原子が混ざらない', () => {
    let d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    d = setAbbr(d, Object.values(d.atoms)[1].id, 'Boc');
    d = bondAtPoint(d, { x: 100, y: 0 }, 'single');
    d = setAbbr(d, Object.values(d.atoms)[3].id, 'Boc');
    const first = [Object.keys(d.atoms)[0], Object.keys(d.atoms)[1]];
    expect(canonical(docToSmiles(d, first).smiles!)).toBe(canonical('CC(=O)OC(C)(C)C'));
  });
});

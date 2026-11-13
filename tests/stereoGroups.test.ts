import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc, molecules, type Doc } from '../src/chem/model';
import { setStereoGroup, stereoCenters, stereoGroupLabels } from '../src/chem/stereoGroups';
import { groupSalt } from '../src/chem/salt';
import { cdxmlToCdx, cdxToCdxml } from '../src/io/cdx';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { exportMol, importText } from '../src/io/convert';
import { docToSmiles } from '../src/io/smiles';
import { registerCompound } from '../src/project/library';
import { newProject } from '../src/project/model';
import { layout } from '../src/render/layout';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

// 2 つの不斉中心を持つ分子（くさび付きで描かれる）
const SMI = 'C[C@H](O)[C@@H](N)C';
const all = (d: Doc) => new Set(Object.keys(d.atoms));
const groupsOf = (d: Doc) =>
  stereoCenters(d)
    .map((id) => d.atoms[id].stereoGroup)
    .map((g) => (g ? `${g.type}${g.n}` : 'abs'))
    .sort();
const texts = (d: Doc) => layout(d).prims.flatMap((p) => (p.k === 'text' ? [p.run.text] : []));

describe('rac・rel（拡張立体表記）', () => {
  it('分子全体をラセミにすると、分子の下に rac を 1 つ出し、CXSMILES に &1 を書く', () => {
    let d = importText(emptyDoc(), SMI).doc;
    expect(stereoCenters(d)).toHaveLength(2);
    d = setStereoGroup(d, all(d), 'and');
    expect(groupsOf(d)).toEqual(['and1', 'and1']);
    expect(stereoGroupLabels(d).map((l) => l.text)).toEqual(['rac']);
    expect(texts(d)).toContain('rac');
    expect(docToSmiles(d).smiles).toMatch(/ \|&1:\d+,\d+\|$/);
    // 相対配置は rel と o1
    d = setStereoGroup(d, all(d), 'or');
    expect(stereoGroupLabels(d).map((l) => l.text)).toEqual(['rel']);
    expect(docToSmiles(d).smiles).toMatch(/ \|o1:\d+,\d+\|$/);
    // 絶対配置に戻すと印も CXSMILES の組も消える
    d = setStereoGroup(d, all(d), 'abs');
    expect(stereoGroupLabels(d)).toEqual([]);
    expect(docToSmiles(d).smiles).not.toContain('|');
  });

  it('一部の中心だけを組にすると、中心ごとに &1・abs を出す', () => {
    let d = importText(emptyDoc(), SMI).doc;
    const [c1] = stereoCenters(d);
    d = setStereoGroup(d, new Set([c1]), 'and');
    expect(stereoGroupLabels(d).map((l) => l.text).sort()).toEqual(['&1', 'abs']);
    expect(docToSmiles(d).smiles).toMatch(/\|a:\d+,&1:\d+\||\|&1:\d+,a:\d+\|/);
  });

  it('CXSMILES・MOL（V3000）・CDXML・CDX を読み書きしても組が残る', () => {
    const d = importText(emptyDoc(), `${SMI} |&1:1,3|`).doc;
    expect(groupsOf(d)).toEqual(['and1', 'and1']);
    const mol = exportMol(d);
    expect(mol).toContain('V3000');
    expect(mol).toMatch(/MDLV30\/STERAC1 ATOMS=\(2 /);
    expect(groupsOf(importText(emptyDoc(), mol).doc)).toEqual(['and1', 'and1']);
    const x = writeCdxml(d);
    expect(x).toContain('EnhancedStereoType="And" EnhancedStereoGroupNum="1"');
    expect(groupsOf(readCdxml(x))).toEqual(['and1', 'and1']);
    expect(groupsOf(readCdxml(cdxToCdxml(cdxmlToCdx(x))))).toEqual(['and1', 'and1']);
    // 組の無い分子は今までどおり V2000
    expect(exportMol(importText(emptyDoc(), SMI).doc)).toContain('V2000');
  });

  it('ライブラリでは、ラセミ体と光学活性体を別の化合物として登録できる', () => {
    const abs = importText(emptyDoc(), SMI).doc;
    const rac = setStereoGroup(abs, all(abs), 'and');
    let p = newProject('p');
    const r1 = registerCompound(p, abs, molecules(abs)[0]);
    if (!r1 || !('project' in r1)) throw new Error('登録できない');
    p = r1.project;
    const r2 = registerCompound(p, rac, molecules(rac)[0]);
    expect(r2 && 'project' in r2).toBe(true);
  });

  it('光学分割: ラセミの酸とキラルアミンの塩を描ける（酸は rac、アミンは絶対配置）', () => {
    let d = importText(emptyDoc(), 'C[C@@H](C(=O)O)c1ccccc1.C[C@@H](N)c1ccccc1').doc;
    const acid = molecules(d).find((m) => m.some((id) => d.atoms[id].element === 'O'))!;
    const [acidCenter] = stereoCenters(d, acid);
    d = setStereoGroup(d, new Set([acidCenter]), 'and');
    d = groupSalt(d, all(d));
    expect(molecules(d)).toHaveLength(1);
    expect(stereoGroupLabels(d).map((l) => l.text).sort()).toEqual(['&1', 'abs']);
    expect(docToSmiles(d).smiles).toMatch(/&1:/);
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { canonical } from '../src/io/smiles';

describe('rac の CDXML の見本（verify:cdxml で ChemDraw の部品に読ませる）', () => {
  it('書き出す', () => {
    const d = importText(emptyDoc(), `${SMI} |&1:1,3|`).doc;
    mkdirSync('out', { recursive: true });
    writeFileSync('out/stereo-rac.cdxml', writeCdxml(d));
    // ラセミ体なので、Indigo は鏡像の方で読むことがある（どちらも正しい）
    writeFileSync('out/stereo-rac.expected.smi', `${canonical(SMI)} || ${canonical('C[C@@H](O)[C@H](N)C')}\n`);
    expect(true).toBe(true);
  });
});

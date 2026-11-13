import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLabel } from '../src/chem/label';

describe('原子のラベルの電荷', () => {
  it('水素の数のあとの + / − は 1 価（NH2+ は N⁺、NH3+ も N⁺）', () => {
    expect(parseLabel('NH2+')).toEqual({ kind: 'element', element: 'N', charge: 1 });
    expect(parseLabel('NH3+')).toEqual({ kind: 'element', element: 'N', charge: 1 });
    expect(parseLabel('H3N+')).toEqual({ kind: 'element', element: 'N', charge: 1 });
    expect(parseLabel('OH-')).toEqual({ kind: 'element', element: 'O', charge: -1 });
  });
  it('元素のすぐあとの数は電荷の数（Fe3+、O2−）', () => {
    expect(parseLabel('Fe3+')).toEqual({ kind: 'element', element: 'Fe', charge: 3 });
    expect(parseLabel('O2-')).toEqual({ kind: 'element', element: 'O', charge: -2 });
    expect(parseLabel('N+')).toEqual({ kind: 'element', element: 'N', charge: 1 });
  });
});

import { beforeAll } from 'vitest';
import { analyzeFragment, targetFragments } from '../src/chem/analysis';
import { emptyDoc, molecules, type Doc } from '../src/chem/model';
import { groupSalt, ungroupSalt, canGroupSalt, canUngroupSalt } from '../src/chem/salt';
import { extract, insertDoc } from '../src/chem/transform';
import { importText } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import { registerCompound } from '../src/project/library';
import { newProject } from '../src/project/model';
import { startScheme } from '../src/scheme/ops';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const all = (d: Doc) => new Set(Object.keys(d.atoms));
const units = (d: Doc) => new Set(Object.values(d.atoms).map((a) => a.unit).filter(Boolean));

describe('塩（まとまり）', () => {
  it('選んだ 2 つの分子を塩としてまとめると、分析・選択で 1 つになり、解くと戻る', () => {
    let d = importText(emptyDoc(), 'CNCC(O)c1ccccc1.Cl').doc;
    // 中性の酸とアミンは、読み込んだだけではまとめない
    expect(molecules(d)).toHaveLength(2);
    expect(canGroupSalt(d, all(d))).toBe(true);
    d = groupSalt(d, all(d));
    expect(molecules(d)).toHaveLength(1);
    expect(targetFragments(d, new Set([Object.keys(d.atoms)[0]]))[0]).toHaveLength(12);
    const a = analyzeFragment(d, molecules(d)[0]);
    if ('error' in a) throw new Error(a.error);
    expect(a.formula).toBe('C9H14ClNO');
    expect(a.mw).toBeCloseTo(187.67, 1);
    expect(a.saltFormula).toBe('C9H13NO·HCl');
    // m/z は炭素を含む成分（遊離のアミン）の [M+H]+ だけ。HCl は出さない
    expect(a.mz).toHaveLength(1);
    expect(a.mz[0].value).toBeCloseTo(152.107, 2);
    expect(a.mz[0].label).toContain('C9H13NO');
    expect(canUngroupSalt(d, all(d))).toBe(true);
    d = ungroupSalt(d, all(d));
    expect(molecules(d)).toHaveLength(2);
    expect(units(d).size).toBe(0);
  });

  it('電荷が打ち消し合う SMILES は、読み込むと 1 つの塩になる', () => {
    const d = importText(emptyDoc(), 'C[NH2+]CC(O)c1ccccc1.[Cl-]').doc;
    expect(molecules(d)).toHaveLength(1);
    const a = analyzeFragment(d, molecules(d)[0]);
    if ('error' in a) throw new Error(a.error);
    expect(a.saltFormula).toBe('C9H14NO+·Cl−');
    expect(a.warnings.some((w) => w.message.includes('電荷'))).toBe(false);
    // 有機の陽イオンと陰イオンの塩は、それぞれの M+・M− を出す
    const ion = importText(emptyDoc(), 'C[C@@H](C(=O)[O-])c1ccccc1.C[C@@H]([NH3+])c1ccccc1').doc;
    const ia = analyzeFragment(ion, molecules(ion)[0]);
    if ('error' in ia) throw new Error(ia.error);
    expect(ia.mz.map((z) => z.label.slice(0, 2)).sort()).toEqual(['M+', 'M−']);
    // 2:1 の塩（酢酸カルシウム）は同じ成分をまとめて書く
    const ca = importText(emptyDoc(), 'CC(=O)[O-].CC(=O)[O-].[Ca+2]').doc;
    const b = analyzeFragment(ca, molecules(ca)[0]);
    if ('error' in b) throw new Error(b.error);
    expect(b.saltFormula).toBe('(C2H3O2−)2·Ca2+');
    // 電荷が残るもの（陽イオンだけ）はまとめない
    expect(molecules(importText(emptyDoc(), 'C[NH3+].C[NH3+].[Cl-]').doc)).toHaveLength(3);
  });

  it('光学分割のジアステレオマー塩: 立体の違う塩は別の化合物として登録できる', () => {
    const salt = (acid: string) => {
      let d = importText(emptyDoc(), `${acid}.C[C@@H](N)c1ccccc1`).doc;
      d = groupSalt(d, all(d));
      return d;
    };
    const rr = salt('C[C@@H](C(=O)O)c1ccccc1');
    const sr = salt('C[C@H](C(=O)O)c1ccccc1');
    let p = newProject('p');
    const r1 = registerCompound(p, rr, molecules(rr)[0]);
    if (!r1 || !('project' in r1)) throw new Error('登録できない');
    p = r1.project;
    const r2 = registerCompound(p, sr, molecules(sr)[0]);
    expect(r2 && 'project' in r2).toBe(true);
    // 同じ塩は重なりとして知らせる
    expect(registerCompound(p, rr, molecules(rr)[0])).toEqual({ duplicateOf: r1.id });
    expect(canonical(docToSmiles(rr).smiles!)).toBe(canonical('C[C@@H](C(=O)O)c1ccccc1.C[C@@H](N)c1ccccc1'));
  });

  it('貼り付けた塩は、元の塩と別のまとまりになる', () => {
    let d = importText(emptyDoc(), 'CN.Cl').doc;
    d = groupSalt(d, all(d));
    const part = extract(d, all(d));
    d = insertDoc(d, part, { x: 100, y: 0 }).doc;
    expect(units(d).size).toBe(2);
    expect(molecules(d)).toHaveLength(2);
  });

  it('スキームの化合物にすると、塩は 1 つの化合物で、置いた図でもまとまりのまま', () => {
    let d = importText(emptyDoc(), 'C[NH3+].[Cl-]').doc;
    const s = startScheme(d, molecules(d)[0]);
    d = s.doc;
    const comps = Object.values(d.compounds!);
    expect(comps).toHaveLength(1);
    expect(Object.values(comps[0].structure.atoms).every((a) => a.unit === 'u')).toBe(true);
    // 置いた原子は文書の中で一意なまとまり
    const placed = Object.values(d.atoms).filter((a) => a.ref);
    expect(new Set(placed.map((a) => a.unit)).size).toBe(1);
    expect(placed[0].unit).not.toBe('u');
    expect(molecules(d)).toHaveLength(1);
  });
});

import { parseLabel as parse2 } from '../src/chem/label';
import { edit } from '../src/chem/model';
import { saltLabelProblem } from '../src/chem/salt';
import { atomLabel } from '../src/render/labels';
import { adjacency } from '../src/chem/model';
import { exportCdxml, exportMol } from '../src/io/convert';

describe('ラベルで書く塩（NH2Cl・NH·HCl）', () => {
  const amine = () => importText(emptyDoc(), 'CNCC(O)c1ccccc1').doc;
  const nOf = (d: Doc) => Object.values(d.atoms).find((a) => a.element === 'N')!;
  const label = (d: Doc, text: string) => {
    const p = parse2(text);
    if (p?.kind !== 'element') throw new Error(`読めない: ${text}`);
    const n = nOf(d);
    const bad = saltLabelProblem(d, n.id, p);
    if (bad) throw new Error(bad);
    return edit(d, (x) => {
      x.atoms[n.id].element = p.element;
      x.atoms[n.id].charge = p.charge;
      if (p.salt) x.atoms[n.id].salt = { x: p.salt.x, style: p.salt.style };
    });
  };
  const text = (d: Doc) => atomLabel(nOf(d), d, adjacency(d))!.runs.map((r) => r.text).join('');

  it('書き方を読む', () => {
    expect(parse2('NH2Cl')).toEqual({ kind: 'element', element: 'N', charge: 0, salt: { x: 'Cl', style: 'ion', hCount: 2 } });
    expect(parse2('NH2+Cl-')).toEqual({ kind: 'element', element: 'N', charge: 0, salt: { x: 'Cl', style: 'ion', hCount: 2 } });
    expect(parse2('ClH3N')).toEqual({ kind: 'element', element: 'N', charge: 0, salt: { x: 'Cl', style: 'ion', hCount: 3 } });
    expect(parse2('NH·HCl')).toEqual({ kind: 'element', element: 'N', charge: 0, salt: { x: 'Cl', style: 'dot', hCount: 1 } });
    expect(parse2('N.HBr')).toEqual({ kind: 'element', element: 'N', charge: 0, salt: { x: 'Br', style: 'dot' } });
    expect(parse2('HCl·HN')).toEqual({ kind: 'element', element: 'N', charge: 0, salt: { x: 'Cl', style: 'dot', hCount: 1 } });
  });

  it('2 級アミンの NH2Cl: 図は NH2Cl、SMILES はイオン、分析は塩酸塩', () => {
    const d = label(amine(), 'NH2Cl');
    expect(text(d)).toBe('NH2Cl');
    expect(canonical(docToSmiles(d).smiles!)).toBe(canonical('C[NH2+]CC(O)c1ccccc1.[Cl-]'));
    const a = analyzeFragment(d, molecules(d)[0]);
    if ('error' in a) throw new Error(a.error);
    expect(a.saltFormula).toBe('C9H14NO+·Cl−');
    expect(a.mw).toBeCloseTo(187.67, 1);
    expect(exportMol(d)).toContain('Cl');
    // CDXML では陽イオンと対イオンの原子にして書く
    const x = exportCdxml(d);
    expect(x).toMatch(/Element="17"[^>]*Charge="-1"|Charge="-1"[^>]*Element="17"/);
  });

  it('NH·HCl は中性のアミンと HCl。水素の数が合わない書き方は知らせる', () => {
    const d = label(amine(), 'NH·HCl');
    expect(text(d)).toBe('NH·HCl');
    expect(canonical(docToSmiles(d).smiles!)).toBe(canonical('CNCC(O)c1ccccc1.Cl'));
    // 2 級アミンに NH3Cl は合わない。1 級アミンの NHCl は塩ではない（クロロアミンの書き方）
    expect(() => label(amine(), 'NH3Cl')).toThrow('NH2Cl');
    const prim = importText(emptyDoc(), 'CCN').doc;
    expect(() => label(prim, 'NHCl')).toThrow('NH3Cl');
  });
});

import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { cdxmlToCdx, cdxToCdxml } from '../src/io/cdx';
import { addStepWithProduct } from '../src/scheme/ops';

describe('塩の CDXML・CDX（group）', () => {
  it('塩は <group> で包んで書き、読み直すと 1 つの塩に戻る（CDX も同じ）', () => {
    let d = importText(emptyDoc(), 'C[C@@H](C(=O)O)c1ccccc1.C[C@@H](N)c1ccccc1').doc;
    d = groupSalt(d, all(d));
    const x = writeCdxml(d);
    expect(x.match(/<group /g)).toHaveLength(1);
    const back = readCdxml(x);
    expect(molecules(back)).toHaveLength(1);
    expect(canonical(docToSmiles(back).smiles!)).toBe(canonical(docToSmiles(d).smiles!));
    const viaCdx = readCdxml(cdxToCdxml(cdxmlToCdx(x)));
    expect(molecules(viaCdx)).toHaveLength(1);
    // ChemDraw の部品（RDKit・Indigo）で読めるかを verify:cdxml で確かめる（npm run samples で書き出す）
    mkdirSync('out', { recursive: true });
    writeFileSync('out/salt-diastereomer.cdxml', x);
    writeFileSync('out/salt-diastereomer.expected.smi', `${canonical(docToSmiles(d).smiles!)}\n`);
    const label = importText(emptyDoc(), 'CNCC(O)c1ccccc1').doc;
    const n = Object.values(label.atoms).find((a) => a.element === 'N')!;
    const hcl = edit(label, (z) => void (z.atoms[n.id].salt = { x: 'Cl', style: 'ion' }));
    writeFileSync('out/salt-label.cdxml', writeCdxml(hcl));
    writeFileSync('out/salt-label.expected.smi', `${canonical('C[NH2+]CC(O)c1ccccc1.[Cl-]')}\n`);
    // 塩でない分子は group にしない
    expect(writeCdxml(importText(emptyDoc(), 'CCO.CC').doc)).not.toContain('<group ');
  });

  it('スキームの生成物の塩は、反応の段から group として指す', () => {
    let d = importText(emptyDoc(), 'C[C@@H](C(=O)O)c1ccccc1').doc;
    const s = startScheme(d, molecules(d)[0]);
    d = importText(s.doc, 'C[C@@H](C(=O)[O-])c1ccccc1.C[C@@H]([NH3+])c1ccccc1').doc;
    const salt = molecules(d).find((m) => m.every((id) => !d.atoms[id].ref))!;
    d = addStepWithProduct(d, s.schemeId, salt);
    const x = writeCdxml(d);
    const gid = x.match(/<group id="(\d+)"/)![1];
    expect(x).toMatch(new RegExp(`ReactionStepProducts="${gid}"`));
  });
});

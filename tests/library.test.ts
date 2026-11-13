import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc, type Doc } from '../src/chem/model';
import { setElement } from '../src/chem/ops';
import { importText } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import {
  exportBundle, exportSdf, importBundle, linkedFragments, placeCompound, registerCompound, saveFigure, searchCompounds,
  setLink, updateLibraryInfo, updateLibraryStructure,
} from '../src/project/library';
import { newProject, type Project } from '../src/project/model';
import { MemoryStorage } from '../src/project/storage';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const mol = (s: string) => {
  const d = importText(emptyDoc(), s).doc;
  return { doc: d, ids: Object.keys(d.atoms) };
};

function register(p: Project, smiles: string): Project {
  const { doc, ids } = mol(smiles);
  const r = registerCompound(p, doc, ids);
  if (!r || 'duplicateOf' in r) throw new Error('登録できない');
  return r.project;
}

describe('化合物のライブラリ', () => {
  it('登録すると SMILES・InChIKey・組成式・分子量を持ち、同じ構造は重複として知らせる', () => {
    let p = newProject('全合成');
    const { doc, ids } = mol('CC(=O)Oc1ccccc1C(=O)O');
    const r = registerCompound(p, doc, ids)!;
    expect('id' in r).toBe(true);
    p = (r as { project: Project }).project;
    const c = Object.values(p.compounds)[0];
    expect(c.formula).toBe('C9H8O4');
    expect(c.mw).toBeCloseTo(180.16, 2);
    expect(c.inchikey).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
    // 描き方（座標）が違っても、同じ構造なら重複
    const again = mol('OC(=O)c1ccccc1OC(C)=O');
    expect(registerCompound(p, again.doc, again.ids)).toEqual({ duplicateOf: c.id });
    // 別の化合物として登録することもできる
    const forced = registerCompound(p, again.doc, again.ids, true) as { project: Project };
    expect(Object.keys(forced.project.compounds)).toHaveLength(2);
  });

  it('キャンバスに置くとつながり、直すと「変わった」になり、ライブラリを更新できる', () => {
    let p = register(newProject('p'), 'CCO');
    const c = Object.values(p.compounds)[0];
    let { doc, ids } = placeCompound(emptyDoc(), c, { x: 100, y: 100 });
    expect(docToSmiles(doc).smiles).toBe('CCO');
    expect(linkedFragments(doc, p)).toEqual([{ atomIds: [...ids].filter((x) => x.startsWith('a')), compoundId: c.id, status: 'same' }]);
    const o = Object.values(doc.atoms).find((a) => a.element === 'O')!;
    doc = setElement(doc, o.id, 'N');
    const [lf] = linkedFragments(doc, p);
    expect(lf.status).toBe('changed');
    p = updateLibraryStructure(p, c.id, doc, lf.atomIds);
    expect(p.compounds[c.id].smiles).toBe('CCN');
    expect(linkedFragments(doc, p)[0].status).toBe('same');
    // つながりを外すと、もう追わない
    expect(linkedFragments(setLink(doc, lf.atomIds, null), p)).toEqual([]);
  });

  it('文字と部分構造で探す', () => {
    let p = newProject('p');
    for (const s of ['c1ccccc1O', 'CC(=O)Nc1ccc(O)cc1', 'CCN(CC)CC']) p = register(p, s);
    const phenol = Object.values(p.compounds).find((c) => c.smiles === 'Oc1ccccc1')!;
    p = updateLibraryInfo(p, phenol.id, { nickname: 'フェノール中間体', number: 'AK-001' });
    expect(searchCompounds(p, 'フェノール').map((c) => c.id)).toEqual([phenol.id]);
    expect(searchCompounds(p, 'ak-001')).toHaveLength(1);
    expect(searchCompounds(p, 'C8H9NO2')).toHaveLength(1);
    const q = mol('c1ccccc1');
    expect(searchCompounds(p, '', { doc: q.doc, atomIds: q.ids })).toHaveLength(2);
  });

  it('図を保存し、一式を書き出して読み込める。SDF に番号と呼び名が入る', async () => {
    let p = register(newProject('p'), 'CCO');
    const c = Object.values(p.compounds)[0];
    p = updateLibraryInfo(p, c.id, { number: '12', nickname: 'エタノール' });
    const fig = saveFigure(p, '検討 1', mol('CCO>>CC=O').doc);
    p = fig.project;
    const sdf = exportSdf(p);
    expect(sdf).toContain('> <number>\n12');
    expect(sdf).toContain('> <nickname>\nエタノール');
    expect(sdf.trim().endsWith('$$$$')).toBe(true);
    const back = importBundle(exportBundle(p));
    expect(back.id).not.toBe(p.id);
    expect(back.compounds[c.id].nickname).toBe('エタノール');
    expect(Object.values(back.figures)[0].name).toBe('検討 1');
    const st = new MemoryStorage();
    await st.put(back);
    expect((await st.list())[0]).toMatchObject({ name: 'p', compoundCount: 1 });
    const fd: Doc = Object.values(back.figures)[0].doc;
    expect(canonical(docToSmiles(fd).smiles!.split('.')[0])).toBeTruthy();
  });
});

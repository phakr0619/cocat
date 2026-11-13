import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { importText } from '../src/io/convert';
import { crc32, makeZip, readZip } from '../src/io/zip';
import { importBundle, registerCompound, removeSavedTable, saveFigure, saveTable, updateLibraryInfo } from '../src/project/library';
import { newProject, type Project } from '../src/project/model';
import { compoundsCsv, exportZip } from '../src/project/zip';
import { createTable, pasteRows } from '../src/table/ops';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe('zip', () => {
  it('CRC-32 は決まった値になる', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });

  it('作った zip を読み戻せる（日本語の名前も）', () => {
    const z = makeZip([{ name: 'a.txt', data: 'hello' }, { name: '図/スキーム.svg', data: '<svg/>' }]);
    const m = readZip(z);
    expect(text(m.get('a.txt'))).toBe('hello');
    expect(text(m.get('図/スキーム.svg'))).toBe('<svg/>');
  });
});

function sampleProject(): Project {
  let p = newProject('全合成');
  const d = importText(emptyDoc(), 'CC(=O)Oc1ccccc1C(=O)O').doc;
  const r = registerCompound(p, d, Object.keys(d.atoms));
  if (!r || 'duplicateOf' in r) throw new Error('登録できない');
  p = updateLibraryInfo(r.project, r.id, { number: '1', nickname: 'アスピリン, "標品"' });
  let fig = importText(emptyDoc(), 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC').doc;
  const t = createTable(fig, 'conditions');
  fig = pasteRows(t.doc, t.tableId, 'HATU (1.2)\tDMF\trt\t2\t\t\t92').doc;
  p = saveFigure(p, 'カップリング/検討', fig).project;
  p = saveFigure(p, 'カップリング/検討', fig).project;
  return p;
}

describe('プロジェクト一式の zip', () => {
  it('JSON・SDF・CSV と、図ごとの CDXML・SVG・文書・表の CSV が入る', () => {
    const p = sampleProject();
    const m = readZip(exportZip(p));
    expect([...m.keys()].sort()).toEqual([
      'README.txt', 'compounds.csv', 'compounds.sdf',
      'figures/カップリング_検討-2-table1.csv', 'figures/カップリング_検討-2.acedoc', 'figures/カップリング_検討-2.cdxml', 'figures/カップリング_検討-2.svg',
      'figures/カップリング_検討-table1.csv', 'figures/カップリング_検討.acedoc', 'figures/カップリング_検討.cdxml', 'figures/カップリング_検討.svg',
      'project.aceproj.json',
    ]);
    expect(importBundle(text(m.get('project.aceproj.json'))).name).toBe('全合成');
    expect(text(m.get('compounds.sdf'))).toContain('> <nickname>');
    expect(text(m.get('figures/カップリング_検討-table1.csv'))).toContain('1,HATU (1.2),DMF,rt,2,,,92');
    expect(compoundsCsv(p).split('\r\n')[1]).toBe('1,"アスピリン, ""標品""",C9H8O4,180.16,CC(=O)Oc1ccccc1C(=O)O,BSYNRYMUTXBXSQ-UHFFFAOYSA-N,');
  });

  it('Python の zipfile で開ける（ほかのソフトで壊れていない）', () => {
    mkdirSync('out', { recursive: true });
    writeFileSync('out/project.zip', exportZip(sampleProject()));
    const out = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))', 'out/project.zip']).toString();
    expect(out.trim().split('\n')).toEqual(['None', '12']);
  });

  it('保存した検討表は tables/ に .xlsx と CSV で入り、一式の JSON から読み戻せる', () => {
    const fig = importText(emptyDoc(), 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC').doc;
    const t = createTable(fig, 'conditions');
    const d = pasteRows(t.doc, t.tableId, 'HATU (1.2)\tDMF\trt\t2\t\t\t92').doc;
    const saved = saveTable(newProject('全合成'), d, t.tableId, 'Table 1')!;
    const m = readZip(exportZip(saved.project));
    expect([...m.keys()].filter((k) => k.startsWith('tables/')).sort()).toEqual(['tables/Table 1.csv', 'tables/Table 1.xlsx']);
    expect(text(m.get('tables/Table 1.csv'))).toContain('1,HATU (1.2),DMF,rt,2,,,92');
    const back = importBundle(text(m.get('project.aceproj.json')));
    expect(back.tables![saved.id].table.rows).toHaveLength(3);
    expect(removeSavedTable(saved.project, saved.id).tables).toEqual({});
    // 前の版のプロジェクト（tables が無い）も読める
    expect(importBundle(JSON.stringify({ format: 'ai-chem-editor-project', version: 1, project: { name: 'old', compounds: {}, figures: {} } })).tables).toEqual({});
  });
});

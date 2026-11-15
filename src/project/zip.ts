// プロジェクト一式を zip にする: ほかのソフトで開ける形（CDXML・SDF・CSV・SVG）と、元に戻せる JSON
import { writeCdxml } from '../io/cdxml';
import { exportSvg } from '../io/convert';
import { serializeDoc, DOC_EXT } from '../io/docfile';
import { makeZip, type ZipEntry } from '../io/zip';
import { emptyDoc } from '../chem/model';
import { runEventsCsv, runTsv } from '../process/report';
import { tableCsv, tableXlsx } from '../table/ops';
import { exportBundle, exportSdf } from './library';
import type { Project } from './model';

/** ファイル名に使えない文字を除く。同じ名前は「-2」を付けて分ける */
function namer() {
  const used = new Set<string>();
  return (raw: string) => {
    const base = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'untitled';
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    return name;
  };
}

const csvCell = (s: string | number | undefined) => {
  const v = s === undefined ? '' : String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** 化合物の一覧（Excel で開ける CSV、BOM つき） */
export function compoundsCsv(project: Project): string {
  const head = ['number', 'nickname', 'formula', 'mw', 'smiles', 'inchikey', 'note'];
  const rows = Object.values(project.compounds).map((c) => [c.number, c.nickname, c.formula, c.mw.toFixed(2), c.smiles, c.inchikey, c.note].map(csvCell).join(','));
  return `﻿${[head.join(','), ...rows].join('\r\n')}\r\n`;
}

const README = `このフォルダは Cocat のプロジェクト一式です。

- project.aceproj.json  … 元に戻せる一式。エディタの「プロジェクトの書き出し・読み込み」で読み込めます
- compounds.sdf         … 化合物（番号・呼び名・メモつき）。ChemDraw・Excel のアドインなどで開けます
- compounds.csv         … 化合物の一覧（Excel で開けます）
- figures/<名前>.cdxml  … 図（ChemDraw で開けます）
- figures/<名前>.svg    … 図（ブラウザや Word・PowerPoint に貼れます）
- figures/<名前>${DOC_EXT} … 図（エディタで開き直せます）
- figures/<名前>-table<番号>.csv … 図の中の検討表（Excel で開けます）
- tables/<名前>.xlsx・.csv … 保存した検討表（Excel で開けます）
`;

export function exportZip(project: Project, now = new Date()): Uint8Array {
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: README },
    { name: 'project.aceproj.json', data: exportBundle(project) },
    { name: 'compounds.sdf', data: exportSdf(project) },
    { name: 'compounds.csv', data: compoundsCsv(project) },
  ];
  const name = namer();
  for (const f of Object.values(project.figures)) {
    const n = name(f.name);
    entries.push({ name: `figures/${n}.cdxml`, data: writeCdxml(f.doc) });
    entries.push({ name: `figures/${n}.svg`, data: exportSvg(f.doc) });
    entries.push({ name: `figures/${n}${DOC_EXT}`, data: serializeDoc(f.doc, now) });
    Object.values(f.doc.tables ?? {}).forEach((t, i) => {
      entries.push({ name: `figures/${n}-table${t.number?.trim() || i + 1}.csv`, data: `﻿${tableCsv(t)}` });
    });
  }
  const tname = namer();
  for (const t of Object.values(project.tables ?? {})) {
    const n = tname(t.name);
    entries.push({ name: `tables/${n}.xlsx`, data: tableXlsx(t.table, now) });
    entries.push({ name: `tables/${n}.csv`, data: `﻿${tableCsv(t.table)}` });
  }
  const rname = namer();
  for (const r of Object.values(project.runs ?? {})) {
    const n = rname(r.name);
    entries.push({ name: `runs/${n}.tsv`, data: `﻿${runTsv(emptyDoc(), r.run)}` });
    entries.push({ name: `runs/${n}-events.csv`, data: `﻿${runEventsCsv(emptyDoc(), r.run)}` });
  }
  return makeZip(entries, now);
}

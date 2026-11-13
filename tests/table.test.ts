import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportSvg } from '../src/io/convert';
import { parseLabel } from '../src/chem/label';
import { adjacency, edit, emptyDoc, fragments, type Doc } from '../src/chem/model';
import { setAbbr } from '../src/chem/ops';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { importText } from '../src/io/convert';
import { parseDocFile, serializeDoc } from '../src/io/docfile';
import { canonical, docToSmiles, documentSmiles } from '../src/io/smiles';
import { atomLabel } from '../src/render/labels';
import { formulaRuns } from '../src/render/text';
import { freeFragments, startScheme, addSubstrate, addStepWithProduct, updateStep } from '../src/scheme/ops';
import { substituentStructure, tableBounds } from '../src/table/layout';
import {
  addColumn, addRow, createTable, dissolveTable, moveRow, moveRowTo, packTable, pasteRows, placeTable, removeColumn, removeTable, rowConditions, schemeFromRow, setCell, setNotes,
  tableCsv, tableTsv, tableXlsx, updateColumn,
} from '../src/table/ops';
import { syncTables } from '../src/table/sync';
import { syncSchemes } from '../src/scheme/sync';
import { renderScheme } from '../src/scheme/layout';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** Boc-Ala-OH + H-Gly-OMe → ジペプチド のスキーム */
function coupling() {
  let d = importText(emptyDoc(), 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O').doc;
  d = importText(d, 'NCC(=O)OC').doc;
  d = importText(d, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC').doc;
  const [boc, gly, prod] = freeFragments(d, new Set());
  let { doc, schemeId } = startScheme(d, boc);
  doc = addSubstrate(doc, schemeId, 0, gly);
  doc = addStepWithProduct(doc, schemeId, prod);
  doc = updateStep(doc, schemeId, 0, { reagents: [{ text: 'conditions' }] });
  return { doc, schemeId };
}

const texts = (d: Doc, ref: string) => Object.values(d.texts).filter((t) => t.ref === ref).map((t) => t.text);
const rules = (d: Doc, ref: string) => Object.values(d.arrows).filter((r) => r.ref === ref && r.kind === 'line');

describe('検討表（条件検討型）', () => {
  it('反応式の下に、題・見出し・罫線3本・注を描く。反応 SMILES は変わらない', () => {
    const { doc: d0, schemeId } = coupling();
    const before = documentSmiles(d0).smiles;
    const { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    const t = texts(doc, tableId);
    expect(t).toContain('Table 1.');
    expect(t).toContain('Optimization of the reaction conditions');
    expect(t).toEqual(expect.arrayContaining(['entry', 'reagent (equiv)', 'solvent', 'temp (°C)', 'time (h)', 'workup', 'purification', 'yield (%)ᵃ', 'ᵃIsolated yield.']));
    expect(t.filter((x) => /^[123]$/.test(x))).toEqual(['1', '2', '3']);
    expect(rules(doc, tableId)).toHaveLength(3);
    // 表は反応式より下、題は反応式より上
    const schemeArrow = Object.values(doc.arrows).find((r) => r.ref === schemeId)!;
    const top = Math.min(...rules(doc, tableId).map((r) => r.y1));
    expect(top).toBeGreaterThan(schemeArrow.y1);
    const title = Object.values(doc.texts).find((x) => x.text === 'Table 1.')!;
    expect(title.y).toBeLessThan(Math.min(...Object.values(doc.atoms).filter((a) => a.ref?.startsWith(`${schemeId}:`)).map((a) => a.y)));
    expect(documentSmiles(doc).smiles).toBe(before);
  });

  it('セル・行・列・注を直すと描き直す。反応式を動かすと表も動く', () => {
    const { doc: d0, schemeId } = coupling();
    let { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    const tb = () => doc.tables![tableId];
    const col = (kind: string) => tb().columns.find((c) => c.kind === kind)!.id;
    doc = setCell(doc, tableId, tb().rows[0].id, col('reagent'), 'HATU (1.2)');
    doc = setCell(doc, tableId, tb().rows[0].id, col('solvent'), 'CH2Cl2');
    doc = setCell(doc, tableId, tb().rows[0].id, col('yield'), '85');
    expect(texts(doc, tableId)).toEqual(expect.arrayContaining(['HATU (1.2)', 'CH2Cl2', '85']));
    expect(Object.values(doc.texts).find((x) => x.text === 'CH2Cl2' && x.ref === tableId)!.formula).toBe(true);
    doc = addRow(doc, tableId, tb().rows[0].id);
    expect(tb().rows).toHaveLength(4);
    expect(tb().rows[1].cells[col('reagent')]).toBe('HATU (1.2)');
    doc = moveRow(doc, tableId, tb().rows[1].id, 1);
    expect(tb().rows[2].cells[col('reagent')]).toBe('HATU (1.2)');
    doc = removeColumn(doc, tableId, col('workup'));
    expect(texts(doc, tableId)).not.toContain('workup');
    doc = addColumn(doc, tableId, 'ratio');
    doc = updateColumn(doc, tableId, tb().columns.at(-1)!.id, { label: 'dr', mark: 'b' });
    doc = setNotes(doc, tableId, ['Isolated yield.', 'Determined by 1H NMR.']);
    expect(texts(doc, tableId)).toEqual(expect.arrayContaining(['drᵇ', 'ᵇDetermined by 1H NMR.']));

    const y0 = Math.min(...rules(doc, tableId).map((r) => r.y1));
    // スキームを描き直すと、それを反応式に使う表も一緒に描き直す
    doc = renderScheme(edit(doc, (d) => void (d.schemes![schemeId].origin.y += 30)), schemeId);
    expect(Math.min(...rules(doc, tableId).map((r) => r.y1))).toBeCloseTo(y0 + 30);
  });

  it('Excel からの貼り付け（見出しつき・見出しなし）と、タブ区切り・CSV の書き出し', () => {
    let { doc, tableId } = createTable(emptyDoc(), 'conditions');
    const r1 = pasteRows(doc, tableId, 'reagent (equiv)\tsolvent\tyield (%)\nTFA (10)\tCH2Cl2\t95\nHCl (4 M)\tdioxane\t88\n');
    doc = r1.doc;
    expect(r1.added).toBe(2);
    const t = doc.tables![tableId];
    const reagent = t.columns.find((c) => c.kind === 'reagent')!.id;
    const yieldCol = t.columns.find((c) => c.kind === 'yield')!.id;
    expect(t.rows.map((r) => r.cells[reagent])).toEqual(['TFA (10)', 'HCl (4 M)', undefined]);
    // 見出しなし・行の番号の列を除いた7列 → 空いた行から埋める
    doc = pasteRows(doc, tableId, 'TMSOTf (2)\tCH2Cl2\t0\t1\taq. NaHCO3\tcolumn\t91').doc;
    const t2 = doc.tables![tableId];
    expect(t2.rows).toHaveLength(3);
    expect(t2.rows[2].cells[yieldCol]).toBe('91');
    expect(tableTsv(t2).split('\n')[0]).toBe('entry\treagent (equiv)\tsolvent\ttemp (°C)\ttime (h)\tworkup\tpurification\tyield (%)ᵃ');
    expect(tableTsv(t2).split('\n')[3]).toBe('3\tTMSOTf (2)\tCH2Cl2\t0\t1\taq. NaHCO3\tcolumn\t91');
    doc = setCell(doc, tableId, t2.rows[0].id, t2.columns.find((c) => c.kind === 'workup')!.id, 'aq. NaHCO3, "brine"');
    expect(tableCsv(doc.tables![tableId]).split('\r\n')[1]).toBe('1,TFA (10),CH2Cl2,,,"aq. NaHCO3, ""brine""",,95');
  });

  it('行の条件で、表の反応式を複製したスキームを作る（化合物は共有）', () => {
    const { doc: d0, schemeId } = coupling();
    let { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    doc = pasteRows(doc, tableId, 'EDC·HCl (1.2), HOBt (1.2)\tDMF\trt\t12\t\t\t85').doc;
    const row = doc.tables![tableId].rows[0].id;
    expect(rowConditions(doc.tables![tableId], row)).toEqual({
      reagents: [{ text: 'EDC·HCl', equiv: 1.2 }, { text: 'HOBt', equiv: 1.2 }],
      solvent: 'DMF',
      temp: 'rt',
      time: '12 h',
      yield: 85,
    });
    const r = schemeFromRow(doc, tableId, row)!;
    const s = r.doc.schemes![r.schemeId];
    expect(s.steps[0].from).toEqual(doc.schemes![schemeId].steps[0].from);
    expect(s.steps[0].solvent).toBe('DMF');
    expect(texts(r.doc, r.schemeId)).toEqual(['EDC·HCl 1.2 equiv', 'HOBt 1.2 equiv', 'DMF, rt, 12 h', '85%']);
    // 新しいスキームは表の下に置く
    const bottom = tableBounds(r.doc, tableId)!.y2;
    expect(Math.min(...Object.values(r.doc.arrows).filter((x) => x.ref === r.schemeId).map((x) => x.y1))).toBeGreaterThan(bottom);
    // 単位つきの数だけの温度は「0 °C」にする
    const t = doc.tables![tableId];
    const d2 = setCell(doc, tableId, row, t.columns.find((c) => c.kind === 'temp')!.id, '0');
    expect(rowConditions(d2.tables![tableId], row).temp).toBe('0 °C');
  });

  it('表を丸ごと動かすと置き場所が動く（反応式があれば反応式ごと）', () => {
    const { doc: d0, schemeId } = coupling();
    const { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    const shifted = edit(doc, (d) => {
      for (const t of Object.values(d.texts)) if (t.ref === tableId) t.y += 20;
      for (const r of Object.values(d.arrows)) if (r.ref === tableId) {
        r.y1 += 20;
        r.y2 += 20;
      }
    });
    const out = syncTables(doc, syncSchemes(doc, shifted));
    expect(out.schemes![schemeId].origin.y).toBeCloseTo(doc.schemes![schemeId].origin.y + 20);
    expect(out.tables![tableId].origin.y).toBeCloseTo(doc.tables![tableId].origin.y + 20);

    const lone = createTable(emptyDoc(), 'conditions', { origin: { x: 10, y: 10 } });
    const moved = edit(lone.doc, (d) => {
      for (const t of Object.values(d.texts)) t.x += 5;
      for (const r of Object.values(d.arrows)) {
        r.x1 += 5;
        r.x2 += 5;
      }
    });
    expect(syncTables(lone.doc, moved).tables![lone.tableId].origin).toEqual({ x: 15, y: 10 });
  });

  it('反応式の無い表は、今の図の下に置く（2つ目の表が1つ目と重ならない）', () => {
    const a = createTable(emptyDoc(), 'conditions');
    expect(a.doc.tables![a.tableId].origin).toEqual({ x: 40, y: 40 });
    const b = createTable(a.doc, 'conditions');
    const boxA = tableBounds(b.doc, a.tableId)!;
    const boxB = tableBounds(b.doc, b.tableId)!;
    expect(boxB.y1).toBeGreaterThan(boxA.y2);
  });

  it('消す・ただの図に戻す', () => {
    const { doc: d0, schemeId } = coupling();
    const { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    const gone = removeTable(doc, tableId);
    expect(texts(gone, tableId)).toEqual([]);
    expect(gone.schemes![schemeId]).toBeTruthy();
    const plain = dissolveTable(doc, tableId);
    expect(plain.tables![tableId]).toBeUndefined();
    expect(Object.values(plain.texts).some((t) => t.text === 'Table 1.' && !t.ref)).toBe(true);
  });
});

describe('検討表（SAR 型）', () => {
  /** R1・R2 を持つ母核（4-置換ベンズアミド） */
  function core(): Doc {
    let d = importText(emptyDoc(), 'CC(=O)Nc1ccc(C)cc1').doc;
    const adj = adjacency(d);
    // 末端のメチル2つを R1・R2 にする
    const ends = Object.values(d.atoms).filter((a) => a.element === 'C' && (adj.bondsOf.get(a.id)?.length ?? 0) === 1);
    d = setAbbr(d, ends[0].id, 'R1');
    d = setAbbr(d, ends[1].id, 'R2');
    return d;
  }

  it('R1・R2 は置換基の記号として入力でき、上付きの番号で描き、SMILES では * になる', () => {
    expect(parseLabel('R1')).toEqual({ kind: 'abbr', abbr: 'R1' });
    expect(parseLabel("R'")).toEqual({ kind: 'abbr', abbr: "R'" });
    const d = core();
    const r1 = Object.values(d.atoms).find((a) => a.abbr === 'R1')!;
    const runs = atomLabel(r1, d, adjacency(d))!.runs;
    expect(runs.map((r) => r.text)).toEqual(['R', '1']);
    expect(runs[1].y).toBeLessThan(runs[0].y);
    expect(canonical(docToSmiles(d).smiles!)).toBe(canonical('*C(=O)Nc1ccc(*)cc1'));
  });

  it('母核を表の上に描き、置換基の列は「*」つきの SMILES を構造で描く', () => {
    const d0 = core();
    const [ids] = fragments(d0, adjacency(d0));
    let { doc, tableId } = createTable(d0, 'sar', { coreAtomIds: ids });
    expect(Object.values(doc.atoms).every((a) => a.ref)).toBe(true);
    const t = doc.tables![tableId];
    const [r1, r2] = t.columns.filter((c) => c.kind === 'structure');
    doc = setCell(doc, tableId, t.rows[0].id, r1.id, '*c1ccc(OC)cc1');
    doc = setCell(doc, tableId, t.rows[0].id, r2.id, 'Me');
    doc = setCell(doc, tableId, t.rows[1].id, r1.id, '4-ClC6H4');
    const cellAtoms = Object.values(doc.atoms).filter((a) => a.ref === `${tableId}:cell`).map((a) => a.id);
    expect(docToSmiles(doc, cellAtoms).smiles).toBe(canonical('*c1ccc(OC)cc1'));
    expect(texts(doc, tableId)).toEqual(expect.arrayContaining(['R1', 'R2', 'IC50 (nM)', 'Me', '4-ClC6H4']));
    // つなぐ点は左を向き、記号を出さない
    const s = substituentStructure('*c1ccc(OC)cc1')!;
    const star = Object.values(s.atoms).find((a) => a.element === '*')!;
    expect(star.x).toBeLessThan(Math.min(...Object.values(s.atoms).filter((a) => a !== star).map((a) => a.x)));
    // 回しても形は崩れない（結合の長さはそろったまま）
    for (const b of Object.values(s.bonds)) {
      expect(Math.hypot(s.atoms[b.a1].x - s.atoms[b.a2].x, s.atoms[b.a1].y - s.atoms[b.a2].y)).toBeCloseTo(14.4, 0);
    }
    const placedStar = Object.values(doc.atoms).find((a) => a.ref === `${tableId}:cell` && a.element === '*')!;
    expect(atomLabel(placedStar, doc, adjacency(doc))).toBeNull();
    // 行は構造の高さに合わせて広がる
    const ruleYs = rules(doc, tableId).map((r) => r.y1).sort((a, b) => a - b);
    expect(ruleYs[2] - ruleYs[1]).toBeGreaterThan(3 * 12.5 + 20);
  });

  it('母核をキャンバスで直すと、表の母核のデータも直る', () => {
    const d0 = core();
    const [ids] = fragments(d0, adjacency(d0));
    const { doc, tableId } = createTable(d0, 'sar', { coreAtomIds: ids });
    const o = Object.values(doc.atoms).find((a) => a.ref === `${tableId}:core` && a.element === 'O')!;
    const changed = edit(doc, (d) => {
      d.atoms[o.id].element = 'S';
    });
    const out = syncTables(doc, changed);
    expect(Object.values(out.tables![tableId].core!.atoms).some((a) => a.element === 'S')).toBe(true);
    expect(Object.values(out.atoms).some((a) => a.ref === `${tableId}:core` && a.element === 'S')).toBe(true);
  });
});

describe('試薬の名前の書き方', () => {
  it('T3P の数字は下付きにしない（Et3N・CH2Cl2 は下付き）', () => {
    const sizes = (s: string) => formulaRuns(s, 10, 0).runs.map((r) => [r.text, r.size]);
    expect(sizes('T3P (1.5), Et3N')).toEqual([['T3P (1.5), Et', 10], ['3', 7.5], ['N', 10]]);
    expect(sizes('CH2Cl2')).toEqual([['CH', 10], ['2', 7.5], ['Cl', 10], ['2', 7.5]]);
  });
});

describe('検討表の保存と書き出し', () => {
  it('文書の保存形式（版 3）に入り、版 2 の文書は表なしで開ける', () => {
    const { doc: d0, schemeId } = coupling();
    const { doc } = createTable(d0, 'conditions', { schemeId });
    expect(parseDocFile(serializeDoc(doc))).toEqual(doc);
    const v2 = JSON.stringify({ format: 'ai-chem-editor', version: 2, doc: { ...emptyDoc(), tables: undefined } });
    expect(parseDocFile(v2).tables).toEqual({});
  });

  it('CDXML に罫線（矢頭の無い線）と R1 を書き、読み戻せる', () => {
    const d0 = core2();
    const [ids] = fragments(d0, adjacency(d0));
    const { doc } = createTable(d0, 'sar', { coreAtomIds: ids });
    const xml = writeCdxml(doc);
    expect(xml).toContain('GenericNickname="R1"');
    expect(xml).not.toContain('ArrowType="NoHead"');
    const back = readCdxml(xml);
    expect(Object.values(back.arrows).filter((r) => r.kind === 'line')).toHaveLength(3);
    expect(Object.values(back.arrows).filter((r) => r.kind !== 'line')).toHaveLength(0);
    expect(Object.values(back.atoms).some((a) => a.abbr === 'R1')).toBe(true);
    expect(Object.values(back.texts).some((t) => t.text === 'Table 1.' && t.bold)).toBe(true);
  });
});

describe('セルの注の記号と Excel の書き出し', () => {
  it('セルの終わりの「^b」を上付きの記号にし、反応式へは写さない', () => {
    const { doc: d0, schemeId } = coupling();
    let { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    const t = doc.tables![tableId];
    const col = (k: string) => t.columns.find((c) => c.kind === k)!.id;
    doc = setCell(doc, tableId, t.rows[0].id, col('yield'), '85^b');
    doc = setCell(doc, tableId, t.rows[0].id, col('temp'), 'rt ^a, c');
    doc = setNotes(doc, tableId, ['Isolated yield.', 'Determined by NMR.', 'Under Ar.']);
    expect(texts(doc, tableId)).toEqual(expect.arrayContaining(['85ᵇ', 'rtᵃ,ᶜ', 'ᵇDetermined by NMR.']));
    expect(tableCsv(doc.tables![tableId]).split('\r\n')[1]).toBe('1,,,"rtᵃ,ᶜ",,,,85ᵇ');
    expect(rowConditions(doc.tables![tableId], t.rows[0].id)).toEqual({ temp: 'rt', yield: 85 });
    // 「^」の後が記号でなければ、そのまま
    doc = setCell(doc, tableId, t.rows[1].id, col('yield'), '10^5');
    expect(texts(doc, tableId)).toContain('10^5');
  });

  it('.xlsx に題・見出し（太字）・行（数は数）・注を書く', () => {
    const { doc: d0, schemeId } = coupling();
    let { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    doc = pasteRows(doc, tableId, 'TFA (10)\tCH2Cl2\t0\t1\taq. NaHCO3 & brine\tcolumn\t95').doc;
    const bytes = tableXlsx(doc.tables![tableId], new Date('2026-10-28T00:00:00'));
    mkdirSync('out', { recursive: true });
    writeFileSync('out/table-conditions.xlsx', bytes);
    // 格納（圧縮しない）形式の zip なので、中の XML がそのまま読める
    const raw = new TextDecoder().decode(bytes);
    expect(raw.startsWith('PK')).toBe(true);
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) expect(raw).toContain(part);
    expect(raw).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Table 1. Optimization of the reaction conditions</t></is></c>');
    expect(raw).toContain('<t xml:space="preserve">yield (%)ᵃ</t>');
    expect(raw).toContain('<c r="H4"><v>95</v></c>');
    expect(raw).toContain('aq. NaHCO3 &amp; brine');
    expect(raw).toContain('ᵃIsolated yield.');
  });
});

describe('行のドラッグでの並べ替え', () => {
  it('行を指定した位置へ動かす。範囲の外や同じ位置なら変えない', () => {
    let { doc, tableId } = createTable(emptyDoc(), 'conditions');
    const ids = doc.tables![tableId].rows.map((r) => r.id);
    doc = moveRowTo(doc, tableId, ids[2], 0);
    expect(doc.tables![tableId].rows.map((r) => r.id)).toEqual([ids[2], ids[0], ids[1]]);
    doc = moveRowTo(doc, tableId, ids[2], 2);
    expect(doc.tables![tableId].rows.map((r) => r.id)).toEqual([ids[0], ids[1], ids[2]]);
    expect(moveRowTo(doc, tableId, ids[0], 5).tables![tableId].rows.map((r) => r.id)).toEqual(ids);
  });
});

describe('表を持ち運ぶ（プロジェクトに入れて、ほかの図に置く）', () => {
  it('反応式ごと取り出し、別の文書に新しい id で置ける。2 回置いても重ならず、化合物は共有しない', () => {
    const { doc: d0, schemeId } = coupling();
    let { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    doc = pasteRows(doc, tableId, 'HATU (1.2)\tDMF\trt\t2\t\t\t92^b').doc;
    const pkg = packTable(doc, tableId)!;
    expect(Object.keys(pkg.compounds!)).toHaveLength(3);
    // 持ち運ぶ中身は JSON にできる（プロジェクトはブラウザに JSON で保存する）
    const back = JSON.parse(JSON.stringify(pkg));
    let other = importText(emptyDoc(), 'c1ccccc1').doc;
    const r1 = placeTable(other, back);
    other = r1.doc;
    const t1 = other.tables![r1.tableId];
    expect(t1.schemeId).toBeTruthy();
    expect(Object.keys(other.compounds!)).toHaveLength(3);
    expect(texts(other, r1.tableId)).toEqual(expect.arrayContaining(['Table 1.', 'HATU (1.2)', '92ᵇ']));
    const r2 = placeTable(other, back);
    expect(Object.keys(r2.doc.compounds!)).toHaveLength(6);
    expect(r2.doc.tables![r2.tableId].number).toBe('2');
    const b1 = tableBounds(r2.doc, r1.tableId)!;
    const b2 = tableBounds(r2.doc, r2.tableId)!;
    expect(b2.y1).toBeGreaterThan(b1.y2);
    // 置いた先の反応式は元の図と別のもの（元の文書は変わらない）
    expect(doc.tables![tableId].schemeId).toBe(schemeId);
    expect(Object.keys(doc.compounds!)).toHaveLength(3);
  });

  it('反応式の無い表は、表だけを持ち運ぶ', () => {
    const { doc, tableId } = createTable(emptyDoc(), 'conditions');
    const pkg = packTable(doc, tableId)!;
    expect(pkg.scheme).toBeUndefined();
    const r = placeTable(emptyDoc(), pkg);
    expect(r.doc.tables![r.tableId].schemeId).toBeUndefined();
    expect(texts(r.doc, r.tableId)).toContain('entry');
  });
});

describe('検証用のサンプル', () => {
  it('反応式つきの条件検討の表を out/ に書き出す（tools/verify_cdxml.py で読む）', () => {
    mkdirSync('out', { recursive: true });
    const { doc: d0, schemeId } = coupling();
    let { doc, tableId } = createTable(d0, 'conditions', { schemeId });
    doc = pasteRows(doc, tableId, 'EDC·HCl (1.2), HOBt (1.2)\tCH2Cl2\trt\t12\taq. NaHCO3\tcolumn\t85\nT3P (1.5), Et3N (3)\tEtOAc\t0\t4\twater\trecryst.\t64').doc;
    writeFileSync('out/table.cdxml', writeCdxml(doc));
    writeFileSync('out/table.svg', exportSvg(doc));
    writeFileSync('out/table.expected.smi', `${documentSmiles(doc).smiles}\n`);
    expect(documentSmiles(doc).smiles).toContain('>>');
  });
});

function core2(): Doc {
  let d = importText(emptyDoc(), 'Cc1ccccc1').doc;
  const me = Object.values(d.atoms).find((a) => (adjacency(d).bondsOf.get(a.id)?.length ?? 0) === 1)!;
  d = setAbbr(d, me.id, 'R1');
  return d;
}

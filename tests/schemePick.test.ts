import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/samples';
import { schemeArrows, schemeTargetOf } from '../src/scheme/pick';
import { loadRDKit } from './rdkit';

describe('スキームの図の物から、段と化合物を引く', () => {
  it('3 段のスキーム: 矢印と条件の文字は段、番号の文字は化合物を指す', async () => {
    await loadRDKit();
    const doc = SAMPLES.find((s) => s.id === 'multistep')!.build();
    const sid = Object.keys(doc.schemes!)[0];
    const scheme = doc.schemes![sid];
    const arrows = schemeArrows(doc, sid);
    expect(arrows.length).toBe(3);
    arrows.forEach((r, i) => expect(schemeTargetOf(doc, r.id)).toMatchObject({ kind: 'step', stepIndex: i }));
    const text = (s: string) => Object.values(doc.texts).find((t) => t.text.includes(s))!;
    expect(schemeTargetOf(doc, text('TFA').id)).toMatchObject({ kind: 'step', stepIndex: 1 });
    expect(schemeTargetOf(doc, text('92%').id)).toMatchObject({ kind: 'step', stepIndex: 2 });
    expect(schemeTargetOf(doc, text('EDC').id)).toMatchObject({ kind: 'step', stepIndex: 0 });
    // 番号「4」は 2 段目の生成物
    const four = Object.values(doc.texts).find((t) => t.text === '4' && t.bold)!;
    expect(schemeTargetOf(doc, four.id)).toMatchObject({ kind: 'compound', compoundId: scheme.steps[1].to[0] });
    const one = Object.values(doc.texts).find((t) => t.text === '1' && t.bold)!;
    expect(schemeTargetOf(doc, one.id)).toMatchObject({ kind: 'compound', compoundId: scheme.steps[0].from[0] });
  });
});

describe('検討表の図の文字から、セルを引く', () => {
  it('条件検討の見本: セルの文字は行と列、見出しの文字は列を指す。題と注は指さない', async () => {
    await loadRDKit();
    const { tableCellOf } = await import('../src/table/pick');
    const doc = SAMPLES.find((s) => s.id === 'conditions')!.build();
    const t = Object.values(doc.tables!)[0];
    const text = (s: string) => Object.values(doc.texts).find((x) => x.ref === t.id && x.text === s)!;
    const col = (kind: string) => t.columns.findIndex((c) => c.kind === kind);
    expect(tableCellOf(doc, text('DMF').id)).toEqual({ tableId: t.id, row: 1, col: col('solvent') });
    expect(tableCellOf(doc, text('64').id)).toEqual({ tableId: t.id, row: 2, col: col('yield') });
    expect(tableCellOf(doc, text('recryst.').id)).toEqual({ tableId: t.id, row: 2, col: col('purification') });
    expect(tableCellOf(doc, Object.values(doc.texts).find((x) => x.ref === t.id && x.text.startsWith('solvent'))!.id)).toEqual({ tableId: t.id, row: -1, col: col('solvent') });
    expect(tableCellOf(doc, Object.values(doc.texts).find((x) => x.ref === t.id && x.text.includes('Isolated yield'))!.id)).toBeNull();
    expect(tableCellOf(doc, Object.values(doc.texts).find((x) => x.ref === t.id && x.text.startsWith('Table'))!.id)).toBeNull();
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { parseDocFile, serializeDoc } from '../src/io/docfile';
import { exportSvg } from '../src/io/convert';
import { runBalance } from '../src/process/balance';
import { runBoxes, runTargetOf } from '../src/process/layout';
import { formatGrams, parseAmount, toGrams } from '../src/process/model';
import { addOperation, createRun, dissolveRun, moveOperation, packRun, placeRun, removeOperation, removeRun, setRunFlow, updateOperation } from '../src/process/ops';
import { newProject } from '../src/project/model';
import { importBundle, exportBundle, removeSavedRun, saveRun } from '../src/project/library';
import { exportZip } from '../src/project/zip';
import { syncRuns } from '../src/process/sync';
import { SAMPLES } from '../src/samples';
import { edit } from '../src/chem/model';
import { loadRDKit } from './rdkit';

beforeAll(async () => {
  await loadRDKit();
});

const sample = () => SAMPLES.find((s) => s.id === 'run')!.build();
const only = (doc: ReturnType<typeof sample>) => Object.values(doc.runs!)[0];

describe('量の単位', () => {
  it('重さは g に、体積は密度があれば g にする', () => {
    expect(toGrams({ value: 2, unit: 'kg' })).toBe(2000);
    expect(toGrams({ value: 250, unit: 'mg' })).toBe(0.25);
    expect(toGrams({ value: 100, unit: 'mL' }, 1.33)).toBeCloseTo(133);
    expect(toGrams({ value: 100, unit: 'mL' })).toBeUndefined();
    expect(formatGrams(1234)).toBe('1.23 kg');
    expect(formatGrams(0.25)).toBe('250 mg');
    expect(formatGrams(152)).toBe('152.0 g');
  });
  it('文字から量を読む', () => {
    expect(parseAmount('10 g')).toEqual({ value: 10, unit: 'g' });
    expect(parseAmount('2.5kg')).toEqual({ value: 2.5, unit: 'kg' });
    expect(parseAmount('100 ml')).toEqual({ value: 100, unit: 'mL' });
    expect(parseAmount('10')).toBeNull();
    expect(parseAmount('たくさん')).toBeNull();
  });
});

describe('見本の実験の記録の収支', () => {
  it('操作ごとの収支・収率・PMI が、手で計算した値と合う', () => {
    const run = only(sample());
    const b = runBalance(run);
    expect(run.operations.map((o) => o.name)).toEqual(['反応', '分液・洗浄', '濃縮', '晶析・ろ過', '乾燥']);
    // 反応: 10 + 4.7 + 12.2 + 8.6 + 100 mL × 1.33 = 168.5 g。出た物が無いので、次へ進む物は差から
    expect(b.ops[0].inG).toBeCloseTo(168.5, 1);
    expect(b.ops[0].carryDerived).toBe(true);
    expect(b.ops[0].closure).toBeUndefined();
    // 分液・洗浄: 入 168.5 + 150 = 318.5、出 163.9 + 152.0 = 315.9 → 99.2%
    expect(b.ops[1].inG).toBeCloseTo(318.5, 1);
    expect(b.ops[1].closure).toBeCloseTo(99.2, 1);
    // 濃縮: 入 152.0、出 131.0 + 18.4 → 98.3%
    expect(b.ops[2].closure).toBeCloseTo(98.3, 1);
    // 晶析・ろ過: 入 18.4 + 87 = 105.4、出 89.2 + 14.9 → 98.8%
    expect(b.ops[3].closure).toBeCloseTo(98.8, 1);
    // 乾燥: 揮発分は差から 3.0 g
    expect(b.ops[4].derivedOutputG).toBeCloseTo(3.0, 1);
    expect(b.productG).toBeCloseTo(11.9);
    // 理論収量: 10 g ÷ 189.21 × 260.29 = 13.76 g → 収率 86.5%
    expect(b.theoryG).toBeCloseTo(13.76, 1);
    expect(b.yieldPct).toBeCloseTo(86.5, 0);
    // 含量で補正: 11.9 × 0.991 ÷ (10 × 0.995 ÷ 189.21 × 260.29) = 86.2%
    expect(b.assayYieldPct).toBeCloseTo(86.2, 0);
    // PMI: 仕込みの合計 405.5 g ÷ 11.9 g = 34.1
    expect(b.totalInG).toBeCloseTo(405.5, 1);
    expect(b.pmi).toBeCloseTo(34.1, 1);
    // 内訳: 溶媒 (133 + 18 + 69) ÷ 11.9 = 18.5、水・水溶液 150 ÷ 11.9 = 12.6、そのほか 35.5 ÷ 11.9 = 3.0。足すと PMI
    expect(b.pmiParts!.solvent).toBeCloseTo(18.5, 1);
    expect(b.pmiParts!.water).toBeCloseTo(12.6, 1);
    expect(b.pmiParts!.other).toBeCloseTo(3.0, 1);
    expect(b.pmiParts!.solvent + b.pmiParts!.water + b.pmiParts!.other).toBeCloseTo(b.pmi!, 5);
    // 生成物の行方: 単離・水層・母液と、分からない分。合計は 100%
    expect(b.fate.map((f) => f.name)).toEqual(['単離', '水層', '母液・洗液']);
    expect(b.fate.reduce((a, f) => a + f.pct, 0) + b.fateUnknown!).toBeCloseTo(100);
    expect(b.fate[2].pct).toBeCloseTo(8.0, 0);
    // 知らせ: 乾燥の揮発分を差から出したこと
    expect(b.warnings.map((w) => w.text).join('\n')).toContain('揮発分 の重さが未入力です。差から 3.0 g としています');
  });

  it('収支が合わない・出が入より多い・時刻が逆のときに知らせる', () => {
    let doc = sample();
    const id = only(doc).id;
    const conc = only(doc).operations[2].id;
    doc = updateOperation(doc, id, conc, { carry: { value: 40, unit: 'g' } });
    expect(runBalance(only(doc)).warnings.some((w) => w.text.includes('出た重さが入れた重さより多く'))).toBe(true);
    doc = updateOperation(doc, id, conc, { carry: { value: 5, unit: 'g' } });
    expect(runBalance(only(doc)).warnings.some((w) => /濃縮: 収支が 89\.\d% です/.test(w.text))).toBe(true);
    const swapped = edit(doc, (d) => {
      const e = d.runs![id].events;
      [e[0].time, e[1].time] = [e[1].time, e[0].time];
    });
    expect(runBalance(only(swapped)).warnings.some((w) => w.text.includes('前の行より早く'))).toBe(true);
  });
});

describe('フロー図', () => {
  it('操作の数だけ箱を描き、箱からその操作を引ける。横と縦で向きが変わる', () => {
    let doc = sample();
    const run = only(doc);
    const boxes = runBoxes(doc, run.id);
    expect(boxes.length).toBe(5);
    expect(runTargetOf(doc, boxes[3].id)).toEqual({ runId: run.id, opId: run.operations[3].id });
    // 横: 箱は左から右へ並び、高さは同じ
    expect(boxes.every((b, i) => i === 0 || b.x1 > boxes[i - 1].x2)).toBe(true);
    expect(new Set(boxes.map((b) => b.y1)).size).toBe(1);
    const texts = (d: typeof doc) => Object.values(d.texts).filter((t) => t.ref === run.id);
    const find = (d: typeof doc, s: string) => texts(d).find((t) => t.text.includes(s))!;
    expect(find(doc, '収支 99.2%')).toBeTruthy();
    expect(find(doc, '152 g')).toBeTruthy();
    expect(find(doc, 'PMI 34.1')).toBeTruthy();
    // 横: 入れる物は箱の上、出る物は箱の下
    expect(find(doc, '1 M HCl').y).toBeLessThan(boxes[1].y1);
    expect(find(doc, '水層').y).toBeGreaterThan(boxes[1].y2);
    // 縦: 箱は上から下へ並び、入れる物は左、出る物と得た生成物は右
    doc = setRunFlow(doc, run.id, { direction: 'vertical' });
    const vb = runBoxes(doc, run.id);
    expect(vb.every((b, i) => i === 0 || b.y1 > vb[i - 1].y2)).toBe(true);
    expect(new Set(vb.map((b) => b.x1)).size).toBe(1);
    expect(find(doc, '1 M HCl').x).toBeLessThan(vb[1].x1);
    expect(find(doc, '水層').x).toBeGreaterThan(vb[1].x2);
    const product = texts(doc).find((t) => t.bold && t.text.startsWith('3'))!;
    expect(product.x).toBeGreaterThan(vb[4].x2);
    // 重さを出さない書式
    doc = setRunFlow(doc, run.id, { showMass: false });
    expect(texts(doc).some((t) => t.text.includes('収支'))).toBe(false);
    // SVG に書き出せる
    expect(exportSvg(doc)).toContain('分液・洗浄');
  });

  it('生成物の重さを添える書式: 含量を入れた外へ出る物に生成物の重さ、得た生成物に含量を添える', () => {
    let doc = sample();
    const run = only(doc);
    const texts = () => Object.values(doc.texts).filter((t) => t.ref === run.id).map((t) => t.text);
    expect(texts().some((t) => t.includes('生成物 '))).toBe(false);
    doc = setRunFlow(doc, run.id, { showProduct: true });
    expect(texts().find((t) => t.startsWith('水層'))).toContain('生成物 197 mg');
    expect(texts().find((t) => t.startsWith('母液・洗液'))).toContain('生成物 1.1 g');
    expect(texts().find((t) => t.startsWith('3'))).toContain('含量 99.1%');
    // 重さを出さないときは添えない
    doc = setRunFlow(doc, run.id, { showMass: false });
    expect(texts().some((t) => t.includes('生成物 ') || t.includes('含量 99'))).toBe(false);
  });

  it('太さで示す書式: 操作の間の矢印の太さが、進む物の重さの順になる', () => {
    let doc = sample();
    const run = only(doc);
    const weights = () => Object.values(doc.arrows).filter((a) => a.ref === run.id && a.weight).map((a) => a.weight!);
    expect(weights()).toEqual([]);
    doc = setRunFlow(doc, run.id, { widthByMass: true });
    const bal = runBalance(only(doc));
    const carries = bal.ops.slice(0, -1).map((b) => b.carryG!);
    const w = weights();
    expect(w.length).toBe(carries.length);
    expect(Math.max(...w)).toBeCloseTo(5, 5);
    // 重い流れほど太い
    for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) if (carries[i] > carries[j]) expect(w[i]).toBeGreaterThan(w[j]);
    // 縦でも同じ。SVG では太い線になる
    doc = setRunFlow(doc, run.id, { direction: 'vertical' });
    expect(weights().length).toBe(carries.length);
    expect(exportSvg(doc)).toContain('stroke-width="5"');
  });

  it('操作を足す・動かす・消すと、箱の数と順が変わる。記録を消すと図も消える', () => {
    let doc = sample();
    const id = only(doc).id;
    doc = addOperation(doc, id, 'quench', only(doc).operations[0].id);
    expect(only(doc).operations.map((o) => o.name).slice(0, 3)).toEqual(['反応', 'クエンチ', '分液・洗浄']);
    expect(runBoxes(doc, id).length).toBe(6);
    doc = moveOperation(doc, id, only(doc).operations[1].id, 1);
    expect(only(doc).operations[2].name).toBe('クエンチ');
    doc = removeOperation(doc, id, only(doc).operations[2].id);
    expect(runBoxes(doc, id).length).toBe(5);
    const plain = dissolveRun(doc, id);
    expect(plain.runs![id]).toBeUndefined();
    expect(Object.values(plain.shapes ?? {}).length).toBe(5);
    const gone = removeRun(doc, id);
    expect(Object.values(gone.shapes ?? {}).length).toBe(0);
    expect(Object.values(gone.texts).some((t) => t.ref === id)).toBe(false);
  });

  it('図を丸ごと動かすと置き場所が動き、一部だけ動かすと元の形に描き直す。全部消すと記録も消える', () => {
    const doc = sample();
    const run = only(doc);
    const all = edit(doc, (d) => {
      for (const t of Object.values(d.texts)) if (t.ref === run.id) (t.x += 30), (t.y += 12);
      for (const r of Object.values(d.arrows)) if (r.ref === run.id) (r.x1 += 30), (r.x2 += 30), (r.y1 += 12), (r.y2 += 12);
      for (const s of Object.values(d.shapes!)) if (s.ref === run.id) (s.x1 += 30), (s.x2 += 30), (s.y1 += 12), (s.y2 += 12);
    });
    const moved = syncRuns(doc, all);
    expect(only(moved).origin).toEqual({ x: run.origin.x + 30, y: run.origin.y + 12 });
    const boxId = runBoxes(doc, run.id)[0].id;
    const one = edit(doc, (d) => {
      d.shapes![boxId].x1 += 50;
      d.shapes![boxId].x2 += 50;
    });
    const back = syncRuns(doc, one);
    expect(only(back).origin).toEqual(run.origin);
    expect(runBoxes(back, run.id)[0].x1).toBeCloseTo(runBoxes(doc, run.id)[0].x1);
    const none = edit(doc, (d) => {
      for (const t of Object.values(d.texts)) if (t.ref === run.id) delete d.texts[t.id];
      for (const r of Object.values(d.arrows)) if (r.ref === run.id) delete d.arrows[r.id];
      for (const s of Object.values(d.shapes!)) if (s.ref === run.id) delete d.shapes![s.id];
    });
    expect(syncRuns(doc, none).runs![run.id]).toBeUndefined();
  });
});

describe('作る・保存する', () => {
  it('スキームの段から作ると、基質・試薬・溶媒が仕込みに入り、生成物が決まる', () => {
    const coupling = SAMPLES.find((s) => s.id === 'coupling')!.build();
    const sid = Object.keys(coupling.schemes!)[0];
    const { doc, runId } = createRun(coupling, { schemeId: sid, stepIndex: 0 });
    const run = doc.runs![runId];
    expect(run.materials.map((m) => [m.role, m.name])).toEqual([['substrate', '1'], ['substrate', '2'], ['reagent', 'EDC·HCl'], ['reagent', 'HOBt'], ['solvent', 'CH2Cl2']]);
    expect(run.materials[2].equiv).toBe(1.2);
    expect(run.product.compoundId).toBe(coupling.schemes![sid].steps[0].to[0]);
    expect(run.product.mw).toBeCloseTo(260.29, 1);
    expect(run.operations.map((o) => o.name)).toEqual(['反応', '分液・洗浄', '濃縮']);
  });
  it('スキームが無くても作れる', () => {
    const { doc, runId } = createRun(emptyDoc());
    expect(doc.runs![runId].materials).toEqual([]);
    expect(runBoxes(doc, runId).length).toBe(3);
  });
  it('文書に保存して読み直しても、記録が残る。前の版の文書も読める', () => {
    const doc = sample();
    const again = parseDocFile(serializeDoc(doc));
    expect(again.runs).toEqual(doc.runs);
    const old = JSON.parse(serializeDoc(SAMPLES.find((s) => s.id === 'coupling')!.build()));
    old.version = 3;
    delete old.doc.runs;
    expect(parseDocFile(JSON.stringify(old)).runs).toBeUndefined();
  });
});

describe('プロジェクトに入れる', () => {
  it('記録を入れて、別の図に置き直せる。スキームとのつながりは外れ、名前は文字で残る', () => {
    const doc = sample();
    const run = only(doc);
    const saved = saveRun(newProject('p'), doc, run.id, '縮合')!;
    const s = saved.project.runs![saved.id];
    expect(s.name).toBe('縮合');
    expect(s.run.schemeId).toBeUndefined();
    expect(s.run.materials.every((m) => !m.compoundId)).toBe(true);
    expect(s.run.materials[0].name).toBe('1');
    // 新しい図に置くと、同じ収支になる
    const placed = placeRun(emptyDoc(), s.run);
    const r2 = placed.doc.runs![placed.runId];
    expect(runBalance(r2).productG).toBeCloseTo(runBalance(run).productG!, 6);
    expect(runBoxes(placed.doc, placed.runId).length).toBe(5);
    // 同じ文書にもう一度置くと、別の id の記録になり、操作と記録の行のつながりも保つ
    const again = placeRun(placed.doc, s.run);
    expect(again.runId).not.toBe(placed.runId);
    const r3 = again.doc.runs![again.runId];
    expect(r3.events.every((e) => r3.operations.some((o) => o.id === e.opId))).toBe(true);
    expect(r3.materials.filter((m) => m.opId).every((m) => r3.operations.some((o) => o.id === m.opId))).toBe(true);
    expect(new Set([...r2.operations, ...r3.operations].map((o) => o.id)).size).toBe(10);
    // プロジェクトの書き出しと読み込み、消す
    expect(importBundle(exportBundle(saved.project)).runs![saved.id].name).toBe('縮合');
    expect(removeSavedRun(saved.project, saved.id).runs).toEqual({});
    expect(packRun(doc, 'none')).toBeNull();
  });

  it('手順だけ置くと、量・ロット・重さ・記録の行を外し、今日の日付にする', () => {
    const doc = sample();
    const run = packRun(doc, only(doc).id)!;
    const p = placeRun(emptyDoc(), run, true, new Date(2026, 10, 20));
    const r = p.doc.runs![p.runId];
    expect(r.date).toBe('2026-11-20');
    expect(r.notebook).toBeUndefined();
    expect(r.events).toEqual([]);
    expect(r.materials.length).toBe(run.materials.length);
    expect(r.materials.every((m) => !m.amount && !m.lot && m.assay === undefined)).toBe(true);
    expect(r.operations.map((o) => o.name)).toEqual(run.operations.map((o) => o.name));
    expect(r.operations.every((o) => !o.carry && o.outputs.every((x) => !x.amount))).toBe(true);
    expect(r.product.assay).toBeUndefined();
  });

  it('プロジェクトの zip に、記録のタブ区切りと記録の行の CSV が入る', () => {
    const doc = sample();
    const saved = saveRun(newProject('p'), doc, only(doc).id, '縮合')!;
    const zip = exportZip(saved.project);
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('runs/縮合.tsv');
    expect(text).toContain('runs/縮合-events.csv');
  });
});

// 見本の実験の記録: Boc-Ala-OH と H-Gly-OMe の縮合を 10 g で行った 1 回ぶん。数値は例で、実際の実験の値ではない
import type { Doc } from '../chem/model';
import { updateStoich } from '../scheme/ops';
import { addEvent, addMaterial, addOperation, addOutput, createRun, setRunInfo, setRunProduct, updateMaterial, updateOperation, updateOutput, updateRun } from './ops';

export function sampleRun(doc: Doc): Doc {
  const sid = Object.keys(doc.schemes ?? {})[0];
  if (!sid) return doc;
  // 化学量論表の基準を 10 g にしてから、記録を作る
  let d = updateStoich(doc, sid, 0, { scale: { value: 10000, unit: 'mg' } });
  const made = createRun(d, { schemeId: sid, stepIndex: 0 }, new Date(2026, 10, 10));
  d = made.doc;
  const id = made.runId;
  const run = () => d.runs![id];
  d = setRunInfo(d, id, { notebook: 'AB-012' });
  // 仕込み: 量を入れたとおりの値にする
  const amounts: Record<string, { value: number; unit: 'g' }> = { 'EDC·HCl': { value: 12.2, unit: 'g' }, HOBt: { value: 8.6, unit: 'g' } };
  for (const m of run().materials) {
    if (m.role === 'substrate') d = updateMaterial(d, id, m.id, { amount: { value: m === run().materials[0] ? 10 : 4.7, unit: 'g' } });
    else if (amounts[m.name]) d = updateMaterial(d, id, m.id, { amount: amounts[m.name] });
    else if (m.role === 'solvent') d = updateMaterial(d, id, m.id, { amount: { value: 100, unit: 'mL' }, density: 1.33 });
  }
  d = updateMaterial(d, id, run().materials[0].id, { assay: 99.5, lot: 'L-2311' });
  const [reaction, sep, conc] = run().operations.map((o) => o.id);
  for (const [name, g] of [['1 M HCl', 50], ['飽和 NaHCO3 水', 50], ['食塩水', 50]] as const) d = addMaterial(d, id, { name, role: 'other', amount: { value: g, unit: 'g' }, opId: sep });
  d = updateOutput(d, id, sep, run().operations[1].outputs[0].id, { amount: { value: 163.9, unit: 'g' }, productAssay: 0.12 });
  d = updateOperation(d, id, sep, { carry: { value: 152.0, unit: 'g' } });
  d = updateOutput(d, id, conc, run().operations[2].outputs[0].id, { amount: { value: 131.0, unit: 'g' } });
  d = updateOperation(d, id, conc, { carry: { value: 18.4, unit: 'g' } });
  d = addOperation(d, id, 'crystallization');
  const cryst = run().operations[3].id;
  d = updateOperation(d, id, cryst, { name: '晶析・ろ過', carry: { value: 14.9, unit: 'g' } });
  d = addMaterial(d, id, { name: 'AcOEt', role: 'solvent', amount: { value: 18, unit: 'g' }, opId: cryst });
  d = addMaterial(d, id, { name: 'ヘプタン', role: 'solvent', amount: { value: 69, unit: 'g' }, opId: cryst });
  d = addOutput(d, id, cryst, { name: '母液・洗液', amount: { value: 89.2, unit: 'g' }, productAssay: 1.23 });
  d = addOperation(d, id, 'drying');
  const dry = run().operations[4].id;
  d = updateOperation(d, id, dry, { carry: { value: 11.9, unit: 'g' } });
  d = addOutput(d, id, dry, { name: '揮発分' });
  d = setRunProduct(d, id, { assay: 99.1 });
  const events: [string, string, string, string, string, string][] = [
    [reaction, '09:12', '1・2・HOBt を CH2Cl2 に入れる', '', '20 °C', '無色の溶液'],
    [reaction, '09:20', 'EDC·HCl を 4 回に分けて入れる', '12.2 g', '2 → 6 °C', '発熱あり'],
    [reaction, '12:30', 'HPLC で反応を確かめる', '', '21 °C', '1 の残り 0.4 area%'],
    [sep, '12:41', '1 M HCl で洗う', '50 g', '20 °C', '水層 pH 1'],
    [sep, '12:55', '飽和 NaHCO3 水で洗う', '50 g', '21 °C', '水層 pH 8。分離に 5 min'],
    [sep, '13:06', '食塩水で洗う', '50 g', '', '有機層 152.0 g'],
    [conc, '13:30', '減圧で濃縮する', '', '35 °C', '留出 131.0 g'],
    [cryst, '14:10', 'AcOEt に溶かし、ヘプタンを入れる', '69 g', '45 → 5 °C', '25 °C で結晶が出はじめる'],
    [cryst, '16:00', 'ろ過して、ヘプタンで洗う', '', '5 °C', '湿結晶 14.9 g'],
    [dry, '16:20', '減圧で乾かす', '', '40 °C', '16 h。11.9 g'],
  ];
  for (const [opId, time, action, amount, temp, note] of events) d = addEvent(d, id, { opId, time, action, ...(amount ? { amount } : {}), ...(temp ? { temp } : {}), ...(note ? { note } : {}) });
  return updateRun(d, id, () => {});
}

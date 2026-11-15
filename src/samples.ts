// 見本の文書。初めての人が機能を試すためと、完了条件（見本を書式を切り替えて描き直せる）の確認に使う
import type { Doc } from './chem/model';
import { adjacency, emptyDoc, fragments } from './chem/model';
import { setAbbr } from './chem/ops';
import { importText } from './io/convert';
import { addStepWithProduct, addSubstrate, freeFragments, numberCompounds, startScheme, updateCompound, updateStep } from './scheme/ops';
import { createTable, pasteRows, setTableInfo } from './table/ops';
import { sampleRun } from './process/sample';

const BOC_ALA = 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O';
const GLY_OME = 'NCC(=O)OC';
const DIPEPTIDE = 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC';

function molecules(...smiles: string[]): Doc {
  let d = emptyDoc();
  for (const s of smiles) d = importText(d, s).doc;
  return d;
}

/** Boc-Ala-OH ＋ H-Gly-OMe → Boc-Ala-Gly-OMe のスキーム */
function coupling(): { doc: Doc; schemeId: string } {
  const d0 = molecules(BOC_ALA, GLY_OME, DIPEPTIDE);
  const [boc, gly, prod] = freeFragments(d0, new Set());
  let { doc, schemeId } = startScheme(d0, boc);
  doc = addSubstrate(doc, schemeId, 0, gly);
  doc = addStepWithProduct(doc, schemeId, prod);
  doc = updateStep(doc, schemeId, 0, { reagents: [{ text: 'EDC·HCl', equiv: 1.2 }, { text: 'HOBt', equiv: 1.2 }], solvent: 'CH2Cl2', temp: 'rt', time: '12 h', yield: 85 });
  return { doc: numberCompounds(doc, schemeId), schemeId };
}

/** 3段のスキーム（縮合 → Boc の除去 → けん化） */
function multiStep(): Doc {
  const d0 = molecules(BOC_ALA, GLY_OME, DIPEPTIDE, 'C[C@H](N)C(=O)NCC(=O)OC', 'C[C@H](N)C(=O)NCC(=O)O');
  const [boc, gly, p1] = freeFragments(d0, new Set());
  let { doc, schemeId } = startScheme(d0, boc);
  doc = addSubstrate(doc, schemeId, 0, gly);
  doc = addStepWithProduct(doc, schemeId, p1);
  // 足すたびに分子がスキームへ移るので、残りの分子を選び直す
  doc = addStepWithProduct(doc, schemeId, freeFragments(doc, new Set())[0]);
  doc = addStepWithProduct(doc, schemeId, freeFragments(doc, new Set())[0]);
  doc = updateStep(doc, schemeId, 0, { reagents: [{ text: 'EDC·HCl', equiv: 1.2 }, { text: 'HOBt', equiv: 1.2 }], solvent: 'CH2Cl2', temp: 'rt', time: '12 h', yield: 85 });
  doc = updateStep(doc, schemeId, 1, { reagents: [{ text: 'TFA' }], solvent: 'CH2Cl2', temp: '0 °C to rt', time: '1 h', yield: 'quant.' });
  doc = updateStep(doc, schemeId, 2, { reagents: [{ text: 'LiOH', equiv: 3 }], solvent: 'THF/H2O', temp: '0 °C', time: '2 h', yield: 92 });
  doc = numberCompounds(doc, schemeId);
  const s = doc.schemes![schemeId];
  return updateCompound(doc, s.steps[0].to[0], { nickname: 'ジペプチド' });
}

function conditionsTable(): Doc {
  const { doc: d0, schemeId } = coupling();
  let doc = updateStep(d0, schemeId, 0, { reagents: [{ text: 'conditions' }], solvent: undefined, temp: undefined, time: undefined, yield: undefined });
  const t = createTable(doc, 'conditions', { schemeId });
  doc = setTableInfo(t.doc, t.tableId, { title: 'Optimization of the coupling of 1 and 2' });
  return pasteRows(
    doc,
    t.tableId,
    [
      'EDC·HCl (1.2), HOBt (1.2)\tCH2Cl2\trt\t12\taq. NaHCO3\tcolumn\t85',
      'HATU (1.2), DIPEA (3)\tDMF\trt\t2\taq. LiCl\tcolumn\t92',
      'T3P (1.5), Et3N (3)\tEtOAc\t0\t4\twater\trecryst.\t64',
    ].join('\n'),
  ).doc;
}

function sarTable(): Doc {
  let d = importText(emptyDoc(), 'CC(=O)Nc1ccc(C)cc1').doc;
  const adj = adjacency(d);
  const ends = Object.values(d.atoms).filter((a) => a.element === 'C' && (adj.bondsOf.get(a.id)?.length ?? 0) === 1);
  d = setAbbr(d, ends[0].id, 'R1');
  d = setAbbr(d, ends[1].id, 'R2');
  const [ids] = fragments(d);
  const t = createTable(d, 'sar', { coreAtomIds: ids, origin: { x: 40, y: 40 } });
  return pasteRows(t.doc, t.tableId, ['1a\t*c1ccccc1\tMe\t120', '1b\t*c1ccc(OC)cc1\tMe\t35', '1c\t*c1ccc(Cl)cc1\tEt\t8.2'].join('\n')).doc;
}

export interface Sample {
  id: string;
  name: string;
  build(): Doc;
}

export const SAMPLES: Sample[] = [
  { id: 'aspirin', name: 'アスピリン', build: () => molecules('CC(=O)Oc1ccccc1C(=O)O') },
  {
    id: 'taxol',
    name: 'タキソール',
    build: () =>
      molecules('CC1=C2[C@@]([C@]([C@H]([C@@H]3[C@]4([C@H](OC4)C[C@@H]([C@]3(C(=O)[C@@H]2OC(=O)C)C)O)OC(=O)C)OC(=O)c5ccccc5)(C[C@@H]1OC(=O)[C@H](O)[C@@H](NC(=O)c6ccccc6)c7ccccc7)O)(C)C'),
  },
  { id: 'coupling', name: 'Boc カップリング（スキーム）', build: () => coupling().doc },
  { id: 'multistep', name: '3段のスキーム', build: multiStep },
  { id: 'conditions', name: '条件検討の表', build: conditionsTable },
  { id: 'sar', name: 'SAR の表', build: sarTable },
  { id: 'run', name: '実験の記録（縮合、10 g）', build: () => sampleRun(coupling().doc) },
];

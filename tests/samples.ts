// テストと検証用の見本の文書
import type { Doc } from '../src/chem/model';
import { emptyDoc } from '../src/chem/model';
import { setText } from '../src/chem/schemeOps';
import { importText } from '../src/io/convert';

export const ASPIRIN = 'CC(=O)Oc1ccccc1C(=O)O';
/** Boc-Ala-OH + H-Gly-OMe → Boc-Ala-Gly-OMe（縮合） */
export const BOC_COUPLING = 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC';

export function moleculeDoc(smiles: string): Doc {
  return importText(emptyDoc(), smiles).doc;
}

/** 反応スキーム: 矢印の上下に条件の文字を付ける */
export function reactionDoc(): Doc {
  let d = importText(emptyDoc(), BOC_COUPLING).doc;
  const r = Object.values(d.arrows)[0];
  d = setText(d, null, { x: r.x1 + 4, y: r.y1 - 6 }, 'EDC, HOBt');
  d = setText(d, null, { x: r.x1 + 4, y: r.y1 + 14 }, 'DMF, rt');
  return d;
}

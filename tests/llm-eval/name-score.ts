// 構造 → 名前の評価の採点。CI のテストと、本物の API で測る道具（name.eval.ts）の両方で使う
//
// 正しさの物差しは OPSIN（規則で名前を構造にする）: LLM の名前を OPSIN で構造に戻し、元の構造と同じなら正しい名前。
// OPSIN で読めない名前は、正しいかどうかを決めない（読めない名前として数える）
import type { OpsinAnswer } from '../../src/chem/opsin';
import { inchikeyOf, type StructureToNameResult } from '../../src/llm/structureToName';
import cases from './name-cases.json';
import type { CaseScore } from './score';

export interface NameEvalCase {
  id: string;
  smiles: string;
  /** 正解の一例 */
  name: string;
}

export const NAME_CASES = cases.cases as NameEvalCase[];

/** 名前の正しさ: OPSIN で戻した構造が同じなら true、違えば false、OPSIN で読めなければ null */
export function nameTruth(c: NameEvalCase, opsin: OpsinAnswer | undefined): boolean | null {
  if (!opsin?.smiles) return null;
  return inchikeyOf(opsin.smiles) === inchikeyOf(c.smiles);
}

/**
 * アプリの確かめ（r.verified）と、名前の正しさ（truth）から結果を決める。
 * correct: 正しい名前を確かめ済みにした / flagged: 要確認にした（名前が違うか、確かめられなかった）/
 * silent-wrong: 違う名前を確かめ済みにした（あってはならない）/ error: 呼び出しの失敗
 */
export function scoreName(c: NameEvalCase, r: StructureToNameResult, truth: boolean | null): CaseScore {
  const notes: string[] = [];
  const score = (outcome: CaseScore['outcome']): CaseScore => ({ id: c.id, outcome, conditions: { hit: truth ? 1 : 0, total: 1 }, notes });
  if (!r.ok) {
    notes.push(`${r.error.kind}: ${r.error.message}`);
    return score('error');
  }
  notes.push(r.name);
  if (truth === null) notes.push('OPSIN で読めない名前');
  else if (!truth) notes.push(`名前が違う（正解の一例: ${c.name}）`);
  if (r.checkedBy === 'llm') notes.push('AI で戻して確かめた');
  if (r.verified && truth === false) return score('silent-wrong');
  if (r.verified && truth) return score('correct');
  // 確かめ済みでないか、OPSIN で読めない名前を AI だけで確かめた
  return score('flagged');
}

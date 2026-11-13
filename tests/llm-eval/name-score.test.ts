import { beforeAll, describe, expect, it } from 'vitest';
import { loadRDKit } from '../rdkit';
import { NAME_CASES, nameTruth, scoreName } from './name-score';

beforeAll(loadRDKit);

describe('構造 → 名前の評価の採点', () => {
  const c = NAME_CASES.find((x) => x.name === '(1R,2S)-2-methylcyclohexan-1-ol')!;
  const ok = (verified: boolean, checkedBy: 'opsin' | 'llm' = 'opsin') => ({ ok: true as const, name: 'x', verified, checkedBy, warnings: [] });

  it('件は 21 件で、id は重ならない', () => {
    expect(NAME_CASES).toHaveLength(21);
    expect(new Set(NAME_CASES.map((x) => x.id)).size).toBe(21);
  });

  it('名前の正しさは、OPSIN で戻した構造（立体を含む）で決める', () => {
    expect(nameTruth(c, { status: 'SUCCESS', smiles: 'O[C@@H]1CCCC[C@@H]1C' })).toBe(true);
    expect(nameTruth(c, { status: 'SUCCESS', smiles: 'O[C@H]1CCCC[C@@H]1C' })).toBe(false);
    expect(nameTruth(c, { status: 'FAILURE' })).toBeNull();
  });

  it('違う名前を確かめ済みにしたら、黙って間違えた', () => {
    expect(scoreName(c, ok(true), true).outcome).toBe('correct');
    expect(scoreName(c, ok(false), false).outcome).toBe('flagged');
    expect(scoreName(c, ok(true, 'llm'), false).outcome).toBe('silent-wrong');
    expect(scoreName(c, ok(true, 'llm'), null).outcome).toBe('flagged');
    expect(scoreName(c, { ok: false, error: { kind: 'network', message: 'x' } }, null).outcome).toBe('error');
  });
});

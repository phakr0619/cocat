// 作った SI（tests/llm-eval/si-cases.json）の系統名が、手元の OPSIN で正解の構造に戻ること。wrong は正解と違う構造になること
import { beforeAll, describe, expect, it } from 'vitest';
import { inchikeyOf } from '../src/llm/structureToName';
import { loadRDKit } from './rdkit';
import { hasOpsinJar, javaOpsin } from './javaOpsin';
import siCases from './llm-eval/si-cases.json';

beforeAll(loadRDKit);

describe.skipIf(!hasOpsinJar())('作った SI の系統名', () => {
  it('name は正解の構造（立体を含む）に、wrong は別の構造に戻る', async () => {
    const products = siCases.cases.flatMap((c) => c.products.map((p) => ({ base: c.base, ...p })));
    const right = await javaOpsin(products.map((p) => p.name));
    const wrong = await javaOpsin(products.map((p) => p.wrong));
    const bad: string[] = [];
    products.forEach((p, i) => {
      const truth = inchikeyOf(p.smiles);
      const r = right?.[i]?.smiles ? inchikeyOf(right[i].smiles!) : null;
      const w = wrong?.[i]?.smiles ? inchikeyOf(wrong[i].smiles!) : null;
      if (!truth || r !== truth) bad.push(`${p.base} ${p.label}: name「${p.name}」→ ${right?.[i]?.smiles ?? right?.[i]?.status}`);
      if (!w || w === truth) bad.push(`${p.base} ${p.label}: wrong「${p.wrong}」→ ${wrong?.[i]?.smiles ?? wrong?.[i]?.status}`);
    });
    expect(bad).toEqual([]);
  });
});

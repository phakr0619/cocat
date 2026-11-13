import { beforeAll, describe, expect, it } from 'vitest';
import { anchorsOf, missingAnchors } from '../src/llm/skeleton';
import { checkPlan } from '../src/llm/textToScheme';
import { CASES, existingFor, planFromExpect } from './llm-eval/score';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

const azide = '[N-]=[N+]=NCc1ccccc1';

describe('基質のまとまりが生成物に残っているか', () => {
  it('click: 正しい 1-ベンジル-4-フェニル体には出さず、置換基を取り違えた 1-フェニル-4-ベンジル体には出す', () => {
    expect(anchorsOf(azide).map((a) => a.label)).toEqual(['NCc1ccccc1']);
    expect(missingAnchors(azide, ['c1ccc(Cn2cc(-c3ccccc3)nn2)cc1'])).toEqual([]);
    expect(missingAnchors(azide, ['c1ccc(Cc2cn(c3ccccc3)nn2)cc1']).map((a) => a.label)).toEqual(['NCc1ccccc1']);
  });

  it('芳香環だけを見る。環に直接ついた O・N・ハロゲン、C=O の先、ベンジル位の O、環の N の先は入れない', () => {
    expect(anchorsOf('COc1ccc(Br)cc1')).toEqual([]);
    expect(anchorsOf('O=C1CCCCC1')).toEqual([]);
    expect(anchorsOf('CC(C)(C)OC(=O)N1CCC(CO)CC1')).toEqual([]);
    expect(anchorsOf('OCc1ccccc1').map((a) => a.label)).toEqual(['Cc1ccccc1']);
    expect(anchorsOf('COc1ccc([N+](=O)[O-])cc1')).toEqual([]);
    expect(anchorsOf('O=Cc1ccccc1').map((a) => a.label)).toEqual(['Cc1ccccc1']);
  });

  it('環に直接ついた置換基が置き換わる反応（Ar-OH → Ar-F、Sandmeyer の Ar-NH2 → Ar-Cl）には出さない', () => {
    expect(missingAnchors('Oc1ccccc1', ['Fc1ccccc1'])).toEqual([]);
    expect(missingAnchors('Nc1ccccc1', ['Clc1ccccc1'])).toEqual([]);
  });

  it('環が生成物に無いとき（保護基の脱離・環の拡大）は、取り違えかどうか決められないので出さない', () => {
    expect(missingAnchors('O=C(OCc1ccccc1)N1CCCCC1', ['C1CCNCC1'])).toEqual([]);
  });

  it.each(CASES.filter((c) => c.expect.kind === 'scheme').map((c) => c.id))('評価の正解 %s には出さない（転位・環化も）', (id) => {
    const c = CASES.find((x) => x.id === id)!;
    const checked = checkPlan(planFromExpect(c), existingFor(c));
    expect(checked.issues.filter((i) => i.kind === 'skeleton')).toEqual([]);
  });

  it('checkPlan: 取り違えたときは、生成物を指して段の番号つきで知らせる', () => {
    const checked = checkPlan(
      {
        compounds: [
          { ref: 'A', name: 'ベンジルアジド', smiles: azide },
          { ref: 'B', smiles: 'C#Cc1ccccc1' },
          { ref: 'C', smiles: 'c1ccc(Cc2cn(c3ccccc3)nn2)cc1' },
        ],
        steps: [{ from: ['A', 'B'], to: ['C'] }],
      },
      [],
    );
    expect(checked.issues).toEqual([{ kind: 'skeleton', ref: 'C', stepIndex: 0, message: expect.stringContaining('基質 ベンジルアジド の「NCc1ccccc1」のつながりが、生成物に見当たりません') }]);
  });
});

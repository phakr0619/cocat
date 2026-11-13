// 枠（仮の化合物）を、描いた分子で埋める
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { addSmiles } from '../src/io/smiles';
import { checkPlan, confirmDraft, draftScheme } from '../src/llm/textToScheme';
import { isPlaceholder, replaceCompound } from '../src/scheme/ops';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

describe('枠を描いた分子で埋める', () => {
  it('枠の構造を選んだ分子にし、その分子はスキームに入る。枠でない化合物かは原子 1 つの「*」で見分ける', () => {
    const checked = checkPlan({ compounds: [{ ref: 'A', smiles: 'CCO' }, { ref: 'B', name: '生成物 1' }], steps: [{ from: ['A'], to: ['B'] }] }, []);
    const made = draftScheme(emptyDoc(), checked, { text: '', model: '', origin: { x: 0, y: 0 } });
    let doc = confirmDraft(made.doc, made.schemeId);
    const [sub, prod] = [doc.schemes![made.schemeId].steps[0].from[0], doc.schemes![made.schemeId].steps[0].to[0]];
    expect(isPlaceholder(doc.compounds![prod].structure)).toBe(true);
    expect(isPlaceholder(doc.compounds![sub].structure)).toBe(false);
    const drawn = addSmiles(doc, 'CC=O', { x: 500, y: 500 });
    doc = replaceCompound(drawn.doc, prod, drawn.atomIds);
    expect(isPlaceholder(doc.compounds![prod].structure)).toBe(false);
    expect(Object.values(doc.compounds![prod].structure.atoms).map((a) => a.element).sort()).toEqual(['C', 'C', 'O']);
    // 描いた分子は消え、スキームの中に描き直される
    expect(Object.values(doc.atoms).filter((a) => !a.ref)).toHaveLength(0);
    expect(Object.values(doc.atoms).filter((a) => a.ref === `${made.schemeId}:${prod}`)).toHaveLength(3);
  });
});

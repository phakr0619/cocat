import { beforeAll, describe, expect, it } from 'vitest';
import { checkStructNameShape, nameLocally, structNamePrompt, structureToName } from '../src/llm/structureToName';
import type { LlmProvider, LlmResult } from '../src/llm/types';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** 答えを順に返す偽の LLM。送られた本文を残す */
function fake(answers: unknown[]): LlmProvider & { sent: string[] } {
  const queue = [...answers];
  const sent: string[] = [];
  return {
    id: 'gemini',
    sent,
    generateJson: async <T,>(req: { user: string }): Promise<LlmResult<T>> => {
      sent.push(req.user);
      return { ok: true, value: queue.shift() as T, usage: { input: 10, output: 5 } };
    },
    listModels: async () => ({ ok: true, value: [] }),
  };
}

describe('構造 → 名前', () => {
  it('手元の辞書にある構造は、送らずに名前を出す（描き方が違っても同じ構造なら）', () => {
    expect(nameLocally('CC(=O)Oc1ccccc1C(=O)O')[0]).toBe('aspirin');
    expect(nameLocally('OC(=O)c1ccccc1OC(C)=O')[0]).toBe('aspirin');
    expect(nameLocally('CC1=CC=CC=C1C')).toEqual([]);
  });

  it('送るのは SMILES だけ。名前から構造に戻して、同じなら確かめ済み（呼び出しは 2 回、料金は足し合わせる）', async () => {
    const llm = fake([{ name: '(2S)-2-aminopropanoic acid' }, { smiles: 'C[C@H](N)C(=O)O', formula: 'C3H7NO2' }]);
    const r = await structureToName(llm, { smiles: 'N[C@@H](C)C(=O)O' });
    expect(r).toMatchObject({ ok: true, name: '(2S)-2-aminopropanoic acid', verified: true, warnings: [], usage: { input: 20, output: 10 } });
    expect(llm.sent[0]).toBe(structNamePrompt('N[C@@H](C)C(=O)O'));
    expect(llm.sent[1]).toBe('NAME: (2S)-2-aminopropanoic acid');
  });

  it('戻した構造の立体だけが違えば、名前の R/S を確かめるよう言う。構造が違えば、組成式を並べて言う', async () => {
    const st = await structureToName(fake([{ name: '(2R)-2-aminopropanoic acid' }, { smiles: 'C[C@@H](N)C(=O)O', formula: 'C3H7NO2' }]), { smiles: 'N[C@@H](C)C(=O)O' });
    expect(st).toMatchObject({ ok: true, verified: false });
    if (st.ok) expect(st.warnings[0]).toContain('立体が元と違います');
    const other = await structureToName(fake([{ name: 'butanoic acid' }, { smiles: 'CCCC(=O)O', formula: 'C4H8O2' }]), { smiles: 'CCC(=O)O' });
    if (other.ok) expect(other.warnings[0]).toBe('名前から戻した構造（C4H8O2）が元（C3H6O2）と違います。名前を確かめてください');
  });

  it('名前から戻せなければ、確かめられなかったと言う。名前の無い答えは形の崩れとして直させる', async () => {
    const r = await structureToName(fake([{ name: 'unknownane' }, { note: '知らない名前です' }]), { smiles: 'CCC' });
    expect(r).toMatchObject({ ok: true, verified: false });
    if (r.ok) expect(r.warnings[0]).toContain('確かめられませんでした');
    expect(checkStructNameShape({})).toEqual({ error: '"name" is required' });
    // 1 回目に名前が無ければ 1 回だけ直させる
    const llm = fake([{}, { name: 'propane' }, { smiles: 'CCC', formula: 'C3H8' }]);
    const r2 = await structureToName(llm, { smiles: 'CCC' });
    expect(r2).toMatchObject({ ok: true, name: 'propane', verified: true });
    expect(llm.sent[1]).toContain('Your previous answer could not be used');
  });
});

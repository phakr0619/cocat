// 名前 → 構造の OPSIN（このサイトのサーバー）と、構造 → 名前の確かめ
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { opsinName, parseOpsinAnswers, setOpsinClient } from '../src/chem/opsin';
import { structureToName } from '../src/llm/structureToName';
import type { LlmProvider, LlmResult } from '../src/llm/types';
import { inchikeyOf } from '../src/llm/structureToName';
import cases from './llm-eval/name-cases.json';
import { hasOpsinJar, javaOpsin } from './javaOpsin';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);
afterEach(() => setOpsinClient(null));

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

describe('OPSIN の答え', () => {
  it('形を確かめる（数が違う・状態が無い答えは使わない）。FAILURE の SMILES は捨てる', () => {
    expect(parseOpsinAnswers({ results: [{ status: 'SUCCESS', smiles: 'CCO' }, { status: 'FAILURE', smiles: 'X', message: 'bad' }] }, 2)).toEqual([
      { status: 'SUCCESS', smiles: 'CCO' },
      { status: 'FAILURE', message: 'bad' },
    ]);
    expect(parseOpsinAnswers({ results: [{ status: 'SUCCESS' }] }, 2)).toBeNull();
    expect(parseOpsinAnswers({ results: [{ smiles: 'C' }] }, 1)).toBeNull();
    expect(parseOpsinAnswers(null, 1)).toBeNull();
  });

  it('WARNING は構造を使い、注意を添える。届かなければ null', async () => {
    setOpsinClient(async () => [{ status: 'WARNING', smiles: 'CC(O)CC', message: 'stereo ignored' }]);
    expect(await opsinName('(R)-butan-2-ol')).toEqual({ smiles: 'CC(O)CC', warning: 'OPSIN の注意: stereo ignored' });
    setOpsinClient(async () => null);
    expect(await opsinName('butan-2-ol')).toBeNull();
  });
});

describe('構造 → 名前の確かめ', () => {
  it('名前を OPSIN で戻せれば、LLM は 1 回だけ（規則で確かめ済み）', async () => {
    const llm = fake([{ name: '(2S)-2-aminopropanoic acid' }]);
    const sentToOpsin: string[] = [];
    const r = await structureToName(llm, {
      smiles: 'N[C@@H](C)C(=O)O',
      opsin: async (n) => (sentToOpsin.push(n), { smiles: 'C[C@H](N)C(=O)O' }),
    });
    expect(r).toMatchObject({ ok: true, verified: true, checkedBy: 'opsin', usage: { input: 10, output: 5 } });
    expect(llm.sent).toHaveLength(1);
    expect(sentToOpsin).toEqual(['(2S)-2-aminopropanoic acid']);
  });

  it('OPSIN の戻した構造が違えば要確認', async () => {
    const r = await structureToName(fake([{ name: '(2R)-2-aminopropanoic acid' }]), { smiles: 'N[C@@H](C)C(=O)O', opsin: async () => ({ smiles: 'C[C@@H](N)C(=O)O' }) });
    expect(r).toMatchObject({ ok: true, verified: false, checkedBy: 'opsin' });
    if (r.ok) expect(r.warnings[0]).toContain('立体が元と違います');
  });

  it('OPSIN で読めない名前（慣用名など）か、OPSIN に届かなければ、LLM で戻す', async () => {
    const llm = fake([{ name: 'alanine' }, { smiles: 'CC(N)C(=O)O', formula: 'C3H7NO2' }]);
    const r = await structureToName(llm, { smiles: 'CC(N)C(=O)O', opsin: async () => null });
    expect(r).toMatchObject({ ok: true, verified: true, checkedBy: 'llm' });
    expect(llm.sent).toHaveLength(2);
  });
});

describe.skipIf(!hasOpsinJar())('手元の OPSIN（server/opsin の jar）', () => {
  it('評価の件の名前は、OPSIN でその構造になる', async () => {
    const list = cases.cases;
    const res = await javaOpsin(list.map((c) => c.name));
    expect(res).not.toBeNull();
    list.forEach((c, i) => {
      expect(res![i].status, c.name).toBe('SUCCESS');
      expect(inchikeyOf(res![i].smiles!), c.name).toBe(inchikeyOf(c.smiles));
    });
  });

  it('名前でないものは FAILURE で、理由を返す', async () => {
    const [r] = (await javaOpsin(['not a chemical name']))!;
    expect(r.status).toBe('FAILURE');
    expect(r.message).toContain('not a chemical name');
  });
});

// 本物の Gemini の答えを記録したもの（npm run eval:llm を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる。
// 確かめや指示を直したときに、前は正しかった件が崩れていないかが分かる
import { beforeAll, describe, expect, it } from 'vitest';
import { textToScheme } from '../../src/llm/textToScheme';
import { loadRDKit } from '../rdkit';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';
import { CASES, existingFor, scoreCase } from './score';

beforeAll(loadRDKit);

const files = recordedFiles('tests/llm-eval/recorded');

describe.skipIf(!files.length)('記録した本物の答えの採点が変わらない', () => {
  it.each(files)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = CASES.find((x) => x.id === id);
      if (!c) return undefined;
      return scoreCase(c, await textToScheme(replayLlm(answers), { text: c.text, existing: existingFor(c) })).outcome;
    });
    expect(changed).toEqual([]);
  });
});

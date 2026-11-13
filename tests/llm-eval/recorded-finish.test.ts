// 本物の Gemini の仕上げの答えを記録したもの（npm run eval:llm-finish を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる
import { beforeAll, describe, expect, it } from 'vitest';
import { finishSchemes } from '../../src/llm/finish';
import { loadRDKit } from '../rdkit';
import { FINISH_CASES, finishBase, scoreFinish } from './finish-score';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';

beforeAll(loadRDKit);

const files = recordedFiles('tests/llm-eval/recorded-finish');

describe.skipIf(!files.length)('記録した本物の仕上げの答えの採点が変わらない', () => {
  it.each(files)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = FINISH_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      const base = finishBase(c);
      const r = await finishSchemes(replayLlm(answers), { doc: base.doc, schemeIds: base.targets, text: c.text });
      return scoreFinish(c, base, r).outcome;
    });
    expect(changed).toEqual([]);
  });
});

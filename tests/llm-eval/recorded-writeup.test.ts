// 本物の Gemini の書く答えを記録したもの（npm run eval:llm-writeup を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる
import { beforeAll, describe, expect, it } from 'vitest';
import { writeUp } from '../../src/llm/writeUp';
import { loadRDKit } from '../rdkit';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';
import { scoreWriteUp, WRITEUP_CASES, writeUpBase } from './writeup-score';

beforeAll(loadRDKit);

const files = recordedFiles('tests/llm-eval/recorded-writeup');

describe('記録の流し直し', () => {
  it('記録の形の答えを流し直せる', async () => {
    const c = WRITEUP_CASES[0];
    const { doc, schemeId } = writeUpBase(c);
    const r = await writeUp(replayLlm([{ text: '{{C1}}' }]), { doc, schemeId, text: c.text, language: c.language });
    expect(r.ok).toBe(true);
    expect(scoreWriteUp(c, r).outcome).toBe('flagged');
  });
});

describe.skipIf(!files.length)('記録した本物の書く答えの採点が変わらない', () => {
  it.each(files)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = WRITEUP_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      const { doc, schemeId } = writeUpBase(c);
      return scoreWriteUp(c, await writeUp(replayLlm(answers), { doc, schemeId, text: c.text, language: c.language })).outcome;
    });
    expect(changed).toEqual([]);
  });
});

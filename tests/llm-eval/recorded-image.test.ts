// 本物の Gemini の、画像からスキームの答えを記録したもの（npm run eval:llm-image を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる
import { beforeAll, describe, expect, it } from 'vitest';
import { textToScheme } from '../../src/llm/textToScheme';
import { loadRDKit } from '../rdkit';
import { IMAGE_CASES, imageInput } from './image-cases';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';
import { planFromExpect, scoreCase } from './score';

beforeAll(loadRDKit);

const files = recordedFiles('tests/llm-eval/recorded-image');

describe('画像の評価の件', () => {
  // 正解は、PDF の評価の件（pdf-cases.ts）もこの 20 件と同じものを使う。正解の採点はここで一度だけ確かめる
  it(`画像があり、正解をそのまま答えれば正しいと採点する（${IMAGE_CASES.length} 件）`, async () => {
    const wrong: string[] = [];
    for (const c of IMAGE_CASES) {
      const input = imageInput(c);
      expect(input.summary, c.id).toMatch(/^IMAGE: .+（image\/png、\d+×\d+ px、\d+ KB）$/);
      expect(input.summary, c.id).toContain(c.file);
      const seen: unknown[] = [];
      const r = await textToScheme(replayLlm([planFromExpect(c)], seen), { text: '', existing: [], image: input });
      expect(seen, c.id).toEqual([input.images]);
      const outcome = scoreCase(c, r).outcome;
      if (outcome !== 'correct') wrong.push(`${c.id}: ${outcome}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe.skipIf(!files.length)('記録した本物の答えの採点が変わらない（画像）', () => {
  it.each(files)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = IMAGE_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      return scoreCase(c, await textToScheme(replayLlm(answers), { text: '', existing: [], image: imageInput(c) })).outcome;
    });
    expect(changed).toEqual([]);
  });
});

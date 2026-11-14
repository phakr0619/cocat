// 本物の Gemini の答えを記録したもの（npm run eval:llm-run・eval:llm-writeup-run を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる
import { beforeAll, describe, expect, it } from 'vitest';
import { textToRun } from '../../src/llm/textToRun';
import { writeUp } from '../../src/llm/writeUp';
import { loadRDKit } from '../rdkit';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';
import { RUN_CASES, runDocFor, scoreRun } from './run-score';
import { scoreWriteUpRun, WRITEUP_RUN_CASES, writeUpRunDoc } from './writeup-run-score';

beforeAll(loadRDKit);

const runFiles = recordedFiles('tests/llm-eval/recorded-run');
const writeFiles = recordedFiles('tests/llm-eval/recorded-writeup-run');

describe.skipIf(!runFiles.length)('記録した本物の答え（メモ → 実験の記録の下書き）の採点が変わらない', () => {
  it.each(runFiles)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = RUN_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      const { doc, runId } = runDocFor(c);
      return scoreRun(c, await textToRun(replayLlm(answers), { doc, runId, memo: c.memo })).outcome;
    });
    expect(changed).toEqual([]);
  });
});

describe.skipIf(!writeFiles.length)('記録した本物の答え（実験の記録を使った実験項）の採点が変わらない', () => {
  it.each(writeFiles)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = WRITEUP_RUN_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      const { doc, schemeId } = writeUpRunDoc();
      return scoreWriteUpRun(c, await writeUp(replayLlm(answers), { doc, schemeId, text: c.text, language: c.language, useRuns: true })).outcome;
    });
    expect(changed).toEqual([]);
  });
});

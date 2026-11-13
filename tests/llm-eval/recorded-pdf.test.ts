// 本物の Gemini の、PDF からスキームの答えを記録したもの（npm run eval:llm-pdf を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる
import { beforeAll, describe, expect, it } from 'vitest';
import { textToScheme } from '../../src/llm/textToScheme';
import { loadRDKit } from '../rdkit';
import { hasPdfImage, PDF_CASES, PDF_SENDS, pdfReplayInput } from './pdf-cases';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';
import { planFromExpect, scoreCase, type Outcome } from './score';

beforeAll(loadRDKit);

const files = recordedFiles('tests/llm-eval/recorded-pdf');

describe('PDF の評価の件', () => {
  it('図の範囲の PNG はリポジトリにある（ページ全体の PNG は MAKE_EVAL_PDFS=pages で作る）', () => {
    expect(PDF_CASES.filter((c) => c.send === 'crop' && !hasPdfImage(c)).map((c) => c.png)).toEqual([]);
  });
  it(`どの件も、画像の説明に PDF の名前と大きさが入る（${PDF_CASES.length} 件）`, () => {
    for (const c of PDF_CASES) {
      const input = pdfReplayInput(c);
      expect(input.summary, c.id).toMatch(/^IMAGE: .+（image\/png、\d+×\d+ px、\d+ KB）$/);
      expect(input.summary, c.id).toContain(c.name);
    }
  });
  // 正解は画像の件と同じなので、正解の採点は recorded-image.test.ts で一度だけ確かめる。ここでは送り方（page・crop・auto）ごとに 1 件、画像がそのまま送られて正しいと採点されるかだけ見る
  it.each(PDF_SENDS)('%s: 画像をそのまま送り、正解をそのまま答えれば正しいと採点する', async (send) => {
    const c = PDF_CASES.find((x) => x.send === send)!;
    const input = pdfReplayInput(c);
    const seen: unknown[] = [];
    const r = await textToScheme(replayLlm([planFromExpect(c)], seen), { text: '', existing: [], image: input });
    expect(seen).toEqual([input.images]);
    expect(scoreCase(c, r).outcome).toBe('correct');
  });
});

describe.skipIf(!files.length)('記録した本物の答えの採点が変わらない（PDF）', () => {
  it.each(files)('$file', async (rec) => {
    // 採点は画像の件と答えだけで決まる（画像の中身は使わない）。同じ画像の件に同じ答えが返った件は、一度だけ採点する
    const done = new Map<string, Outcome>();
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = PDF_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      const key = `${c.imageId}\n${JSON.stringify(answers)}`;
      if (!done.has(key)) done.set(key, scoreCase(c, await textToScheme(replayLlm(answers), { text: '', existing: [], image: pdfReplayInput(c) })).outcome);
      return done.get(key);
    });
    expect(changed).toEqual([]);
  });
});

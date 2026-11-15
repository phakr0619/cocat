// 本物の Gemini で、実験の記録を使った実験項の評価を回すとき（npm run eval:llm-writeup-run）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/writeup-run.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

// 本物の Gemini で、メモから実験の記録の評価を回すとき（npm run eval:llm-run）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/run.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

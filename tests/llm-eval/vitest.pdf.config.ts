// 本物の Gemini で PDF からスキームの評価を回すとき（npm run eval:llm-pdf）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/pdf.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

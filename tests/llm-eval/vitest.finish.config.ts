// 本物の Gemini で仕上げの評価を回すとき（npm run eval:llm-finish）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/finish.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

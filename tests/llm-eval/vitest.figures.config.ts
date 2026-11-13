// 本物の Gemini で図の位置を見つける評価を回すとき（npm run eval:llm-figures）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/figures.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

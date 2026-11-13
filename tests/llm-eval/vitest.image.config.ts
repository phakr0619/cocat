// 本物の Gemini で画像からスキームの評価を回すとき（npm run eval:llm-image）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/image.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

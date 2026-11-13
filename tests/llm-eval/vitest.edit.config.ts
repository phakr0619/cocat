// 本物の Gemini で編集の評価を回すとき（npm run eval:llm-edit）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/edit.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

// 本物の Gemini で書く評価を回すとき（npm run eval:llm-writeup）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/writeup.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

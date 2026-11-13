// 本物の Gemini で、実際の論文の M6 段3 の流れを通すとき（npm run eval:llm-real）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/real-papers.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

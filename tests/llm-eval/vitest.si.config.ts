// 本物の Gemini で、作った SI で M6 段3 の②を確かめるとき（npm run eval:llm-si）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/si.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

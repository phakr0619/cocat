// 本物の Gemini で構造 → 名前の評価を回すとき（npm run eval:llm-name）だけの設定。ふだんの npm test には入らない
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/llm-eval/name.eval.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});

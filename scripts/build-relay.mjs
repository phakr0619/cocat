// Bedrock の中継（server/ai-relay）を 1 つのファイルにまとめる。AWS SDK は Lambda の Node の環境にあるので入れない
import { build } from 'rolldown';

await build({
  input: 'server/ai-relay/src/index.ts',
  platform: 'node',
  external: ['@aws-sdk/client-bedrock-runtime'],
  output: { file: 'server/ai-relay/dist/index.mjs', format: 'esm', minify: false },
});
console.log('server/ai-relay/dist/index.mjs');

/// <reference types="vitest/config" />
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * pdf.js の静的ファイル（文字の対応表・標準のフォント・画像の復号の wasm）を /pdfjs/ で配る。
 * 中身はリポジトリに写さず、node_modules/pdfjs-dist から、dev では要求のたびに返し、build では dist/pdfjs/ に写す。
 * PDF を開いたときにだけ取りに行く。使わない quickjs（PDF の中の JavaScript）は配らない
 */
function pdfjsAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  /** [配る名前, 元の場所] */
  const dirs: [string, string][] = [
    ['cmaps', 'cmaps'],
    ['standard_fonts', 'standard_fonts'],
  ];
  const wasmFiles = ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2', 'LICENSE_QCMS', 'LICENSE_PDFJS_QCMS'];
  const type = (p: string) => (p.endsWith('.wasm') ? 'application/wasm' : p.endsWith('.pfb') || p.endsWith('.bcmap') ? 'application/octet-stream' : 'text/plain');
  /** /pdfjs/ の下の名前から、元のファイルの場所（配らないものは null） */
  const resolveAsset = (rel: string): string | null => {
    const p = normalize(rel);
    if (p.startsWith('..') || p.includes(`..${sep}`)) return null;
    const [head, ...rest] = p.split(sep);
    if (head === 'wasm' && rest.length === 1 && wasmFiles.includes(rest[0])) return join(root, 'wasm', rest[0]);
    const d = dirs.find(([n]) => n === head);
    if (d && rest.length) return join(root, d[1], ...rest);
    return null;
  };
  return {
    name: 'ai-chem-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const file = resolveAsset(rel);
        if (!file || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', type(file));
        res.end(readFileSync(file));
      });
    },
    writeBundle(options) {
      const out = join(options.dir ?? 'dist', 'pdfjs');
      for (const [n, s] of dirs) cpSync(join(root, s), join(out, n), { recursive: true });
      cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
      mkdirSync(join(out, 'wasm'), { recursive: true });
      for (const f of wasmFiles) cpSync(join(root, 'wasm', f), join(out, 'wasm', f));
    },
  };
}

/**
 * 手元の画面（npm run dev）から、立てたサイトの /api/*（OPSIN・AI の中継）を使うときだけ、COCAT_API_PROXY にサイトの URL を入れる。
 * 例: COCAT_API_PROXY=https://xxxx.cloudfront.net npm run dev
 */
const apiProxy = process.env.COCAT_API_PROXY;

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: apiProxy ? { proxy: { '/api': { target: apiProxy, changeOrigin: true } } } : undefined,
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});

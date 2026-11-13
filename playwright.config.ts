import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// クラウドの作業環境では、入っている Chromium（/opt/pw-browsers）を使う。版が合わず playwright install を求められるため
const cloudChromium = '/opt/pw-browsers/chromium';

// PW_PORT で番号を変えられる。ほかの worktree が 5199 番でサーバーを動かしていると、reuseExistingServer でそちらの古いコードを試してしまうため
const port = Number(process.env.PW_PORT ?? 5199);

// E2E は本番用にビルドしたもの（vite build → vite preview）で動かす。開発用のサーバーより速く（部品をまとめてあり、React の開発用の確かめも無い）、
// 利用者が使うものと同じものを試せる。ビルドは毎回し直す（3 秒ほど）ので、古いビルドを試すことはない。dist-e2e/ に出し、配布用の dist/ とは分ける。
// 評価のデータを作る道具（MAKE_EVAL_PDFS・MAKE_EVAL_IMAGES）はブラウザの中でソース（/src/...）を直接読むので、開発用のサーバーで動かす。PW_DEV=1 でも開発用にできる
const dev = !!(process.env.PW_DEV || process.env.MAKE_EVAL_PDFS || process.env.MAKE_EVAL_IMAGES);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // 時間の大半はブラウザの中の処理（CPU）なので、CPU の数だけ並べる（既定は半分）。CI（4 コア）では 2 並列から 4 並列になる
  workers: '100%',
  use: {
    baseURL: `http://localhost:${port}`,
    // ライブラリの列（250px）を開いた状態でも、キャンバスに 1000px ほど残る幅
    viewport: { width: 1650, height: 900 },
    launchOptions: {
      ...(existsSync(cloudChromium) ? { executablePath: cloudChromium } : {}),
      // 文字コードの決まり（locale）が UTF-8 でない所では、Chromium が日本語のファイル名を「download」にしてしまう。
      // 書き出しのファイル名の E2E のため、いつも UTF-8 で動かす（手元の Windows・Mac の Chrome では起きない）
      env: { ...process.env, LC_ALL: 'C.UTF-8' },
      // RDKit の wasm（7 MB）を、ページを開くたびに最適化までせず、速い変換（Liftoff）だけで動かす。テストはページを開き直すことが多く、
      // 最適化の手間の方が大きい。全体で 15% ほど速くなる（2026-11 に測った）。利用者のブラウザには関係ない
      args: ['--js-flags=--liftoff-only'],
    },
  },
  webServer: dev
    ? { command: `npx vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: true, timeout: 60_000 }
    : {
        command: `npx vite build --outDir dist-e2e --emptyOutDir --logLevel warn && npx vite preview --outDir dist-e2e --port ${port} --strictPort`,
        url: `http://localhost:${port}`,
        // 動いているサーバーを使い回すと、古いビルドを試してしまう
        reuseExistingServer: false,
        timeout: 120_000,
      },
});

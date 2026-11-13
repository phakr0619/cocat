// 画像からスキームの評価の画像を作る。ふだんのテストでは飛ばす
//
//   PowerShell:  $env:MAKE_EVAL_IMAGES = "1"; npx playwright test e2e/make-eval-images.spec.ts
//
// 画像はすべて、このアプリで描いたスキームを PNG に書き出したもの（論文・出版社の図は使わない）。
// 正解（cases.json）の構造と条件からスキームを作り、件ごとの書式・解像度・番号の有無で描いて tests/llm-eval/images/ に書く
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { buildPlan, drawScheme, loadEvalCases, openApp } from './eval-scheme';

const DIR = 'tests/llm-eval/images';
/** アプリが送る前に縮める長辺（src/llm/image.ts の MAX_IMAGE_SIDE）。評価では縮めずに送るので、これを超えないように描く */
const MAX_SIDE = 2048;

test.skip(!process.env.MAKE_EVAL_IMAGES, 'MAKE_EVAL_IMAGES=1 のときだけ作る');

test('評価の画像を作る', async ({ page }) => {
  test.setTimeout(180_000);
  const { cases, bases } = loadEvalCases();
  mkdirSync(DIR, { recursive: true });
  await openApp(page);

  for (const c of cases) {
    const plan = buildPlan(c, bases.find((b) => b.id === c.base)!.expect.steps!);
    const b64 = await drawScheme(page, { plan, style: c.style, dpi: c.dpi, maxSide: MAX_SIDE, format: 'png' });
    // 正解の構造は RDKit で読めるはずなので、要確認は無い
    expect(b64.issues, c.id).toEqual([]);
    writeFileSync(`${DIR}/${c.id}.png`, Buffer.from(b64.data, 'base64'));
  }
});

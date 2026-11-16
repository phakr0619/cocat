import { expect, test, type Page, type Route } from '@playwright/test';
import { openLlmSettings } from './helpers';

// この組織の AI の中継（/api/ai）は呼ばず、page.route で偽の応答を返す
const API = '**/api/ai';
const HAIKU = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';

const amide = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 }],
  questions: [] as string[],
};

/** 中継がある（GET が一覧を返す）サイト。POST の本文と添えられたハッシュを集める */
async function fakeRelay(page: Page, answer: unknown) {
  const posts: { body: string; hash: string }[] = [];
  await page.route(API, async (route: Route) => {
    const r = route.request();
    if (r.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'bedrock', region: 'ap-northeast-1', models: [HAIKU, 'jp.anthropic.claude-sonnet-4-6'] }) });
    posts.push({ body: r.postData() ?? '', hash: r.headers()['x-amz-content-sha256'] ?? '' });
    // 本物の中継は、空白を送って接続を保ったあと、LlmResult の JSON を 1 つ返す
    await route.fulfill({ status: 200, contentType: 'application/json', body: `   ${JSON.stringify({ ok: true, value: answer, usage: { input: 100, output: 20 } })}` });
  });
  return posts;
}

test('中継があるサイトでは、はじめての人に中継が選ばれ、キーの欄は出ない', async ({ page }) => {
  const posts = await fakeRelay(page, { ok: true });
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  await expect(dlg.getByTestId('llm-provider')).toHaveValue('relay');
  await expect(dlg.getByTestId('llm-provider').locator('option')).toHaveText(['Google（Gemini）', 'AWS（Amazon Bedrock）', 'この組織の AI（Amazon Bedrock・中継）']);
  await expect(dlg.getByTestId('llm-key')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-remember')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-forget')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-region')).toContainText('ap-northeast-1');
  await expect(dlg.getByTestId('llm-model')).toHaveValue(HAIKU);
  await expect(dlg.getByTestId('llm-model').locator('option')).toHaveText(['Claude Haiku 4.5（速い・安い）', 'Claude Sonnet 4.6（より賢い）']);
  await expect(dlg.getByTestId('llm-test-note')).toContainText('料金は 1 円未満');
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toHaveText('つながりました');
  expect(posts).toHaveLength(1);
  const sent = JSON.parse(posts[0].body);
  expect(sent.model).toBe(HAIKU);
  expect(posts[0].hash).toMatch(/^[0-9a-f]{64}$/);
  // 自分のキーに切り替えられる
  await dlg.getByTestId('llm-provider').selectOption('gemini');
  await expect(dlg.getByTestId('llm-key')).toBeVisible();
});

test('中継で文章から下書きを作る: キー無しで使え、同意の送り先も中継', async ({ page }) => {
  const posts = await fakeRelay(page, amide);
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  // 設定を開かずに、そのまま AI の欄が開く
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid=open-ai]') !== null)).toBe(true);
  await page.getByTestId('open-ai').click();
  const panel = page.getByTestId('tts');
  await expect(panel.getByTestId('tts-text')).toBeVisible();
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent').getByRole('heading')).toHaveText('この組織の AI（Amazon Bedrock・中継）に送ります');
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0].body).user).toContain('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  await expect(page.getByTestId('smiles')).toContainText('>>');
  await expect(panel).toContainText('Claude Haiku 4.5（速い・安い）');
});

test('中継の失敗（大きすぎる）は、共通の文で出る', async ({ page }) => {
  await page.route(API, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'bedrock', region: 'ap-northeast-1', models: [HAIKU] }) })
      : route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { kind: 'too-large', message: 'x' } }) }),
  );
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  await expect(dlg.getByTestId('llm-provider')).toHaveValue('relay');
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toContainText('一度に送れる大きさを超えました');
});

test('中継が無いサイト（/api/ai が HTML）では、中継の選択肢が出ない', async ({ page }) => {
  let asked = 0;
  await page.route(API, (route) => {
    asked++;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>index</body></html>' });
  });
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await expect.poll(() => asked).toBeGreaterThan(0);
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  await expect(dlg.getByTestId('llm-provider')).toHaveValue('gemini');
  await expect(dlg.getByTestId('llm-provider').locator('option')).toHaveText(['Google（Gemini）', 'AWS（Amazon Bedrock）']);
  await expect(dlg.getByTestId('llm-key')).toBeVisible();
});

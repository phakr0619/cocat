import { expect, test, type Page } from '@playwright/test';
import { menuItem, openLlmSettings } from './helpers';

// Gemini の API は呼ばず、page.route で偽の応答を返す
const API = 'https://generativelanguage.googleapis.com/**';

async function open(page: Page, path = '/') {
  await page.goto(path);
  await page.getByTestId('canvas').waitFor();
}

test('AI の設定は ?llm を付けなくても出て、このツールについてに LLM のデータの扱いが出る', async ({ page }) => {
  await open(page);
  // AI の設定は、設定のメニューにある。キーが無いうちは、AI の欄と「AI で作る」は出さない
  await expect(page.getByTestId('tts')).toBeHidden();
  await expect(page.getByTestId('open-ai')).toHaveCount(0);
  await openLlmSettings(page);
  await expect(page.getByTestId('llm-settings')).toBeVisible();
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
  await menuItem(page, 'menu-help', 'このツールについて');
  await expect(page.getByTestId('about-llm')).toContainText('Google（Gemini）に送ります');
  await expect(page.getByTestId('about-pdf')).toContainText('図の範囲を探させるために、選んだページ全体の画像を送ることもあります');
  await expect(page.getByTestId('about-pdf')).toContainText('Google（Gemini）に送るのは、あなたが選んだ範囲を描いた画像です');
  await expect(page.getByTestId('about-pdf-text')).toContainText('本文・SI から補った条件も、元の論文と見比べてください');
  await expect(page.getByTestId('about').getByTestId('ai-notice')).toContainText('間違っていることがあります');
});

test('キーを入れて「つながるか試す」と、キーをヘッダーで送り、モデルの一覧を出す。覚えなければ開き直すと消える', async ({ page }) => {
  const keys: string[] = [];
  await page.route(API, async (route) => {
    keys.push(route.request().headers()['x-goog-api-key'] ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        models: [
          { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    });
  });
  await open(page);
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  await expect(dlg.getByTestId('llm-free-warning')).toBeVisible();
  await expect(dlg).toContainText('「言葉から作る」などの機能は');
  await expect(dlg.getByTestId('llm-free-limits')).toContainText('1 日に 10〜20 回ほど');
  await dlg.getByTestId('llm-key').fill('AIza-test-1');
  await dlg.getByTestId('llm-test').click();
  // 選べるのは決めた2つだけ。このキーの一覧に無いもの（Argon）は知らせる
  await expect(dlg.getByTestId('llm-check')).toContainText('つながりました。ただし、このキーでは Gemini 4 Argon（いちばん賢い） が一覧にありません');
  expect(keys).toEqual(['AIza-test-1']);
  await expect(dlg.getByTestId('llm-model').locator('option')).toHaveText([
    'Gemini 3.8 Flash（速い・安い）',
    'Gemini 4 Argon（いちばん賢い） ・有料のキーだけ',
  ]);
  await expect(dlg.getByTestId('llm-paid-only')).toHaveCount(0);
  await dlg.getByTestId('llm-model').selectOption('gemini-4-argon');
  await expect(dlg.getByTestId('llm-model')).toHaveValue('gemini-4-argon');
  await expect(dlg.getByTestId('llm-paid-only')).toBeVisible();

  // 有料のキーにすると、無料のキーの注意が消える
  await dlg.getByTestId('llm-paid').check();
  await expect(dlg.getByTestId('llm-free-warning')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-free-limits')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-paid-only')).toHaveCount(0);

  // 覚えていないので、開き直すとキーは消える（有料のチェックは残る）
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('AIza-test-1');
  await open(page);
  await openLlmSettings(page);
  await expect(dlg.getByTestId('llm-key')).toHaveValue('');
  await expect(dlg.getByTestId('llm-paid')).toBeChecked();
});

test('「次に開いたときも、このキーを使う」を選ぶと開き直しても残り、「キーを消す」で消える', async ({ page }) => {
  await open(page);
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  // 何もしなければブラウザに残らないことを先に言い、保存するときだけ保存の注意を出す
  await expect(dlg.getByTestId('llm-key-session')).toHaveText('キーは、このページを開いている間だけ使います。閉じるか読み込み直すと消えます。');
  await expect(dlg.getByTestId('llm-key-saved')).toHaveCount(0);
  await dlg.getByTestId('llm-key').fill('AIza-test-2');
  await dlg.getByTestId('llm-remember').check();
  await expect(dlg.getByTestId('llm-key-saved')).toContainText('暗号化せずにこのブラウザに保存されます');
  await open(page);
  await openLlmSettings(page);
  await expect(dlg.getByTestId('llm-key')).toHaveValue('AIza-test-2');
  await dlg.getByTestId('llm-forget').click();
  await expect(dlg.getByTestId('llm-key')).toHaveValue('');
  await expect(dlg.getByTestId('llm-remember')).not.toBeChecked();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('AIza-test-2');
});

test('キーが違うと、理由を言う', async ({ page }) => {
  await page.route(API, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }),
    }),
  );
  await open(page);
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toContainText('キーを入れてください');
  await dlg.getByTestId('llm-key').fill('wrong');
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toContainText('キーが違うか');
});

test('狭い画面でも、上のバーのボタンは横にはみ出さず、すべて見える', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  for (const id of ['menu-help', 'menu-settings', 'open-name']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.x + box!.width, id).toBeLessThanOrEqual(1280);
  }
  await openLlmSettings(page);
  await expect(page.getByTestId('llm-settings')).toBeVisible();
});

test('AI の設定・このツールについての画面は、横にスクロールせず、文が折り返す', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  for (const [button, dialog] of [['open-llm-settings', 'llm-settings'], ['open-about', 'about']]) {
    await page.getByTestId(button === 'open-about' ? 'menu-help' : 'menu-settings').click();
    await page.getByTestId(button).click();
    const d = page.getByTestId(dialog);
    await expect(d).toBeVisible();
    const { scrollWidth, clientWidth, scrollLeft } = await d.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft }));
    expect(scrollWidth, dialog).toBeLessThanOrEqual(clientWidth);
    expect(scrollLeft, dialog).toBe(0);
    await d.getByRole('button', { name: '閉じる' }).click();
    await expect(d).toBeHidden();
  }
});

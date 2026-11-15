import { expect, test, type Page, type Route } from '@playwright/test';
import { openAi, openLlmSettings } from './helpers';

// Bedrock の API は呼ばず、page.route で偽の Converse の応答を返す
const API = 'https://bedrock-runtime.ap-northeast-1.amazonaws.com/**';

const amide = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 }],
  questions: [] as string[],
};

const converse = (input: unknown) => ({
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'answer', input }}] } },
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20 },
});

async function fakeBedrock(page: Page, answer: unknown) {
  const calls: { url: string; auth: string; body: string }[] = [];
  await page.route(API, async (route: Route) => {
    const r = route.request();
    calls.push({ url: r.url(), auth: r.headers()['authorization'] ?? '', body: r.postData() ?? '' });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(converse(answer)) });
  });
  return calls;
}

async function useBedrock(page: Page, key = 'bedrock-test-key') {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await openLlmSettings(page);
  const dlg = page.getByTestId('llm-settings');
  await dlg.getByTestId('llm-provider').selectOption('bedrock');
  await dlg.getByTestId('llm-key').fill(key);
  return dlg;
}

test('会社を Bedrock にして、つながるか試すと、短い質問を 1 回送って成功が出る', async ({ page }) => {
  const calls = await fakeBedrock(page, { ok: true });
  const dlg = await useBedrock(page);
  // Bedrock の欄: リージョン・モデルの ID・費用の注意が出て、Gemini だけの欄は出ない
  await expect(dlg.getByTestId('llm-region')).toContainText('東京（ap-northeast-1）');
  await expect(dlg.getByTestId('llm-test-note')).toContainText('料金は 1 円未満です');
  await expect(dlg.getByTestId('llm-model')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-paid')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-thinking')).toHaveCount(0);
  await expect(dlg.getByTestId('llm-free-warning')).toHaveCount(0);
  // モデルは ID を入れる欄で、確かめたモデルを候補に出す。既定は Haiku 4.5
  await expect(dlg.getByTestId('llm-model-id')).toHaveValue('jp.anthropic.claude-haiku-4-5-20251001-v1:0');
  await expect(dlg.locator('#llm-model-list option')).toHaveCount(2);
  await expect(dlg.getByTestId('llm-model-note')).toContainText('Claude Sonnet 4.6');
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toHaveText('つながりました');
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/jp.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse');
  expect(calls[0].auth).toBe('Bearer bedrock-test-key');
  const sent = JSON.parse(calls[0].body);
  expect(sent.toolConfig.toolChoice).toEqual({ tool: { name: 'answer' } });

  // 候補に無いモデルの ID を入れると、それを使う。会社を戻しても、Bedrock の設定は残る
  await dlg.getByTestId('llm-model-id').fill('jp.anthropic.claude-sonnet-x');
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toHaveText('つながりました');
  expect(calls[1].url).toContain('/model/jp.anthropic.claude-sonnet-x/converse');
  await dlg.getByTestId('llm-provider').selectOption('gemini');
  await expect(dlg.getByTestId('llm-key')).toHaveValue('');
  await expect(dlg.getByTestId('llm-region')).toHaveCount(0);
  await dlg.getByTestId('llm-provider').selectOption('bedrock');
  await expect(dlg.getByTestId('llm-key')).toHaveValue('bedrock-test-key');
  await expect(dlg.getByTestId('llm-model-id')).toHaveValue('jp.anthropic.claude-sonnet-x');
});

test('Bedrock の失敗（モデルが無い）は、モデルを選び直す文で出る', async ({ page }) => {
  await page.route(API, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'x-amzn-errortype': 'ResourceNotFoundException' }, body: JSON.stringify({ message: 'no such model' }) }),
  );
  const dlg = await useBedrock(page);
  await dlg.getByTestId('llm-test').click();
  await expect(dlg.getByTestId('llm-check')).toContainText('このモデルは、見つからないか、このアカウントではまだ使えません');
});

test('Bedrock で文章から下書きを作る: 同意の送り先も Bedrock で、答えは toolUse の入力から読む', async ({ page }) => {
  const calls = await fakeBedrock(page, amide);
  const dlg = await useBedrock(page);
  await dlg.getByRole('button', { name: '閉じる' }).click();
  await openAi(page);
  const panel = page.getByTestId('tts');
  await expect(panel.getByTestId('tts-free-warning')).toHaveCount(0);
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent').getByRole('heading')).toHaveText('AWS（Amazon Bedrock）に送ります');
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(calls).toHaveLength(1);
  const sent = JSON.parse(calls[0].body);
  expect(sent.messages[0].content.at(-1).text).toContain('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  expect(sent.inferenceConfig.maxTokens).toBe(16000);
  await expect(page.getByTestId('smiles')).toContainText('>>');
  // 使ったモデルの名前を出す
  await expect(panel).toContainText('Claude Haiku 4.5（速い・安い）');
});

import { expect, test, type Page, type Route } from '@playwright/test';
import { importSmiles, showTab, openLlmSettings } from './helpers';

// 構造 → 名前（分析のタブ）。Gemini は呼ばず、page.route で決まった答えを順に返す
const API = 'https://generativelanguage.googleapis.com/**';

async function fakeGemini(page: Page, answers: unknown[]) {
  const bodies: string[] = [];
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '');
    const answer = answers.shift() ?? {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }),
    });
  });
  return bodies;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

test('辞書にある構造は、送らずに名前を出す。キーが無ければ AI の道は押せない', async ({ page }) => {
  const bodies = await fakeGemini(page, []);
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  await showTab(page, 'analysis');
  await expect(page.getByTestId('struct-name')).toContainText('aspirin');
  await importSmiles(page, 'CCCC(=O)OC');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('struct-name-ask').first()).toBeDisabled();
  expect(bodies).toEqual([]);
});

test('AI で名前を調べる: 名前を OPSIN（規則）で構造に戻して確かめる。Gemini は 1 回だけ', async ({ page }) => {
  const bodies = await fakeGemini(page, [{ name: 'methyl butanoate' }]);
  const opsin: string[] = [];
  await page.route('**/api/opsin', async (route: Route) => {
    opsin.push(route.request().postData() ?? '');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ status: 'SUCCESS', smiles: 'CCCC(=O)OC' }] }) });
  });
  await openLlmSettings(page);
  await page.getByTestId('llm-key').fill('AIza-test');
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
  await importSmiles(page, 'CCCC(=O)OC');
  await showTab(page, 'analysis');
  await page.getByTestId('struct-name-ask').click();
  await page.getByTestId('struct-name-send').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(page.getByTestId('struct-name-value')).toHaveText('methyl butanoate');
  await expect(page.getByTestId('struct-name-check')).toHaveText('確かめ済み（規則）');
  await expect(page.getByTestId('struct-name').getByTestId('ai-notice')).toContainText('名前を OPSIN の規則で構造に戻すと、元の構造と同じになった');
  await expect(page.getByTestId('struct-name').getByTestId('ai-notice')).toContainText('AI が付けた名前です');
  expect(bodies).toHaveLength(1);
  expect(opsin).toEqual(['methyl butanoate']);
});

test('AI で名前を調べる: OPSIN に届かなければ、送ることを知らせてから SMILES だけを送り、名前を AI で戻して確かめる', async ({ page }) => {
  const bodies = await fakeGemini(page, [{ name: 'methyl butanoate' }, { smiles: 'CCCC(=O)OC', formula: 'C5H10O2' }]);
  await page.route('**/api/opsin', (route: Route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<html></html>' }));
  await openLlmSettings(page);
  await page.getByTestId('llm-key').fill('AIza-test');
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
  await importSmiles(page, 'CCCC(=O)OC');
  await showTab(page, 'analysis');
  await page.getByTestId('struct-name-ask').click();
  await expect(page.getByTestId('struct-name')).toContainText('構造（SMILES）を Gemini に送ります');
  await page.getByTestId('struct-name-send').click();
  await expect(page.getByTestId('llm-consent-struct')).toBeVisible();
  await page.getByTestId('llm-consent-ok').click();
  await expect(page.getByTestId('struct-name-value')).toHaveText('methyl butanoate');
  await expect(page.getByTestId('struct-name-check')).toHaveText('確かめ済み（AI）');
  // AI の答えを AI で確かめただけ、と正しく言う
  await expect(page.getByTestId('struct-name').getByTestId('ai-notice')).toContainText('AI が付けた名前です');
  await expect(page.getByTestId('struct-name').getByTestId('ai-notice')).toContainText('AI の答えを AI で確かめたので');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain('SMILES: CCCC(=O)OC');
  expect(bodies[1]).toContain('NAME: methyl butanoate');
});

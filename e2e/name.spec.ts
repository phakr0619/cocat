import { expect, test, type Page, type Route } from '@playwright/test';

// 名前から置く（M5 の最初の段）。Gemini は呼ばず、page.route で決まった答えを返す
const API = 'https://generativelanguage.googleapis.com/**';
const atoms = (page: Page) => page.evaluate(() => Object.values(window.__editor!.get().doc.atoms).map((a) => a.element).sort().join(''));

/** 送られた本文を記録し、answer を返す */
async function fakeGemini(page: Page, answer: unknown) {
  const bodies: string[] = [];
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }),
    });
  });
  return bodies;
}

/** このサイトのサーバーの OPSIN（/api/opsin）の代わり。送られた本文とハッシュの見出しを記録し、answers を返す */
async function fakeOpsin(page: Page, answers: unknown[]) {
  const sent: { body: string; hash: string | undefined }[] = [];
  await page.route('**/api/opsin', async (route: Route) => {
    sent.push({ body: route.request().postData() ?? '', hash: route.request().headers()['x-amz-content-sha256'] });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: answers }) });
  });
  return sent;
}

async function open(page: Page) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await page.getByTestId('open-name').click();
}

async function setKey(page: Page) {
  await page.getByTestId('name-open-settings').click();
  await page.getByTestId('llm-key').fill('AIza-test');
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
}

test('辞書にある名前は、送らずに置く（Enter でも置ける）', async ({ page }) => {
  const bodies = await fakeGemini(page, {});
  await open(page);
  const panel = page.getByTestId('name-panel');
  await panel.getByTestId('name-input').fill('Ethyl acetate');
  await panel.getByTestId('name-place').click();
  await expect(panel.getByTestId('name-result')).toContainText('手元の辞書から置きました');
  expect(await atoms(page)).toBe('CCCCOO');
  await panel.getByTestId('name-input').fill('CC#N');
  await panel.getByTestId('name-input').press('Enter');
  await expect(panel.getByTestId('name-result')).toContainText('SMILES として読んで置きました');
  expect(await atoms(page)).toBe('CCCCCCNOO');
  expect(bodies).toEqual([]);
});

test('辞書に無い名前は、このサイトの OPSIN（規則）で読んで置く。Gemini には送らない', async ({ page }) => {
  const bodies = await fakeGemini(page, {});
  const sent = await fakeOpsin(page, [{ status: 'SUCCESS', smiles: 'CC(=O)CC(C)C' }]);
  await open(page);
  const panel = page.getByTestId('name-panel');
  await panel.getByTestId('name-input').fill('4-methylpentan-2-one');
  await panel.getByTestId('name-place').click();
  await expect(panel.getByTestId('name-result')).toContainText('名前を OPSIN の規則で読んで置きました');
  expect(await atoms(page)).toBe('CCCCCCO');
  expect(bodies).toEqual([]);
  // 送るのは名前だけ。CloudFront から Lambda へ署名して渡すため、本文の SHA-256 を添える
  expect(sent).toEqual([{ body: '4-methylpentan-2-one', hash: '8772a8df3a079e106895c669125cad77baaa6119df71722e571c44c90ad7ad57' }]);
});

test('OPSIN でも読めない名前は、キーが無ければ送らずに知らせる', async ({ page }) => {
  const bodies = await fakeGemini(page, {});
  await fakeOpsin(page, [{ status: 'FAILURE', message: 'unparsable' }]);
  await open(page);
  const panel = page.getByTestId('name-panel');
  await panel.getByTestId('name-input').fill('Tamiflu');
  await panel.getByTestId('name-place').click();
  await expect(panel.getByTestId('name-error')).toContainText('AI の設定で Gemini の API キーを入れると');
  expect(await atoms(page)).toBe('');
  expect(bodies).toEqual([]);
});

test('OPSIN で読めない名前は、同意してから名前だけを Gemini に送り、確かめて置く', async ({ page }) => {
  const bodies = await fakeGemini(page, { smiles: 'CC(=O)CC(C)C', formula: 'C6H12O' });
  await fakeOpsin(page, [{ status: 'FAILURE' }]);
  await open(page);
  await setKey(page);
  const panel = page.getByTestId('name-panel');
  await panel.getByTestId('name-input').fill('4-methylpentan-2-one');
  await panel.getByTestId('name-place').click();
  // 初めて送るときは同意を取る。名前だけを送ると書く
  const consent = page.getByTestId('llm-consent');
  await expect(consent.getByTestId('llm-consent-name')).toContainText('送るのは、入力した名前だけです');
  await consent.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('name-result')).toContainText('Gemini に書かせた構造です');
  // AI が書いた構造には、AI の注意が付く（辞書・規則で置いたものには付かない）
  await expect(panel.getByTestId('name-result').getByTestId('ai-notice')).toContainText('AI が名前から書いた構造です');
  await expect(panel.getByTestId('name-result').getByTestId('ai-notice')).toContainText('間違っていることがあるので、名前と見比べてから使ってください');
  await expect(panel.getByTestId('name-warnings')).toHaveCount(0);
  expect(await atoms(page)).toBe('CCCCCCO');
  expect(bodies).toHaveLength(1);
  const sent = JSON.parse(bodies[0]) as { contents: { parts: { text: string }[] }[] };
  expect(sent.contents.map((c) => c.parts.map((p) => p.text).join('')).join('')).toBe('NAME: 4-methylpentan-2-one');
});

test('Gemini の答えの組成式が構造と合わなければ、置いたうえで知らせる', async ({ page }) => {
  await fakeGemini(page, { smiles: 'CC(=O)CC(C)C', formula: 'C6H14O' });
  await open(page);
  await setKey(page);
  const panel = page.getByTestId('name-panel');
  await panel.getByTestId('name-input').fill('4-methylpentan-2-one');
  await panel.getByTestId('name-place').click();
  await page.getByTestId('llm-consent').getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('name-warnings')).toContainText('答えの組成式（C6H14O）と、SMILES の組成式（C6H12O）が違います');
});

test('CAS 番号は Gemini に送らず、形と検査数字だけを確かめて知らせる', async ({ page }) => {
  const bodies = await fakeGemini(page, { smiles: 'C=O', formula: 'CH2O' });
  await open(page);
  await setKey(page);
  const panel = page.getByTestId('name-panel');
  await panel.getByTestId('name-input').fill('50-00-1');
  await panel.getByTestId('name-place').click();
  await expect(panel.getByTestId('name-error')).toContainText('CAS 番号の検査数字が合いません。50-00-1 の最後の数字は 0 のはずです');
  await panel.getByTestId('name-input').fill('50-00-0');
  await panel.getByTestId('name-place').click();
  await expect(panel.getByTestId('name-error')).toContainText('CAS 番号 50-00-0 の形と検査数字は正しいです');
  await expect(page.getByTestId('llm-consent')).toHaveCount(0);
  expect(await atoms(page)).toBe('');
  expect(bodies).toEqual([]);
});

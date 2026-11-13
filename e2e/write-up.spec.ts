import { expect, test, type Page, type Route } from '@playwright/test';
import { showTab, openAi, setApiKey } from './helpers';

// スキームから文章と表を作る。Gemini は呼ばず、page.route で決まった答えを返す
const API = 'https://generativelanguage.googleapis.com/**';

const amide = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 }],
  questions: [] as string[],
};

const good = {
  text: 'To a solution of {{C1}} ({{s1.C1.mg}}, {{s1.C1.mmol}}) and {{C2}} ({{s1.C2.mmol}}, {{s1.C2.equiv}}) in {{s1.solvent}} were added {{s1.R1}} ({{s1.R1.mg}}, {{s1.R1.equiv}}) and {{s1.R2}} ({{s1.R2.uL}}, {{s1.R2.equiv}}). The mixture was stirred at {{s1.temp}} for {{s1.time}}. [[work-up]] gave {{C3}} ({{s1.C3.mg}}, {{s1.yield}}).',
  questions: [],
};

/** 送られた本文を記録し、answers を順に返す */
async function fakeGemini(page: Page, ...answers: unknown[]) {
  const bodies: string[] = [];
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '');
    const a = answers.length > 1 ? answers.shift() : answers[0];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] }, finishReason: 'STOP' }] }),
    });
  });
  return bodies;
}

/** キーを入れ、言葉からスキームを作って確定し、最初の基質の量を入れる */
async function schemeWithScale(page: Page, scale: string) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await panel.getByTestId('tts-confirm').click();
  await showTab(page, 'scheme');
  await page.getByTestId('scheme-panel').getByTestId('stoich').first().locator('summary').click();
  await page.getByTestId('stoich-scale').first().fill(scale);
  await showTab(page, 'ai');
  return panel;
}

test('書く: スキームが無ければ入口を出さない', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  await expect(panel).toBeVisible();
  // スキームが無いうちは、書くの入口（スキームの欄の「AI で」）を出さない
  await showTab(page, 'scheme');
  await expect(page.getByTestId('scheme-ai')).toHaveCount(0);
});

test('書く: 化学量論表は AI を呼ばずに作る。実験項は数字をアプリが差し込み、量を変えたら入れ直せる。コピーできる', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const bodies = await fakeGemini(page, amide, good);
  const panel = await schemeWithScale(page, '189.21');
  expect(bodies).toHaveLength(1);

  await openAi(page, 'write');
  await expect(panel.getByTestId('tts-text')).toHaveCount(0);
  await panel.getByTestId('tts-write-table').click();
  const table = panel.getByTestId('tts-write-table-out');
  await expect(table).toContainText('1 段目: Boc-Ala-OH + H-Gly-OMe → 3');
  await expect(table).toContainText('| 試薬 | HATU | 380.23 | 1.20 | 1.200 | 456.3 |');
  expect(bodies).toHaveLength(1);
  await panel.getByTestId('tts-write-copy-tsv').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('試薬\tHATU\t380.23');

  // ノート用の図も AI を呼ばずに作る
  await panel.getByTestId('tts-write-notebook').click();
  const notebook = panel.getByTestId('tts-write-notebook-out');
  await expect(notebook).toContainText('容器（DMF）');
  await expect(notebook).toContainText('｜← HATU  456.3 mg（1.20 mmol, 1.2 equiv）');
  await expect(notebook).toContainText('3  221.2 mg（0.85 mmol, 85%）');
  await panel.getByTestId('tts-write-copy-notebook').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('｜← DIPEA  522.6 µL（3.00 mmol, 3 equiv）');
  expect(bodies).toHaveLength(1);

  // 送る内容は差し込みの一覧。構造の SMILES は送らない
  await panel.getByTestId('tts-write-text').fill('後処理は書かないで');
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-write-preview')).toContainText('{{s1.R1.mg}} = 456.3 mg');
  await panel.getByTestId('tts-write-run').click();
  await expect(page.getByTestId('llm-consent')).toHaveCount(0);
  const draft = panel.getByTestId('tts-write-draft');
  await expect(draft).toBeVisible();
  await expect(draft.getByTestId('ai-notice')).toContainText('AI が書いた文章です');
  await expect(draft.getByTestId('ai-notice')).toContainText('化合物名・量・条件が元のスキームと合うかを確かめてから使ってください');
  await expect(draft.getByTestId('ai-notice')).toContainText('それで問題が無くても間違っていることがあります');
  expect(bodies).toHaveLength(2);
  const sent = JSON.parse(bodies[1]).contents[0].parts[0].text as string;
  expect(sent).toContain('LANGUAGE: English');
  expect(sent).toContain('INSTRUCTION: 後処理は書かないで');
  expect(sent).not.toContain('[C@@H]');

  const out = panel.getByTestId('tts-write-out');
  await expect(out).toHaveValue(/Boc-Ala-OH \(189\.2 mg, 1\.00 mmol\)/);
  await expect(out).toHaveValue(/DIPEA \(522\.6 µL, 3 equiv\)/);
  await expect(out).toHaveValue(/gave 3 \(221\.2 mg, 85%\)/);
  await expect(panel.getByTestId('tts-write-ok')).toBeVisible();
  await expect(panel.getByTestId('tts-write-todos')).toContainText('書き足す所: work-up');

  // 量を倍にして入れ直す（AI は呼ばない）
  await expect(panel.getByTestId('tts-write-stale')).toHaveCount(0);
  await showTab(page, 'scheme');
  await page.getByTestId('stoich-scale').first().fill('378.42');
  await openAi(page, 'write');
  await expect(panel.getByTestId('tts-write-stale')).toBeVisible();
  await panel.getByTestId('tts-write-refill').click();
  await expect(panel.getByTestId('tts-write-stale')).toHaveCount(0);
  await expect(out).toHaveValue(/Boc-Ala-OH \(378\.4 mg, 2\.00 mmol\)/);
  expect(bodies).toHaveLength(2);

  await out.fill('手で直した文');
  await panel.getByTestId('tts-write-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('手で直した文');
  await panel.getByTestId('tts-write-discard').click();
  await expect(draft).toHaveCount(0);

  // 作るに戻すと、いつもの欄が出る
  await openAi(page, 'create');
  await expect(panel.getByTestId('tts-text')).toBeVisible();
});

test('書く: 自分で書いた数字・出てこない試薬・取り違えた量は要確認に出す。言語を選べる', async ({ page }) => {
  const bad = {
    text: '{{C1}} ({{s1.C1.mg}}) と {{C2}} を {{s1.solvent}} 中、{{s1.R1}}（{{s1.R1.equiv}}）で 3 時間かき混ぜ、{{C3}}（{{s1.R2.mg}}、{{s1.yield}}）を得た。',
    questions: ['精製の方法を教えてください'],
  };
  const bodies = await fakeGemini(page, amide, bad);
  const panel = await schemeWithScale(page, '189.21');
  await openAi(page, 'write');
  await panel.getByTestId('tts-write-lang').selectOption('ja');
  await panel.getByTestId('tts-write-run').click();
  const issues = panel.getByTestId('tts-write-issues');
  await expect(issues).toContainText('「3」は、スキームの値から差し込んでいない数字です');
  await expect(issues).toContainText('1 段目の DIPEA が文章にありません');
  await expect(issues).toContainText('3 の所に、1 段目の DIPEA の mg');
  await expect(panel.getByTestId('tts-write-ok')).toHaveCount(0);
  await expect(panel.getByTestId('tts-write-questions')).toContainText('精製の方法を教えてください');
  expect(JSON.parse(bodies[1]).contents[0].parts[0].text).toContain('LANGUAGE: Japanese');

  // 「作る」に切り替えて戻っても、下書き・手で直した文・言語は残る
  await panel.getByTestId('tts-write-out').fill('手で直した途中の文');
  await openAi(page, 'create');
  await expect(panel.getByTestId('tts-write-draft')).toHaveCount(0);
  await openAi(page, 'write');
  await expect(panel.getByTestId('tts-write-out')).toHaveValue('手で直した途中の文');
  await expect(panel.getByTestId('tts-write-issues')).toContainText('1 段目の DIPEA が文章にありません');
  await expect(panel.getByTestId('tts-write-lang')).toHaveValue('ja');
  expect(bodies).toHaveLength(2);
});

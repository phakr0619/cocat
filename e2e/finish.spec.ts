import { expect, test, type Page, type Route } from '@playwright/test';
import { openAi, setApiKey, showTab } from './helpers';

// 仕上げの一括の指示。Gemini は呼ばず、page.route で決まった答えを返す
const API = 'https://generativelanguage.googleapis.com/**';
const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

const amide = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: '室温', time: '2 h', yield: 85 }],
  questions: [] as string[],
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

/** キーを入れ、言葉から下書きを作って確定する */
async function confirmedAmide(page: Page) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  await panel.getByTestId('tts-text').fill('縮合');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await panel.getByTestId('tts-confirm').click();
  return panel;
}

test('仕上げ: 例の指示を入れて仕上げ方を作り、スキームごとの差を見せ、確定で 1 回の変更として入れる', async ({ page }) => {
  const bodies = await fakeGemini(page, amide, {
    ops: [
      { op: 'set_style_option', option: 'stepMarks', value: 'roman' },
      { op: 'rename_reagent', scheme: 1, step: 1, reagent: 'DIPEA', text: 'iPr2NEt' },
      { op: 'set_condition', scheme: 1, step: 1, field: 'temp', value: 'rt' },
      { op: 'renumber', start: 1 },
      { op: 'replace_reagent', step: 1, reagent: 'HATU', text: 'EDC' },
    ],
    cannot: ['フォントの指定は、この道具では直せません'],
    questions: [],
  });
  const panel = await confirmedAmide(page);

  await openAi(page, 'finish');
  const finish = panel.getByTestId('finish');
  await expect(finish.getByTestId('finish-scope-all')).toBeChecked();
  await expect(finish).toContainText('文書のすべてのスキーム（1）');
  await expect(finish.getByTestId('finish-rules')).toContainText('投稿規定で確かめて');
  await expect(finish.getByTestId('finish-run')).toBeDisabled();
  // 例の指示を押すと、文章に入る
  await finish.getByTestId('finish-example').first().click();
  await expect(finish.getByTestId('finish-text')).toHaveValue('ACS の書式に揃えて投稿用に');
  await finish.getByText('送る内容を見る').click();
  await expect(finish.getByTestId('finish-preview')).toContainText('- scheme 1: style=acs');
  await expect(finish.getByTestId('finish-preview')).not.toContainText('smiles');

  const before = await doc(page);
  await finish.getByTestId('finish-run').click();
  const changes = finish.getByTestId('finish-changes');
  await expect(finish.getByTestId('finish-proposal').getByTestId('ai-notice')).toContainText('AI が作った仕上げ方です');
  await expect(finish.getByTestId('finish-proposal').getByTestId('ai-notice')).toContainText('アプリが確かめて問題が無くても間違っていることがある');
  await expect(finish.getByTestId('finish-proposal').getByTestId('ai-notice')).not.toContainText('Gemini');
  await expect(changes).toContainText('スキーム 1');
  await expect(changes).toContainText('書式: ACS（条件を矢印の上下） → ACS（仕上げ）');
  await expect(changes).toContainText('段の記号: a, b, c → i, ii, iii');
  await expect(changes).toContainText('1 段目の試薬: HATU (1.2 equiv), DIPEA (3 equiv) → HATU (1.2 equiv), iPr2NEt (3 equiv)');
  await expect(changes).toContainText('1 段目の温度: 室温 → rt');
  await expect(changes).toContainText('化合物番号:');
  await expect(finish.getByTestId('finish-cannot')).toContainText('この道具ではできないこと: フォントの指定');
  await expect(finish.getByTestId('finish-rejected')).toContainText('仕上げでは、試薬の足し・外し・入れ替え');
  const sent = JSON.parse(bodies[1]);
  expect(sent.contents[0].parts[0].text).toContain('INSTRUCTION:\nACS の書式に揃えて投稿用に');
  expect(sent.systemInstruction.parts[0].text).toContain('You finish reaction schemes');
  // 確定するまで文書は変わらない
  expect(await doc(page)).toEqual(before);

  await finish.getByTestId('finish-confirm').click();
  await expect(finish.getByTestId('finish-proposal')).toHaveCount(0);
  let d = await doc(page);
  let [s] = Object.values(d.schemes!);
  expect(s.styleId).toBe('finish-1');
  expect(d.styles!['finish-1']).toMatchObject({ name: 'ACS（仕上げ）', stepMarks: 'roman' });
  expect(s.steps[0]).toMatchObject({ temp: 'rt', reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'iPr2NEt', equiv: 3 }] });
  expect(Object.values(d.compounds!).map((c) => c.number).sort()).toEqual(['1', '2', '3']);

  // 元に戻す 1 回で、仕上げる前に戻る
  await page.getByTitle('元に戻す (Ctrl+Z)').click();
  d = await doc(page);
  [s] = Object.values(d.schemes!);
  expect(s.styleId).toBe('acs');
  expect(s.steps[0].temp).toBe('室温');
});

test('仕上げ: やめると何も変えない。質問に答えて送り直せる。スキームが無ければ入口を出さない', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await setApiKey(page);
  await openAi(page);
  const empty = page.getByTestId('tts');
  // スキームが無いうちは、仕上げの入口（スキームの欄の「AI で」）を出さない
  await showTab(page, 'scheme');
  await expect(page.getByTestId('scheme-ai')).toHaveCount(0);
  await openAi(page, 'create');

  const bodies = await fakeGemini(page, amide, { ops: [], questions: ['どの雑誌に合わせますか？'] }, { ops: [{ op: 'set_style', style: 'footnote' }], questions: [] });
  await empty.getByTestId('tts-text').fill('縮合');
  await empty.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await empty.getByTestId('tts-confirm').click();
  const before = await doc(page);

  await openAi(page, 'finish');
  const finish = empty.getByTestId('finish');
  await finish.getByTestId('finish-scope-active').check();
  await finish.getByTestId('finish-text').fill('投稿用に');
  await finish.getByTestId('finish-run').click();
  await expect(finish.getByTestId('finish-no-change')).toBeVisible();
  await expect(finish.getByTestId('finish-confirm')).toBeDisabled();
  await finish.getByTestId('tts-answer').fill('脚注の書式で');
  await finish.getByTestId('tts-retry').click();
  await expect(finish.getByTestId('finish-changes')).toContainText('書式: ACS（条件を矢印の上下） → 脚注（Reagents and conditions）');
  expect(JSON.parse(bodies[2]).contents[0].parts[0].text).toContain('A: 脚注の書式で');

  await finish.getByTestId('finish-discard').click();
  await expect(finish.getByTestId('finish-proposal')).toHaveCount(0);
  expect(await doc(page)).toEqual(before);
});

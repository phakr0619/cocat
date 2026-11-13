import { expect, test, type Route } from '@playwright/test';
import { openAi, setApiKey } from './helpers';

// 「言葉から作る」の切り替え（作る / 直す / 書く / 仕上げ）。#31 の「仕上げ」と #32 の「書く」を同じ切り替えに並べたことを確かめる
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

test('作る・直す・書く・仕上げは、選んだものの欄だけを出す。「仕上げ」を挟んでも「書く」の指示は残る', async ({ page }) => {
  await page.route(API, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(amide) }] }, finishReason: 'STOP' }] }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  await panel.getByTestId('tts-text').fill('縮合');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await panel.getByTestId('tts-confirm').click();

  // 作るは上のバーの「AI で作る」、直す・書く・仕上げはスキームの欄の「AI で」から開く。右の欄の見出しに今の使い方を出す
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'ai');
  await expect(page.getByTestId('side-head')).toContainText('AI で作る');

  await openAi(page, 'write');
  await expect(panel.getByTestId('tts-write')).toBeVisible();
  await expect(panel.getByTestId('finish')).toHaveCount(0);
  await expect(panel.getByTestId('tts-text')).toHaveCount(0);
  await panel.getByTestId('tts-write-text').fill('ワークアップは短く');

  await openAi(page, 'finish');
  await expect(panel.getByTestId('finish')).toBeVisible();
  await expect(panel.getByTestId('tts-write')).toHaveCount(0);
  await expect(panel.getByTestId('tts-text')).toHaveCount(0);
  await expect(page.getByTestId('side-head')).toContainText('投稿の形に整える');
  // 見出しの「← スキーム」で、スキームの欄に戻る
  await page.getByTestId('side-back').click();
  await expect(page.getByTestId('scheme-ai')).toBeVisible();

  await openAi(page, 'write');
  await expect(panel.getByTestId('tts-write-text')).toHaveValue('ワークアップは短く');

  await openAi(page, 'create');
  await expect(panel.getByTestId('tts-text')).toBeVisible();
  await expect(panel.getByTestId('tts-write')).toHaveCount(0);
  await expect(panel.getByTestId('finish')).toHaveCount(0);
});

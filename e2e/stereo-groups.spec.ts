import { expect, test } from '@playwright/test';
import { importSmiles, menuItem, smiles } from './helpers';

// rac・rel（拡張立体表記）: 整える → 立体の表し方（docs/salt-design.md）
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

test('選んだ分子をラセミにすると、分子の下に rac と出て SMILES に &1 が付く。相対配置は rel、絶対配置で戻る', async ({ page }) => {
  await importSmiles(page, 'C[C@H](O)[C@@H](N)C');
  const canvasText = (t: string) => page.getByTestId('canvas').locator('text', { hasText: new RegExp(`^${t}$`) });
  // 何も選んでいないときは押せない
  await page.keyboard.press('Escape');
  await page.getByTestId('menu-arrange').click();
  await expect(page.getByTestId('stereo-and')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await menuItem(page, 'menu-arrange', 'ラセミ（rac・&）');
  await expect(canvasText('rac')).toHaveCount(1);
  expect(await smiles(page)).toMatch(/\|&1:\d+,\d+\|$/);
  await menuItem(page, 'menu-arrange', '相対配置（rel・or）');
  await expect(canvasText('rel')).toHaveCount(1);
  expect(await smiles(page)).toMatch(/\|o1:\d+,\d+\|$/);
  await menuItem(page, 'menu-arrange', '絶対配置（abs）');
  await expect(canvasText('rel')).toHaveCount(0);
  expect(await smiles(page)).not.toContain('|');
});

test('CXSMILES（|&1:…|）を読み込むと rac が付いた図になる', async ({ page }) => {
  await importSmiles(page, 'C[C@H](O)[C@@H](N)C |&1:1,3|');
  await expect(page.getByTestId('canvas').locator('text', { hasText: /^rac$/ })).toHaveCount(1);
});

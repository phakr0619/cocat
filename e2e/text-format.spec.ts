import { expect, test, type Page } from '@playwright/test';
import { clickAt, tool } from './helpers';

// 文字の書式: 化学式（数字を下付き）がはじめ入り、下付き・上付き・斜体のボタン
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const tspans = (page: Page, has: string) =>
  page.locator('[data-testid=canvas] .drawing text').filter({ hasText: has }).locator('tspan').allTextContents();

test('文字は、はじめから化学式の書き方（CH2Cl2 → CH₂Cl₂）。外すとそのまま', async ({ page }) => {
  await tool(page, 'text');
  await clickAt(page, 60, 80);
  await expect(page.getByTestId('text-format')).toBeVisible();
  await expect(page.getByTestId('text-formula')).toBeChecked();
  await page.getByTestId('text-input').fill('CH2Cl2, 0 °C, 2 h');
  await page.getByTestId('text-input').press('Enter');
  await expect(page.getByTestId('text-format')).toHaveCount(0);
  expect(Object.values((await doc(page)).texts)[0].formula).toBe(true);
  // 「2」が下付きの別の tspan になる（「2 h」の 2 は下付きにしない）
  await expect.poll(() => tspans(page, 'Cl')).toEqual(['CH', '2', 'Cl', '2', ', 0 °C, 2 h']);
  // 開き直して化学式を外す
  await tool(page, 'text');
  const t = Object.values((await doc(page)).texts)[0];
  await clickAt(page, t.x + 2, t.y - 2);
  await page.getByTestId('text-formula').uncheck();
  await expect(page.getByTestId('text-input')).toBeFocused();
  await page.getByTestId('text-input').press('Enter');
  expect(Object.values((await doc(page)).texts)[0].formula).toBeUndefined();
});

test('下付き・上付き・斜体のボタンで、選んだ文字を囲む（選んでいなければカーソルの所に入れる）', async ({ page }) => {
  await tool(page, 'text');
  await clickAt(page, 60, 80);
  const input = page.getByTestId('text-input');
  await input.pressSequentially('k');
  await page.getByTestId('text-sub').click();
  await input.pressSequentially('obs');
  await expect(input).toHaveValue('k_{obs}');
  await input.press('End');
  await input.pressSequentially(', t');
  await input.press('Shift+ArrowLeft');
  await page.getByTestId('text-italic').click();
  await expect(input).toHaveValue('k_{obs}, *t*');
  await input.pressSequentially('-BuOK, Pd2');
  await page.getByTestId('text-sup').click();
  await input.pressSequentially('+');
  await expect(input).toHaveValue('k_{obs}, *t*-BuOK, Pd2^{+}');
  await input.press('Enter');
  expect(Object.values((await doc(page)).texts)[0].text).toBe('k_{obs}, *t*-BuOK, Pd2^{+}');
});

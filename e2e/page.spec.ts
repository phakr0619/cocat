import { expect, test } from '@playwright/test';
import { importSmiles, menuItem } from './helpers';

test('ページの設定: スライド 2 枚の横長のキャンバスにし、ページごとに印刷する', async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {
      (window.top as unknown as { __printed: number }).__printed = ((window.top as unknown as { __printed?: number }).__printed ?? 0) + 1;
    };
  });
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await importSmiles(page, 'CCO');
  await expect(page.getByTestId('pages')).toHaveCount(0);

  await menuItem(page, 'menu-settings', 'ページの設定…');
  const dlg = page.getByTestId('page-setup');
  await dlg.getByTestId('page-size').selectOption('slide16x9');
  await expect(dlg.getByTestId('page-orientation')).toHaveCount(0);
  await dlg.getByTestId('page-cols').fill('2');
  await dlg.getByTestId('page-apply').click();
  await expect(dlg).toHaveCount(0);
  const pages = page.getByTestId('pages');
  await expect(pages).toHaveAttribute('data-cols', '2');
  await expect(pages).toHaveAttribute('data-rows', '1');

  await menuItem(page, 'menu-file', '印刷・PDF（スライド（16:9）・2 ページ）');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0)).toBe(1);
  const frame = page.frameLocator('iframe[data-testid="print-frame"]');
  await expect(frame.locator('.page svg')).toHaveCount(2);

  // 元に戻すと、ページの枠が消える
  await page.getByTitle('元に戻す (Ctrl+Z)').click();
  await expect(pages).toHaveCount(0);
});

test('ページの設定: A4 を横にし、「図に合わせる」で図が入る枚数にする', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await importSmiles(page, 'CCO');
  await menuItem(page, 'menu-settings', 'ページの設定…');
  const dlg = page.getByTestId('page-setup');
  await dlg.getByTestId('page-orientation').selectOption('landscape');
  await dlg.getByTestId('page-cols').fill('4');
  await dlg.getByTestId('page-fit').click();
  await expect(dlg.getByTestId('page-cols')).toHaveValue('1');
  await dlg.getByTestId('page-apply').click();
  await expect(page.getByTestId('pages')).toHaveAttribute('data-cols', '1');
  await expect(page.locator('[data-testid=pages] line')).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import { atoms, canon, clickAt, hoverAt, showTab, smiles, tool } from './helpers';

// ラベルの書き方（NHFmoc・BF3K）と、ChemDraw のファイルで構造の抜けたラベルを補う（docs/abbreviation-labels.md）
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

test('ラベルに NHFmoc・BF3K と書くと、その構造になる', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  const [, b] = await atoms(page);
  for (const [label, want] of [
    ['NHFmoc', 'CNC(=O)OCC1c2ccccc2-c2ccccc21'],
    ['BF3K', 'C[B-](F)(F)F.[K+]'],
  ]) {
    await hoverAt(page, b.x, b.y);
    await page.keyboard.press('Enter');
    await page.getByTestId('label-input').fill(label);
    await page.keyboard.press('Enter');
    expect(await smiles(page), label).toBe(await canon(page, want));
  }
});

test('ChemDraw のファイルで構造の抜けたラベル（BF3K）を補って読み、知らせる。読めないラベルは赤い枠', async ({ page }) => {
  const cdxml = (text: string) => `<?xml version="1.0"?><CDXML><page id="1"><fragment id="2">
<n id="3" p="0 0"/><n id="4" p="12 7"/><n id="5" p="12 21"/><n id="6" p="0 28"/><n id="7" p="-12 21"/><n id="8" p="-12 7"/>
<n id="9" p="0 -14" NodeType="Unspecified"><t p="0 -14"><s font="3" size="10">${text}</s></t></n>
<b id="10" B="3" E="4" Order="2"/><b id="11" B="4" E="5"/><b id="12" B="5" E="6" Order="2"/><b id="13" B="6" E="7"/><b id="14" B="7" E="8" Order="2"/><b id="15" B="8" E="3"/><b id="16" B="3" E="9"/>
</fragment></page></CDXML>`;
  await showTab(page, 'io');
  await page.getByTestId('import-file').setInputFiles({ name: 'chemdraw.cdxml', mimeType: 'chemical/x-cdxml', buffer: Buffer.from(cdxml('BF3K')) });
  await expect(page.locator('.status')).toContainText('構造の抜けていたラベル 1 個');
  expect(await smiles(page)).toBe(await canon(page, 'F[B-](F)(F)c1ccccc1.[K+]'));
  await expect(page.locator('[data-testid=canvas] .errors rect')).toHaveCount(0);
  // 読めないラベル
  await page.getByTestId('import-file').setInputFiles({ name: 'chemdraw2.cdxml', mimeType: 'chemical/x-cdxml', buffer: Buffer.from(cdxml('Xyz9')) });
  await expect(page.locator('.status')).toContainText('構造が分かりません（Xyz9');
  await expect(page.locator('[data-testid=canvas] .errors rect')).toHaveCount(1);
  expect(Object.values((await doc(page)).atoms).some((a) => a.abbr === 'Xyz9')).toBe(true);
});

test('略号の辞書: ラベルを試し、自分の略号を足して使い、再読み込みしても覚えていて、消せる', async ({ page }) => {
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('open-abbr-dict').click();
  const dlg = page.getByTestId('abbr-dict');
  await expect(dlg).toBeVisible();
  // ラベルを試す
  await dlg.getByTestId('abbr-trial').fill('BF3K');
  await expect(dlg.getByTestId('abbr-trial-result')).toContainText('ラベルの読み方');
  await dlg.getByTestId('abbr-trial').fill('Nap');
  await expect(dlg.getByTestId('abbr-trial-result')).toContainText('読めません');
  // 足す（元素記号の名前は断る）
  await dlg.getByTestId('abbr-name').fill('Cl');
  await dlg.getByTestId('abbr-smiles').fill('*c1ccc2ccccc2c1');
  await dlg.getByTestId('abbr-add').click();
  await expect(dlg.getByTestId('abbr-error')).toContainText('元素記号');
  await dlg.getByTestId('abbr-name').fill('Nap');
  await dlg.getByTestId('abbr-smiles').fill('c1ccc2cc(*)ccc2c1');
  await dlg.getByTestId('abbr-add').click();
  await expect(dlg.getByTestId('abbr-user-row')).toHaveCount(1);
  // * から始まる形にして覚える
  await expect(dlg.getByTestId('abbr-user-row').locator('code')).toHaveText(/^\*c/);
  await dlg.getByTestId('abbr-trial').fill('ONap');
  await expect(dlg.getByTestId('abbr-trial-result')).toContainText('ラベルの読み方');
  await dlg.getByRole('button', { name: '閉じる' }).click();
  // ラベルに使う
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  const [, b] = await atoms(page);
  await hoverAt(page, b.x, b.y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('ONap');
  await page.keyboard.press('Enter');
  expect(await smiles(page)).toBe(await canon(page, 'COc1ccc2ccccc2c1'));
  // 文書に写る
  await expect.poll(async () => Object.keys((await doc(page)).abbrDefs ?? {})).toEqual(['ONap']);
  // 再読み込みしても覚えている（自動保存を待ってから）
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ai-chem-editor:autosave')?.includes('ONap') ?? false)).toBe(true);
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  expect(await smiles(page)).toBe(await canon(page, 'COc1ccc2ccccc2c1'));
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('open-abbr-dict').click();
  await expect(page.getByTestId('abbr-user-row')).toHaveCount(1);
  await page.getByTestId('abbr-remove').click();
  await expect(page.getByTestId('abbr-user-row')).toHaveCount(0);
});

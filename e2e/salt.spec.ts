import { expect, test, type Page } from '@playwright/test';
import { canon, hoverAt, importSmiles, menuItem, pt, showTab, smiles, tool } from './helpers';

// 塩（まとまり）: 選んだ 2 つの分子を 1 つの化合物にまとめる・解く（docs/salt-design.md）
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const unitsOf = async (page: Page) => new Set(Object.values((await doc(page)).atoms).map((a) => a.unit).filter(Boolean));

test('塩としてまとめる: 分析が 1 つになり、成分を「C9H13NO·HCl」と出す。ダブルクリックで塩全体を選び、解くと戻る', async ({ page }) => {
  await importSmiles(page, 'CNCC(O)c1ccccc1.Cl');
  await showTab(page, 'analysis');
  await expect(page.getByTestId('analysis-card')).toHaveCount(2);
  // 何も選んでいないときは、まとめられない
  await page.keyboard.press('Escape');
  await page.getByTestId('menu-arrange').click();
  await expect(page.getByTestId('group-salt')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await menuItem(page, 'menu-arrange', '塩としてまとめる');
  expect((await unitsOf(page)).size).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('analysis-card')).toHaveCount(1);
  await expect(page.getByTestId('salt-formula')).toHaveText('C9H13NO·HCl');
  await expect(page.getByTestId('mw')).toHaveText('187.67');
  // 塩の Cl をダブルクリックすると、アミンも一緒に選ばれ、点線の枠が出る
  await tool(page, 'select');
  const cl = Object.values((await doc(page)).atoms).find((a) => a.element === 'Cl')!;
  const p = await pt(page, cl.x, cl.y);
  await page.mouse.dblclick(p.x, p.y);
  await expect.poll(async () => page.evaluate(() => window.__editor!.get().selection.size)).toBeGreaterThan(20);
  await expect(page.getByTestId('unit-frame')).toBeVisible();
  await menuItem(page, 'menu-arrange', 'まとまりを解く');
  expect((await unitsOf(page)).size).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('analysis-card')).toHaveCount(2);
});

test('塩の SMILES（電荷が打ち消し合う）は、読み込むと 1 つの塩になる', async ({ page }) => {
  await importSmiles(page, 'C[NH2+]CC(O)c1ccccc1.[Cl-]');
  await showTab(page, 'analysis');
  await expect(page.getByTestId('analysis-card')).toHaveCount(1);
  await expect(page.getByTestId('salt-formula')).toHaveText('C9H14NO+·Cl−');
});

test('ラベルに「NH2Cl」「NH·HCl」と書くと塩になる。水素の数が合わない書き方は知らせる', async ({ page }) => {
  await importSmiles(page, 'CNCC(O)c1ccccc1');
  await page.keyboard.press('Escape');
  const n = Object.values((await doc(page)).atoms).find((a) => a.element === 'N')!;
  const edit = async (text: string) => {
    await hoverAt(page, n.x, n.y);
    await page.keyboard.press('Enter');
    await page.getByTestId('label-input').fill(text);
    await page.keyboard.press('Enter');
  };
  await edit('NH2Cl');
  expect(await smiles(page)).toBe(await canon(page, 'C[NH2+]CC(O)c1ccccc1.[Cl-]'));
  // 図のラベルは書いたとおり（NH₂Cl）
  await expect(page.getByTestId('canvas').locator('text', { hasText: 'Cl' })).toHaveCount(1);
  await showTab(page, 'analysis');
  await expect(page.getByTestId('salt-formula')).toHaveText('C9H14NO+·Cl−');
  await expect(page.getByTestId('mw')).toHaveText('187.67');
  await edit('NH·HCl');
  expect(await smiles(page)).toBe(await canon(page, 'CNCC(O)c1ccccc1.Cl'));
  await expect(page.getByTestId('salt-formula')).toHaveText('C9H13NO·HCl');
  // 2 級アミンに NH3Cl は合わない
  await edit('NH3Cl');
  await expect(page.locator('.status')).toContainText('NH2Cl');
  expect(await smiles(page)).toBe(await canon(page, 'CNCC(O)c1ccccc1.Cl'));
});

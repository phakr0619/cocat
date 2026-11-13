import { expect, test } from '@playwright/test';
import { clickAt, tool, importSmiles, menuItem, showTab } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await showTab(page, 'analysis');
});


test('分子を描くと、分析パネルに組成式・分子量・m/z・元素分析値が出る', async ({ page }) => {
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  const card = page.getByTestId('analysis-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('C9H8O4');
  await expect(page.getByTestId('mw')).toHaveText('180.16');
  await expect(page.getByTestId('isotopes')).toContainText('M 100 · M+1 10');
  await expect(card).toContainText('180.0423');
  await expect(card).toContainText('181.0495');
  await expect(card).toContainText('C 60.00, H 4.48, O 35.52');
  await expect(card).toContainText('Lipinski 適合');
});

test('選んだ分子だけを分析する', async ({ page }) => {
  await importSmiles(page, 'CCO');
  await importSmiles(page, 'c1ccccc1');
  // 読み込んだ直後は読み込んだ分子が選ばれているので、選択を外すと全部が対象になる
  await expect(page.getByTestId('analysis-card')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('analysis-card')).toHaveCount(2);
  const benz = await page.evaluate(() => Object.values(window.__editor!.get().doc.atoms).at(-1)!);
  await tool(page, 'select');
  await clickAt(page, benz.x, benz.y);
  await expect(page.getByTestId('analysis-card')).toHaveCount(1);
  await expect(page.getByTestId('analysis-card')).toContainText('C6H6');
});

test('R/S を表示し、立体の決まっていない中心を知らせる', async ({ page }) => {
  await importSmiles(page, 'C[C@H](N)C(=O)O');
  await page.getByTestId('show-stereo').check();
  await expect(page.getByTestId('stereo-label')).toHaveText('(S)');
  await menuItem(page, 'menu-file', '新規');
  await importSmiles(page, 'CC(N)C(=O)O');
  await expect(page.getByTestId('stereo-label')).toHaveText('(?)');
  await expect(page.getByTestId('warnings')).toContainText('立体の決まっていない不斉中心が 1 個あります');
  // 警告をクリックすると、その原子を選ぶ
  await page.getByTestId('warnings').getByRole('button').click();
  const sel = await page.evaluate(() => [...window.__editor!.get().selection]);
  expect(sel).toHaveLength(1);
});

test('二重結合の E/Z を分析の欄とキャンバスに出す', async ({ page }) => {
  await importSmiles(page, 'C/C=C/C.C/C=C\\C');
  await page.getByTestId('show-stereo').check();
  await expect(page.getByTestId('stereo-label')).toHaveText(['(E)', '(Z)']);
  await expect(page.getByTestId('bond-stereo')).toHaveText(['E', 'Z']);
});

test('分析の値をキャンバスに文字として貼れる', async ({ page }) => {
  await importSmiles(page, 'CCO');
  await page.getByRole('button', { name: 'キャンバスに貼る' }).click();
  const texts = await page.evaluate(() => Object.values(window.__editor!.get().doc.texts).map((t) => t.text));
  expect(texts[0]).toContain('Chemical Formula: C2H6O');
  expect(texts[0]).toContain('Molecular Weight: 46.07');
});

test('NMR の予測（加成則の目安）を開くと、¹H・¹³C の値が出て、行を指すと原子をキャンバスで示す', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await importSmiles(page, 'CC(=O)c1ccccc1');
  await page.keyboard.press('Escape');
  const nmr = page.getByTestId('nmr');
  await nmr.locator('summary').click();
  await expect(page.getByTestId('nmr-note')).toContainText('加成則');
  await expect(page.getByTestId('nmr-note')).toContainText('目安');
  // アセトフェノン: ¹H は 4 組（ortho・para・meta・CH3）、¹³C は 6 組
  const h1 = page.getByTestId('nmr-h1').getByTestId('nmr-row');
  const c13 = page.getByTestId('nmr-c13').getByTestId('nmr-row');
  await expect(h1).toHaveCount(4);
  await expect(c13).toHaveCount(6);
  await expect(c13.first()).toContainText('198.0');
  await expect(h1.last()).toContainText('2.60');
  await expect(h1.last()).toContainText('3H');
  // 行を指すと、その原子（メチルの炭素）を緑で示す。外れると消える
  await h1.last().hover();
  const marks = page.getByTestId('nmr-marks');
  await expect(marks).toHaveCount(1);
  const methyl = await page.evaluate(() => Object.values(window.__editor!.get().doc.atoms)[0].id);
  await expect(marks).toHaveAttribute('data-ids', methyl);
  // ortho の 2 つの炭素は 1 行にまとめ、2 つとも示す
  await c13.nth(3).hover();
  await expect(marks).toHaveAttribute('data-ids', /^\S+ \S+$/);
  await page.getByTestId('nmr-copy').hover();
  await expect(marks).toHaveCount(0);
  // クリックで固定する
  await h1.first().click();
  await page.getByTestId('nmr-copy').hover();
  await expect(marks).toHaveCount(1);
  // 値をコピーすると、論文の書き方になる
  await page.getByTestId('nmr-copy').click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('1H NMR (predicted, additivity rules): δ 7.89 (2H)');
  expect(text).toContain('13C NMR (predicted, additivity rules): δ 198.0');
});

test('表で読めない原子（ピリジン）は、NMR の予測で「予測できない」と出す', async ({ page }) => {
  await importSmiles(page, 'Cc1ccncc1');
  await page.getByTestId('nmr').locator('summary').click();
  const c13 = page.getByTestId('nmr-c13');
  await expect(c13).toContainText('予測できない: ベンゼン以外の芳香環');
  await expect(c13.getByTestId('nmr-row').filter({ hasText: '—' })).toHaveCount(3);
});

import { expect, test } from '@playwright/test';
import { atoms, canon, clickAt, dragPt, hoverAt, smiles, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

test('クリックで結合を描き、末端をクリックすると鎖が伸びる', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  for (let i = 0; i < 3; i++) {
    const last = (await atoms(page)).at(-1)!;
    await clickAt(page, last.x, last.y);
  }
  expect(await smiles(page)).toBe('CCCCC');
});

test('既存の結合をクリックすると次数が変わり、Ctrl+Z で戻る', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  const [a, b] = await atoms(page);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  await clickAt(page, mx, my);
  expect(await smiles(page)).toBe('C=C');
  await clickAt(page, mx, my);
  expect(await smiles(page)).toBe('C#C');
  await page.keyboard.press('Control+z');
  expect(await smiles(page)).toBe('C=C');
  await page.keyboard.press('Control+y');
  expect(await smiles(page)).toBe('C#C');
});

test('ドラッグで任意の向きに描け、既存の原子へつなげる', async ({ page }) => {
  await tool(page, 'single');
  await dragPt(page, 50, 50, 50, 70);
  const [a, b] = await atoms(page);
  expect(Math.abs(a.x - b.x)).toBeLessThan(0.01);
  // 下の原子から、最初の原子の右へ 30° 刻みで
  await dragPt(page, b.x, b.y, b.x + 14, b.y + 6);
  expect(await smiles(page)).toBe('CCC');
});

test('原子に合わせてキーを押すと元素・電荷が変わり、水素が付いて表示される', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  const [, b] = await atoms(page);
  await hoverAt(page, b.x, b.y);
  await page.keyboard.press('n');
  expect(await smiles(page)).toBe('CN');
  await expect(page.locator('[data-owner] >> text=NH')).toHaveCount(1);
  await page.keyboard.press('+');
  expect(await smiles(page)).toBe(await canon(page, 'C[NH3+]'));
  await page.keyboard.press('o');
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  expect(await smiles(page)).toBe(await canon(page, 'C[O-]'));
});

test('Enter でラベル入力欄が開き、略号や NH2 を入力できる', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  const [, b] = await atoms(page);
  await hoverAt(page, b.x, b.y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('NH2');
  await page.keyboard.press('Enter');
  expect(await smiles(page)).toBe('CN');
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('Boc');
  await page.keyboard.press('Enter');
  expect(await smiles(page)).toBe(await canon(page, 'CC(=O)OC(C)(C)C'));
});

test('くさびと波線を描ける', async ({ page }) => {
  await tool(page, 'wedge');
  await clickAt(page, 50, 80);
  await expect(page.locator('polygon[data-owner]')).toHaveCount(1);
  await tool(page, 'wavy');
  const last = (await atoms(page)).at(-1)!;
  await clickAt(page, last.x, last.y);
  await expect(page.locator('path[data-owner]')).toHaveCount(1);
});

test('鎖ツールはドラッグした長さぶんジグザグ鎖を描く', async ({ page }) => {
  await tool(page, 'chain');
  await dragPt(page, 40, 80, 40 + 12.47 * 5, 80);
  expect(await smiles(page)).toBe('CCCCCC');
});

test('点線の結合（水素結合）は価数に数えず、O−H···O の H に赤い枠を出さない。SMILES にも入れない', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  const [, b] = await atoms(page);
  // 2 つ目の原子を H、1 つ目を O にする（O−H）
  await hoverAt(page, b.x, b.y);
  await page.keyboard.press('h');
  const [a] = await atoms(page);
  await hoverAt(page, a.x, a.y);
  await page.keyboard.press('o');
  // H から点線の結合を引き、先を O にする
  await tool(page, 'dashed');
  const before = new Set((await atoms(page)).map((x) => x.id));
  await dragPt(page, b.x, b.y, b.x + 30, b.y);
  const far = (await atoms(page)).find((x) => !before.has(x.id))!;
  await hoverAt(page, far.x, far.y);
  await page.keyboard.press('o');
  await expect(page.locator('[data-testid=canvas] .errors rect')).toHaveCount(0);
  // 水素結合は SMILES に入らない（O−H の水と、もう 1 つの水）
  expect(await smiles(page)).toBe('O.[H]O');
});

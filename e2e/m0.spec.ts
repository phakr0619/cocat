import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { atoms, clickAt, pt, smiles, tool, menuItem } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const viewBox = (page: Page) =>
  page.evaluate(() => {
    const vb = (document.querySelector('[data-testid=canvas]') as SVGSVGElement).viewBox.baseVal;
    return { x: vb.x, y: vb.y, w: vb.width };
  });

test('ページを開き直すと、自動保存した文書から続けられる', async ({ page }) => {
  await tool(page, 'benzene');
  await clickAt(page, 60, 60);
  await page.waitForTimeout(600);
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  expect(await smiles(page)).toBe('c1ccccc1');
});

test('文書を保存して、新規のあとに開き直せる', async ({ page }) => {
  await tool(page, 'benzene');
  await clickAt(page, 60, 60);
  await tool(page, 'arrow-normal');
  await clickAt(page, 100, 60);
  const [dl] = await Promise.all([page.waitForEvent('download'), menuItem(page, 'menu-file', '保存')]);
  expect(dl.suggestedFilename()).toBe('structure.acedoc');
  const body = readFileSync((await dl.path())!);
  await menuItem(page, 'menu-file', '新規');
  expect(await smiles(page)).toBe('（空）');
  await page.getByTestId('open-doc').setInputFiles({ name: 'structure.acedoc', mimeType: 'application/json', buffer: body });
  // ファイルの読み込みは非同期なので、反映を待つ
  await expect.poll(() => page.evaluate(() => Object.keys(window.__editor!.get().doc.atoms).length)).toBe(6);
  const d = await page.evaluate(() => window.__editor!.get().doc);
  expect(Object.keys(d.atoms)).toHaveLength(6);
  expect(Object.keys(d.arrows)).toHaveLength(1);
  // 新規は元に戻せる
  await page.keyboard.press('Control+z');
  expect(await smiles(page)).toBe('（空）');
});

test('環ツールでは、置く前にプレビューが出る', async ({ page }) => {
  await tool(page, 'ring6');
  const p = await pt(page, 80, 80);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('.preview line')).toHaveCount(6);
  await tool(page, 'ring5');
  await page.mouse.move(p.x + 3, p.y + 3);
  await expect(page.locator('.preview line')).toHaveCount(5);
});

test('ホイールとスペース＋ドラッグで表示を動かし、動かした先でも正しい位置に描ける', async ({ page }) => {
  const c = await pt(page, 100, 100);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, 250);
  const v1 = await viewBox(page);
  expect(v1.y).toBeGreaterThan(50);
  // スペース＋ドラッグで左へ
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(c.x - 100, c.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const v2 = await viewBox(page);
  expect(v2.x).toBeGreaterThan(v1.x + 20);
  expect(await atoms(page)).toHaveLength(0);
  // 動かした先で描いた原子は、カーソルの位置の文書の座標に来る
  await tool(page, 'single');
  await clickAt(page, v2.x + 40, v2.y + 40);
  const [a] = await atoms(page);
  expect(a.x).toBeCloseTo(v2.x + 40, 0);
  expect(a.y).toBeCloseTo(v2.y + 40, 0);
});

test('Ctrl＋ホイールで、カーソルの位置を中心に拡大する', async ({ page }) => {
  await tool(page, 'benzene');
  await clickAt(page, 80, 80);
  const before = await viewBox(page);
  const c = await pt(page, 80, 80);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  // 表示の更新（React の描き直し）を待つ。すぐに読むと、負荷の高いときに前の表示を読むことがあった
  await expect.poll(async () => (await viewBox(page)).w).toBeLessThan(before.w);
  // カーソルの下の点は動かない
  const c2 = await pt(page, 80, 80);
  expect(c2.x).toBeCloseTo(c.x, 0);
  expect(c2.y).toBeCloseTo(c.y, 0);
});

test('大きなキャンバス: 「−」で 10% まで縮小でき、「全体を表示」と Shift+1 で離れた分子まで入る。書き出しの欄は表示の外の物を知らせる', async ({ page }) => {
  // 2 つの分子を、横に 4000 pt 離して置く
  await page.evaluate(() => {
    const e = window.__editor!;
    const d = structuredClone(e.get().doc);
    const add = (id: string, x: number) => (d.atoms[id] = { id, element: 'C', x, y: 100, charge: 0 } as never);
    add('a1', 100);
    add('a2', 4100);
    e.commit(d, new Set());
  });
  const level = page.getByTestId('zoom-level');
  // 「−」を押し続けると 10% で止まる（前は 100% で止まった）
  for (let i = 0; i < 12; i++) await page.getByTestId('zoom-out').click();
  await expect(level).toHaveText('10%');
  // 全体を表示してから左の分子のあたりを拡大すると、右の分子が表示の外に出る。書き出しの欄がそれを知らせる
  await page.evaluate(() => window.__editor!.set({ selection: new Set() }));
  await menuItem(page, 'menu-file', 'SMILES・MOL・CDXML の読み込みと書き出し…');
  // 左の分子の上で Ctrl＋ホイールで拡大する（カーソルの下は動かない）
  const zoomIn = async () => {
    const c = await pt(page, 100, 100);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -600);
    await page.keyboard.up('Control');
  };
  await page.getByTestId('zoom-fit').click();
  await zoomIn();
  await expect(page.getByTestId('export-outside')).toContainText('1 個');
  // 「全体を表示」で両方が入り、知らせが消える
  await page.getByTestId('zoom-fit').click();
  const vb = await viewBox(page);
  expect(vb.x).toBeLessThanOrEqual(100);
  expect(vb.x + vb.w).toBeGreaterThanOrEqual(4100);
  await expect(page.getByTestId('export-outside')).toHaveCount(0);
  // Shift+1 でも同じ
  await zoomIn();
  await expect(page.getByTestId('export-outside')).toBeVisible();
  await page.locator('body').press('Shift+Digit1');
  await expect(page.getByTestId('export-outside')).toHaveCount(0);
});

test('右ボタンのドラッグで表示を動かす（ブラウザのメニューは出さず、何も描かない）', async ({ page }) => {
  await tool(page, 'single');
  const before = await viewBox(page);
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 80, y + 40, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await viewBox(page)).x).toBeCloseTo(before.x - 80 / 2.5, 0);
  const after = await viewBox(page);
  expect(after.y).toBeCloseTo(before.y - 40 / 2.5, 0);
  expect(Object.keys(await page.evaluate(() => window.__editor!.get().doc.atoms))).toHaveLength(0);
  const prevented = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('[data-testid=canvas]')!.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(true);
});

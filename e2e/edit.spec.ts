import { expect, test, type Page } from '@playwright/test';
import { atoms, canon, clickAt, dragPt, hoverAt, pt, smiles, tool, menuItem } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const selection = (page: Page) => page.evaluate(() => [...window.__editor!.get().selection]);

async function bondMid(page: Page, pick: 'right' | 'left' | 'top') {
  const d = await doc(page);
  const bs = Object.values(d.bonds).map((b) => ({ x: (d.atoms[b.a1].x + d.atoms[b.a2].x) / 2, y: (d.atoms[b.a1].y + d.atoms[b.a2].y) / 2 }));
  bs.sort((p, q) => (pick === 'right' ? q.x - p.x : pick === 'left' ? p.x - q.x : p.y - q.y));
  return bs[0];
}

test('環ツール: 置く・結合に縮環・原子に付ける', async ({ page }) => {
  await tool(page, 'benzene');
  await clickAt(page, 80, 80);
  expect(await smiles(page)).toBe('c1ccccc1');
  const m = await bondMid(page, 'right');
  await clickAt(page, m.x, m.y);
  expect(await smiles(page)).toBe(await canon(page, 'c1ccc2ccccc2c1'));
  // 原子をクリックすると、その原子を共有する環（スピロ）
  await tool(page, 'ring6');
  await clickAt(page, 200, 80);
  await tool(page, 'ring5');
  const right = (await atoms(page)).sort((a, b) => b.x - a.x)[0];
  await clickAt(page, right.x, right.y);
  expect(await smiles(page)).toBe(await canon(page, 'c1ccc2ccccc2c1.C1CCC2(CC1)CCCC2'));
  // 芳香環の炭素にスピロ環を付けると価数を超えるので、エラーになる
  const top = (await atoms(page)).filter((a) => a.x < 150).sort((a, b) => a.y - b.y)[0];
  await clickAt(page, top.x, top.y);
  await expect(page.getByTestId('smiles')).toHaveClass(/error/);
});

test('環ツール: 押したまま動かすと、その向きに回して置く（15° 刻み）。押してすぐ離せば今までの向き', async ({ page }) => {
  await tool(page, 'ring6');
  // 押してすぐ離す: 頂点が真上
  await clickAt(page, 80, 80);
  const up = (await atoms(page)).sort((a, b) => a.y - b.y)[0];
  expect(up.x).toBeCloseTo(80, 1);
  // 何もない所から右へドラッグ: 頂点が右を向く。プレビューも出る
  const a = await pt(page, 250, 80);
  const b = await pt(page, 300, 82);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await expect(page.locator('[data-testid=canvas] g.preview line').first()).toBeAttached();
  await page.mouse.up();
  const ring2 = (await atoms(page)).filter((p) => p.x > 200);
  expect(ring2).toHaveLength(6);
  const right = ring2.sort((p, q) => q.x - p.x)[0];
  // 2° ずれた向きでも 0° に止まる（右端の頂点が中心と同じ高さ）
  expect(right.y).toBeCloseTo(80, 1);
  expect(await smiles(page)).toBe(await canon(page, 'C1CCCCC1.C1CCCCC1'));
});

test('矩形選択して移動・削除できる', async ({ page }) => {
  await tool(page, 'ring6');
  await clickAt(page, 60, 60);
  await tool(page, 'single');
  await clickAt(page, 150, 60);
  await tool(page, 'select');
  await dragPt(page, 30, 30, 95, 95);
  expect((await selection(page)).filter((id) => id.startsWith('a'))).toHaveLength(6);
  // 選んだ環をドラッグして動かす
  const a = (await atoms(page))[0];
  await dragPt(page, a.x, a.y, a.x + 20, a.y + 10);
  const moved = (await atoms(page))[0];
  expect(moved.x).toBeCloseTo(a.x + 20, 0);
  await page.keyboard.press('Delete');
  expect(await smiles(page)).toBe('CC');
  await page.keyboard.press('Control+z');
  expect(await smiles(page)).toBe('C1CCCCC1.CC');
});

test('投げ縄で選んで、ハンドルで回転・左右反転', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 60, 80);
  await tool(page, 'lasso');
  const p = [
    [50, 60], [90, 60], [90, 95], [50, 95],
  ];
  const s = await pt(page, p[0][0], p[0][1]);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  for (const [x, y] of [...p.slice(1), p[0]]) {
    const q = await pt(page, x, y);
    await page.mouse.move(q.x, q.y, { steps: 3 });
  }
  await page.mouse.up();
  expect(await selection(page)).toHaveLength(3);
  const before = await atoms(page);
  const angle = (as: { x: number; y: number }[]) => (Math.atan2(as[1].y - as[0].y, as[1].x - as[0].x) * 180) / Math.PI;
  const handle = await page.getByTestId('rotate-handle').boundingBox();
  const hx = handle!.x + handle!.width / 2;
  const hy = handle!.y + handle!.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 150, hy + 150, { steps: 5 });
  await page.mouse.up();
  const after = await atoms(page);
  expect(Math.abs(angle(after) - angle(before))).toBeGreaterThan(20);
  await page.keyboard.press('Control+Shift+H');
  const flipped = await atoms(page);
  expect(flipped[0].x).toBeCloseTo(after[1].x, 1);
});

test('コピー・貼り付け（Ctrl+C / Ctrl+V）', async ({ page }) => {
  await tool(page, 'benzene');
  await clickAt(page, 60, 60);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(() => smiles(page)).toBe('c1ccccc1.c1ccccc1');
  await page.keyboard.press('Control+x');
  expect(await smiles(page)).toBe('c1ccccc1');
});

test('コピーすると、ほかのアプリへ図（PNG・データ入りの PNG を含む HTML）と SMILES を渡す。ほかのアプリの SMILES・Molfile を貼ると読み込む', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await tool(page, 'benzene');
  await clickAt(page, 60, 60);
  await page.keyboard.press('Control+a');
  // クリップボードは、並べて流すほかの試験と共有なので、読む途中で書き換わることがある（Clipboard data has changed）。
  // そのときは、コピーからやり直す
  await expect(async () => {
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types).sort().join(',')), { timeout: 3000 }).toBe('image/png,text/html,text/plain');
    const png = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0];
      const b = await item.getType('image/png');
      const bmp = await createImageBitmap(b);
      return { size: b.size, w: bmp.width };
    });
    expect(png.size).toBeGreaterThan(1000);
    // 300 dpi（1 pt = 300/72 px）なので、ベンゼン 1 つでも幅は 100 px を超える
    expect(png.w).toBeGreaterThan(100);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('c1ccccc1');
  }).toPass({ timeout: 20000 });

  // ほかのアプリから来た文字を貼る（ブラウザの paste の知らせ）
  const paste = (text: string) =>
    page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
  await paste('CCO');
  await expect.poll(() => smiles(page)).toBe('CCO.c1ccccc1');
  // 自分がコピーした SMILES の貼り付けは、描いた形のまま貼る（このエディタの中のコピー）
  await paste('c1ccccc1');
  await expect.poll(() => smiles(page)).toBe('CCO.c1ccccc1.c1ccccc1');
  // 編集の「図を画像でコピー」は、選んでいなければ図の全体
  await page.keyboard.press('Escape');
  await expect(async () => {
    await menuItem(page, 'menu-edit', '図を画像でコピー');
    await expect(page.locator('.status')).toContainText('図をコピーしました');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('CCO.c1ccccc1.c1ccccc1');
  }).toPass({ timeout: 20000 });
});

test('ダブルクリックで分子全体を選ぶ', async ({ page }) => {
  await tool(page, 'benzene');
  await clickAt(page, 60, 60);
  await tool(page, 'single');
  await clickAt(page, 150, 60);
  await tool(page, 'select');
  const a = (await atoms(page))[0];
  const q = await pt(page, a.x, a.y);
  await page.mouse.dblclick(q.x, q.y);
  expect((await selection(page)).length).toBe(12);
});

test('略号を展開して縮約に戻す', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 60, 80);
  const [, b] = await atoms(page);
  await hoverAt(page, b.x, b.y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('Ph');
  await page.keyboard.press('Enter');
  await menuItem(page, 'menu-arrange', '略号を展開');
  expect((await atoms(page)).length).toBe(7);
  expect(await smiles(page)).toBe(await canon(page, 'Cc1ccccc1'));
  await menuItem(page, 'menu-arrange', '略号に縮約');
  expect((await atoms(page)).length).toBe(2);
  await expect(page.locator('[data-owner] >> text=Ph')).toHaveCount(1);
});

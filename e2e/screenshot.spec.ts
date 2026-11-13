import { test } from '@playwright/test';
import { atoms, clickAt, hoverAt, tool } from './helpers';

// 見た目の確認用（SHOT を指定したときだけ撮る）
test('画面の確認用スクリーンショット', async ({ page }) => {
  test.skip(!process.env.SHOT, 'SHOT を指定したときだけ撮る');
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  // ナフタレン + 置換基
  await tool(page, 'benzene');
  await clickAt(page, 60, 60);
  const doc = () => page.evaluate(() => window.__editor!.get().doc);
  let d = await doc();
  const rightBond = Object.values(d.bonds).sort((p, q) => d.atoms[q.a1].x + d.atoms[q.a2].x - d.atoms[p.a1].x - d.atoms[p.a2].x)[0];
  const m = { x: (d.atoms[rightBond.a1].x + d.atoms[rightBond.a2].x) / 2, y: (d.atoms[rightBond.a1].y + d.atoms[rightBond.a2].y) / 2 };
  await clickAt(page, m.x, m.y);
  // 椅子形・シクロペンタン
  await tool(page, 'chair');
  await clickAt(page, 200, 60);
  await tool(page, 'ring5');
  await clickAt(page, 280, 60);
  // 鎖 + ヘテロ原子 + くさび
  await tool(page, 'single');
  await clickAt(page, 40, 130);
  for (let i = 0; i < 3; i++) {
    const last = (await atoms(page)).at(-1)!;
    await clickAt(page, last.x, last.y);
  }
  let as = await atoms(page);
  await hoverAt(page, as.at(-1)!.x, as.at(-1)!.y);
  await page.keyboard.press('o');
  await hoverAt(page, as.at(-4)!.x, as.at(-4)!.y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('Boc');
  await page.keyboard.press('Enter');
  await tool(page, 'double');
  d = await doc();
  const b2 = Object.values(d.bonds).at(-2)!;
  await clickAt(page, (d.atoms[b2.a1].x + d.atoms[b2.a2].x) / 2, (d.atoms[b2.a1].y + d.atoms[b2.a2].y) / 2);
  await tool(page, 'wedge');
  as = await atoms(page);
  await clickAt(page, as.at(-3)!.x, as.at(-3)!.y);
  await tool(page, 'hash');
  await clickAt(page, as.at(-2)!.x, as.at(-2)!.y);
  // カルボン酸イオン、アンモニウム
  await tool(page, 'single');
  await clickAt(page, 160, 130);
  as = await atoms(page);
  await clickAt(page, as.at(-1)!.x, as.at(-1)!.y);
  await clickAt(page, as.at(-1)!.x, as.at(-1)!.y);
  as = await atoms(page);
  await hoverAt(page, as.at(-1)!.x, as.at(-1)!.y);
  await page.keyboard.press('o');
  await page.keyboard.press('-');
  await hoverAt(page, as.at(-3)!.x, as.at(-3)!.y);
  await page.keyboard.press('n');
  await page.keyboard.press('+');
  await page.mouse.move(5, 5);
  await page.screenshot({ path: process.env.SHOT, clip: { x: 76, y: 41, width: 1000, height: 500 } });
});

import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragPt, hoverAt, importSmiles, menuItem, tool } from './helpers';

// 反応機構の記号・矢印の種類・同位体
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

test('曲がった矢印を、結合の中ほどから原子へ引く。クリックでふくらむ側を変え、ドラッグで曲がり具合を変える', async ({ page }) => {
  await importSmiles(page, 'C=O');
  const d0 = await doc(page);
  const [c, o] = ['C', 'O'].map((e) => Object.values(d0.atoms).find((a) => a.element === e)!);
  const mid = { x: (c.x + o.x) / 2, y: (c.y + o.y) / 2 };
  await tool(page, 'arrow-curved');
  await dragPt(page, mid.x, mid.y, o.x, o.y);
  await expect.poll(async () => Object.values((await doc(page)).arrows).length).toBe(1);
  const r = Object.values((await doc(page)).arrows)[0];
  expect(r.kind).toBe('curved');
  expect(r.x1).toBeCloseTo(mid.x, 1);
  expect(r.x2).toBeCloseTo(o.x, 1);
  // 曲線の上をクリックすると、ふくらむ側が逆になる
  const onCurve = (a: typeof r) => ({ x: 0.25 * a.x1 + 0.5 * a.cx! + 0.25 * a.x2, y: 0.25 * a.y1 + 0.5 * a.cy! + 0.25 * a.y2 });
  const p = onCurve(r);
  await clickAt(page, p.x, p.y);
  await expect.poll(async () => Object.values((await doc(page)).arrows)[0].cy).toBeCloseTo(2 * ((r.y1 + r.y2) / 2) - r.cy!, 1);
  // ドラッグで曲線を引っぱる
  const r2 = Object.values((await doc(page)).arrows)[0];
  const q = onCurve(r2);
  await dragPt(page, q.x, q.y, q.x, q.y - 12);
  await expect.poll(async () => onCurve(Object.values((await doc(page)).arrows)[0]).y).toBeCloseTo(q.y - 12, 0);
});

test('電子 1 個の矢印・ローンペア・ラジカル・部分電荷・共鳴・点線・進まないの道具', async ({ page }) => {
  await importSmiles(page, 'CO');
  const d0 = await doc(page);
  const [c, o] = ['C', 'O'].map((e) => Object.values(d0.atoms).find((a) => a.element === e)!);
  await tool(page, 'lone-pair');
  await clickAt(page, o.x, o.y);
  await clickAt(page, o.x, o.y);
  await tool(page, 'radical');
  await clickAt(page, c.x, c.y);
  await tool(page, 'delta-plus');
  await clickAt(page, c.x, c.y);
  await expect.poll(async () => {
    const d = await doc(page);
    return [d.atoms[o.id].lonePairs, d.atoms[c.id].radical, Object.values(d.texts).map((t) => t.text)];
  }).toEqual([2, true, ['δ+']]);
  await expect(page.getByTestId('smiles')).toHaveText('[CH2]O');
  // 何も無い所を押すと、原子を押すよう知らせる
  await tool(page, 'radical');
  await clickAt(page, c.x + 80, c.y + 80);
  await expect(page.locator('.status')).toContainText('原子をクリックしてください');

  await tool(page, 'arrow-fishhook');
  await dragPt(page, c.x, c.y + 30, c.x + 30, c.y + 30);
  for (const [id, y] of [['arrow-resonance', 60], ['arrow-dashed', 80], ['arrow-nogo', 100]] as const) {
    await tool(page, id);
    await dragPt(page, c.x, c.y + y, c.x + 40, c.y + y);
  }
  await expect.poll(async () => Object.values((await doc(page)).arrows).sort((a, b) => a.y1 - b.y1).map((r) => `${r.kind}${r.half ? ':half' : ''}${r.dashed ? ':dashed' : ''}${r.noGo ? ':nogo' : ''}`)).toEqual([
    'curved:half',
    'resonance',
    'normal:dashed',
    'normal:nogo',
  ]);
});

test('原子のラベルに「13C」「D」と書くと同位体になる', async ({ page }) => {
  await importSmiles(page, 'CC');
  const a = Object.values((await doc(page)).atoms)[0];
  await hoverAt(page, a.x, a.y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('13C');
  await page.getByTestId('label-input').press('Enter');
  await expect(page.getByTestId('smiles')).toHaveText('C[13CH3]');
});

test('結合の道具: 太い・点線・配位。配位結合はもう一度クリックで向きが反転する', async ({ page }) => {
  await importSmiles(page, 'NB');
  const d0 = await doc(page);
  const b = Object.values(d0.bonds)[0];
  const m = { x: (d0.atoms[b.a1].x + d0.atoms[b.a2].x) / 2, y: (d0.atoms[b.a1].y + d0.atoms[b.a2].y) / 2 };
  const bond = async () => Object.values((await doc(page)).bonds)[0];
  for (const t of ['bold', 'dashed', 'dative'] as const) {
    await tool(page, t);
    await clickAt(page, m.x, m.y);
    await expect.poll(async () => (await bond()).stereo).toBe(t);
  }
  const a1 = (await bond()).a1;
  await clickAt(page, m.x, m.y);
  await expect.poll(async () => (await bond()).a1).not.toBe(a1);
  // 配位結合は構造に入れない
  await expect(page.getByTestId('smiles')).toHaveText('B.N');
});

test('図形の道具: ドラッグで四角・楕円を描き、括弧の道具で分子をクリックすると囲む', async ({ page }) => {
  await importSmiles(page, 'CC(=O)OCC');
  const d0 = await doc(page);
  const a = Object.values(d0.atoms)[0];
  await tool(page, 'rect');
  await dragPt(page, a.x + 80, a.y - 20, a.x + 120, a.y + 20);
  await tool(page, 'oval');
  await dragPt(page, a.x + 140, a.y - 20, a.x + 180, a.y + 20);
  await tool(page, 'bracket-square');
  await clickAt(page, a.x, a.y);
  await expect.poll(async () => Object.values((await doc(page)).shapes ?? {}).map((s) => s.kind).sort()).toEqual(['bracket-square', 'oval', 'rect']);
  // 括弧は分子の全体を囲む
  const d = await doc(page);
  const br = Object.values(d.shapes!).find((s) => s.kind === 'bracket-square')!;
  for (const at of Object.values(d.atoms)) {
    expect(at.x).toBeGreaterThan(br.x1);
    expect(at.x).toBeLessThan(br.x2);
  }
  // 選択の道具で四角を選んで消す
  const rect = Object.values(d.shapes!).find((s) => s.kind === 'rect')!;
  await tool(page, 'select');
  await clickAt(page, rect.x1, (rect.y1 + rect.y2) / 2);
  await page.keyboard.press('Delete');
  await expect.poll(async () => Object.values((await doc(page)).shapes ?? {}).map((s) => s.kind).sort()).toEqual(['bracket-square', 'oval']);
});

test('雛形: 一覧からアミノ酸を選び、キャンバスをクリックして置く', async ({ page }) => {
  await page.getByTestId('open-templates').click();
  const panel = page.getByTestId('templates');
  // はじめは芳香環のタブ（ChemDraw に慣れた人が探す、ナフタレン・ピリジンなど）
  await expect(panel.getByRole('tab', { name: '芳香環' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: 'ピリジン', exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: 'アミノ酸' }).click();
  await expect(panel.getByTestId('template')).toHaveCount(20);
  await panel.getByRole('button', { name: 'Ala', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.status')).toContainText('L-アラニン');
  await clickAt(page, 80, 80);
  await expect.poll(() => page.evaluate(() => window.__canon!('C[C@H](N)C(=O)O'))).toBeTruthy();
  const want = await page.evaluate(() => window.__canon!('N[C@@H](C)C(=O)O'));
  await expect(page.getByTestId('smiles')).toHaveText(want!);
  // 糖のタブ
  await page.getByTestId('open-templates').click();
  await page.getByTestId('templates').getByRole('tab', { name: '糖' }).click();
  await expect(page.getByTestId('templates').getByRole('button', { name: 'β-Glc' })).toBeVisible();
});

test('色のメニューで選んだ物の色を変える。文字の欄に ^{…}・*…* と書くと上付き・斜体で描く', async ({ page }) => {
  await importSmiles(page, 'CCO');
  // 読み込んだ分子は選ばれている
  await menuItem(page, 'menu-color', '赤');
  await expect.poll(async () => Object.values((await doc(page)).atoms).map((a) => a.color)).toEqual(['#d32f2f', '#d32f2f', '#d32f2f']);
  await expect(page.locator('[data-testid=canvas] .drawing [stroke="#d32f2f"]').first()).toBeVisible();
  await menuItem(page, 'menu-color', '黒');
  await expect.poll(async () => Object.values((await doc(page)).atoms).some((a) => a.color)).toBe(false);
  // 何も選んでいなければ知らせる
  await page.keyboard.press('Escape');
  await menuItem(page, 'menu-color', '青');
  await expect(page.locator('.status')).toContainText('色を変える物を選んでください');

  await tool(page, 'text');
  await clickAt(page, 60, 140);
  await page.getByTestId('text-input').fill('*t*-BuOK, Pd^{2+}');
  await page.getByTestId('text-input').press('Enter');
  const text = page.locator('[data-testid=canvas] .drawing text').filter({ hasText: 'BuOK' });
  await expect(text.locator('tspan[font-style="italic"]')).toHaveText('t');
  await expect(text.locator('tspan').last()).toHaveText('2+');
});

test('図の設定で、線の太さと文字の大きさを変える', async ({ page }) => {
  await importSmiles(page, 'CCO');
  await menuItem(page, 'menu-settings', '図の設定…');
  const dlg = page.getByTestId('draw-style');
  await dlg.getByRole('button', { name: /発表用/ }).click();
  await expect.poll(async () => (await doc(page)).drawStyle).toEqual({ lineWidth: 1, fontSize: 10 });
  await expect(page.locator('[data-testid=canvas] .drawing line').first()).toHaveAttribute('stroke-width', '1');
  await dlg.getByTestId('draw-font-size').fill('14');
  await dlg.getByTestId('draw-style-apply').click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await doc(page)).drawStyle?.fontSize).toBe(14);
});

test('印刷・PDF: 図を入れたページを作って、印刷の画面を開く', async ({ page }) => {
  // 印刷の画面は開かず、呼ばれたことだけを残す（枠の中も含めて）
  await page.addInitScript(() => {
    window.print = () => {
      (window.top as unknown as { __printed: number }).__printed = ((window.top as unknown as { __printed?: number }).__printed ?? 0) + 1;
    };
  });
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  await importSmiles(page, 'CCO');
  await menuItem(page, 'menu-file', '印刷・PDF（A4）');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0)).toBe(1);
  const frame = page.frameLocator('iframe[data-testid="print-frame"]');
  await expect(frame.locator('.page[data-paper="A4"] svg')).toHaveCount(1);
});

test('芳香環: 「芳香環・雛形」からピリジンを選んで置く', async ({ page }) => {
  await expect(page.getByTestId('open-templates')).toHaveText('芳香環・雛形');
  await page.getByTestId('open-templates').click();
  await page.getByTestId('templates').getByRole('button', { name: 'ピリジン', exact: true }).click();
  await clickAt(page, 80, 80);
  const want = await page.evaluate(() => window.__canon!('c1ccncc1'));
  await expect(page.getByTestId('smiles')).toHaveText(want!);
});

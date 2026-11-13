import { expect, test, type Page } from '@playwright/test';
import { clickAt, hoverAt, smiles, tool, importSmiles, menuItem, showTab } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  // ライブラリの列は、はじめは閉じている
  await page.getByTestId('toggle-library').click();
  await expect(page.getByTestId('project-select')).toBeVisible();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

test('選んだ分子を登録し、同じ構造は重複として知らせ、クリックとドラッグでキャンバスに置ける', async ({ page }) => {
  const lib = page.getByTestId('library');
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  // 読み込んだ分子は選ばれた状態
  await lib.getByTestId('register').click();
  await expect(lib.getByTestId('lib-card')).toHaveCount(1);
  await lib.getByTestId('lib-nickname').fill('アスピリン');
  await lib.getByTestId('lib-nickname').blur();
  await expect(lib.getByTestId('lib-card')).toContainText('アスピリン');
  await expect(lib.getByTestId('lib-card')).toContainText('C9H8O4 · 180.16');

  // 同じ構造をもう一度登録しようとすると知らせる
  await importSmiles(page, 'OC(=O)c1ccccc1OC(C)=O');
  await lib.getByTestId('register').click();
  await expect(lib.getByTestId('duplicate')).toContainText('同じ構造の「アスピリン」が登録済みです');
  await lib.getByRole('button', { name: '登録済みのものにつなぐ' }).click();
  await expect(lib.getByTestId('lib-card')).toHaveCount(1);

  // クリックで置く
  await menuItem(page, 'menu-file', '新規');
  await lib.getByTestId('lib-card').getByRole('button').first().click();
  expect(await smiles(page)).toBe('CC(=O)Oc1ccccc1C(=O)O');

  // ドラッグで置く
  const canvas = page.getByTestId('canvas');
  await lib.getByTestId('lib-card').dragTo(canvas, { targetPosition: { x: 600, y: 500 } });
  await expect.poll(() => smiles(page)).toBe('CC(=O)Oc1ccccc1C(=O)O.CC(=O)Oc1ccccc1C(=O)O');
});

test('つながった分子を直すと知らせ、ライブラリを更新できる。ページを開き直しても残る', async ({ page }) => {
  const lib = page.getByTestId('library');
  await importSmiles(page, 'CCO');
  await lib.getByTestId('register').click();
  await page.keyboard.press('Escape');
  const o = Object.values((await doc(page)).atoms).find((a) => a.element === 'O')!;
  await hoverAt(page, o.x, o.y);
  await page.keyboard.press('n');
  await expect(lib.getByTestId('link-changed')).toBeVisible();
  await lib.getByRole('button', { name: 'ライブラリを更新' }).click();
  await expect(lib.getByTestId('link-changed')).toHaveCount(0);
  await expect(lib.getByTestId('lib-card')).toContainText('C2H7N');

  // 保存（IndexedDB）を待ってから開き直す
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId('library').getByTestId('lib-card')).toContainText('C2H7N');
});

test('プロジェクトを作って切り替え、図を保存して開ける', async ({ page }) => {
  const lib = page.getByTestId('library');
  await lib.getByRole('button', { name: '＋' }).click();
  await lib.getByTestId('project-name').fill('全合成 A');
  await lib.getByTestId('project-name').press('Enter');
  await expect(lib.getByTestId('project-select')).toContainText('全合成 A');

  await tool(page, 'benzene');
  await clickAt(page, 80, 80);
  await lib.getByRole('tab', { name: /図/ }).click();
  await lib.getByTestId('figure-name').fill('ルート案 1');
  await lib.getByRole('button', { name: '今の図を保存' }).click();
  await expect(lib.getByTestId('figure')).toHaveCount(1);
  await menuItem(page, 'menu-file', '新規');
  expect(await smiles(page)).toBe('（空）');
  await lib.getByTestId('figure').getByRole('button', { name: '開く' }).click();
  expect(await smiles(page)).toBe('c1ccccc1');

  // 最初のプロジェクトに戻すと、図は無い
  await lib.getByTestId('project-select').selectOption({ label: 'マイプロジェクト（0）' });
  await expect(lib.getByTestId('figure')).toHaveCount(0);
});

test('ライブラリの列は閉じられる', async ({ page }) => {
  await page.getByTestId('toggle-library').click();
  await expect(page.getByTestId('library')).toHaveCount(0);
  await page.getByTestId('toggle-library').click();
  await expect(page.getByTestId('library')).toBeVisible();
});

test('プロジェクト一式を zip で書き出せる', async ({ page }) => {
  const lib = page.getByTestId('library');
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  await lib.getByTestId('register').click();
  await expect(lib.getByTestId('lib-card')).toHaveCount(1);
  await lib.getByText('プロジェクトの書き出し・読み込み').click();
  const dl = page.waitForEvent('download');
  await lib.getByTestId('project-zip').click();
  const d = await dl;
  // 日本語のファイル名（マイプロジェクト.zip）は、ヘッドレスの Chromium では「download」になるので名前は見ない
  const chunks: Buffer[] = [];
  for await (const c of await d.createReadStream()) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  // zip の頭の印と、中のファイルの名前
  expect(buf.readUInt32LE(0)).toBe(0x04034b50);
  const s = buf.toString('utf8');
  for (const name of ['README.txt', 'project.aceproj.json', 'compounds.sdf', 'compounds.csv']) expect(s).toContain(name);
});

test('選んだ分子を部品にし、原子をクリックしてつなぐ', async ({ page }) => {
  const lib = page.getByTestId('library');
  await importSmiles(page, '*C(=O)OC(C)(C)C');
  await lib.getByTestId('parts-tab').click();
  await lib.getByTestId('part-name').fill('Boc');
  await lib.getByTestId('add-part').click();
  await expect(lib.getByTestId('part-card')).toHaveCount(1);
  await expect(lib.getByTestId('part-card')).toContainText('Boc');

  await menuItem(page, 'menu-file', '新規');
  await importSmiles(page, 'NCC');
  const n = Object.values((await doc(page)).atoms).find((a) => a.element === 'N')!;
  await lib.getByTestId('part-card').getByRole('button').first().click();
  await expect(lib.getByTestId('part-card')).toHaveClass(/on/);
  await clickAt(page, n.x, n.y);
  await expect.poll(() => smiles(page)).toBe('CCNC(=O)OC(C)(C)C');
  // 何もない所に置く
  await clickAt(page, n.x, n.y + 120);
  await expect.poll(async () => (await smiles(page)).split('.').sort()).toEqual(['CC(C)(C)OC=O', 'CCNC(=O)OC(C)(C)C']);
});

test('プロジェクトの書き出し・読み込みのボタンは、同じ高さで揃って並ぶ', async ({ page }) => {
  const lib = page.getByTestId('library');
  await lib.getByText('プロジェクトの書き出し・読み込み').click();
  const boxes = await lib.locator('.lib-io .row').first().locator('button, label.file').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height) };
    }),
  );
  expect(boxes).toHaveLength(4);
  // 折り返しても、各段の中で上端と高さが揃う
  const rows = new Map<number, number[]>();
  for (const b of boxes) rows.set(b.top, [...(rows.get(b.top) ?? []), b.height]);
  expect(rows.size).toBeLessThanOrEqual(2);
  for (const hs of rows.values()) expect(new Set(hs).size).toBe(1);
  expect(new Set(boxes.map((b) => b.height)).size).toBe(1);
});

test('検討表を反応式ごとプロジェクトに入れ、新しい図に置ける', async ({ page }) => {
  const lib = page.getByTestId('library');
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  await showTab(page, 'scheme');
  await page.getByTestId('scheme-panel').getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await showTab(page, 'table');
  const table = page.getByTestId('table-panel');
  await table.getByTestId('new-conditions-table').click();
  await table.getByTestId('cell-yield').first().fill('91^a');
  await table.getByTestId('cell-yield').first().press('Enter');
  await lib.getByTestId('tables-tab').click();
  await expect(lib.getByTestId('doc-table')).toHaveCount(1);
  await lib.getByTestId('save-table').click();
  await expect(lib.getByTestId('saved-table')).toHaveCount(1);
  await expect(lib.getByTestId('saved-table')).toContainText('反応式つき');
  // 新しい図に置く
  await menuItem(page, 'menu-file', '新規');
  await expect.poll(async () => Object.keys((await doc(page)).tables ?? {}).length).toBe(0);
  await lib.getByTestId('place-table').click();
  await expect.poll(async () => Object.keys((await doc(page)).tables ?? {}).length).toBe(1);
  const d = await doc(page);
  expect(Object.keys(d.schemes ?? {})).toHaveLength(1);
  expect(Object.values(d.texts).map((t) => t.text)).toEqual(expect.arrayContaining(['Table 1.', '91ᵃ']));
  // ページを開き直しても、プロジェクトに残る
  await page.reload();
  await page.getByTestId('library').getByTestId('tables-tab').click();
  await expect(page.getByTestId('saved-table')).toHaveCount(1);
});

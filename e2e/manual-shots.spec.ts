// docs/manual.html の画像を撮る（MANUAL=1 のときだけ）: MANUAL=1 npx playwright test e2e/manual-shots.spec.ts
import { test, type Page } from '@playwright/test';
import { pt, importSmiles, tool, openSample as openSampleMenu, showTab } from './helpers';

test.skip(!process.env.MANUAL, 'MANUAL=1 のときだけ撮る');
test.use({ deviceScaleFactor: 2 });

const OUT = 'docs/manual/img';

async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
}
const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
async function click(page: Page, x: number, y: number) {
  const p = await pt(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function hover(page: Page, x: number, y: number) {
  const p = await pt(page, x, y);
  await page.mouse.move(p.x, p.y);
}
async function newest(page: Page) {
  return Object.values((await doc(page)).atoms).at(-1)!;
}
/** 文書の範囲（pt）を画面で切り取って保存 */
async function shot(page: Page, name: string, box: { x1: number; y1: number; x2: number; y2: number }) {
  await page.mouse.move(2, 2);
  const a = await pt(page, box.x1, box.y1);
  const b = await pt(page, box.x2, box.y2);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } });
}

test('結合の種類', async ({ page }) => {
  await load(page);
  const kinds = ['single', 'double', 'triple', 'wedge', 'hash', 'wavy'];
  for (let i = 0; i < kinds.length; i++) {
    await tool(page, kinds[i]);
    await click(page, 30 + i * 30, 50);
  }
  await shot(page, 'bonds', { x1: 22, y1: 30, x2: 210, y2: 58 });
});

test('ジグザグ鎖', async ({ page }) => {
  await load(page);
  await tool(page, 'chain');
  const a = await pt(page, 30, 60);
  const b = await pt(page, 30 + 12.47 * 7, 60);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await shot(page, 'chain', { x1: 22, y1: 40, x2: 130, y2: 70 });
});

test('原子ラベル', async ({ page }) => {
  await load(page);
  await tool(page, 'single');
  // 左右の末端に N と O（水素の向きが変わる）
  await click(page, 40, 60);
  let n = await newest(page);
  await click(page, n.x, n.y);
  n = await newest(page);
  await click(page, n.x, n.y);
  const atoms = Object.values((await doc(page)).atoms);
  await hover(page, atoms[0].x, atoms[0].y);
  await page.keyboard.press('n');
  await hover(page, atoms.at(-1)!.x, atoms.at(-1)!.y);
  await page.keyboard.press('o');
  // 電荷（アンモニウムとアルコキシド）
  for (const [x, el, ch] of [[100, 'n', '+'], [140, 'o', '-']] as const) {
    await click(page, x, 66);
    n = await newest(page);
    await hover(page, n.x, n.y);
    await page.keyboard.press(el);
    await page.keyboard.press(ch);
  }
  // 略号: 左端は MeO2C、右端は Boc（結合の向きで表記が変わる）
  await click(page, 205, 66);
  n = await newest(page);
  await click(page, n.x, n.y);
  n = await newest(page);
  await click(page, n.x, n.y);
  const chain = Object.values((await doc(page)).atoms).slice(-4);
  await hover(page, chain[0].x, chain[0].y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('CO2Me');
  await page.keyboard.press('Enter');
  await hover(page, chain[3].x, chain[3].y);
  await page.keyboard.press('Enter');
  await page.getByTestId('label-input').fill('Boc');
  await page.keyboard.press('Enter');
  await shot(page, 'labels', { x1: 22, y1: 35, x2: 285, y2: 82 });
});

test('環テンプレート', async ({ page }) => {
  await load(page);
  const kinds = ['ring3', 'ring4', 'ring5', 'ring6', 'ring7', 'ring8', 'benzene', 'chair'];
  for (let i = 0; i < kinds.length; i++) {
    await tool(page, kinds[i]);
    await click(page, 40 + i * 46, 60);
  }
  await shot(page, 'rings', { x1: 15, y1: 35, x2: 400, y2: 85 });
});

test('縮環とスピロ', async ({ page }) => {
  await load(page);
  await tool(page, 'benzene');
  await click(page, 50, 60);
  let d = await doc(page);
  const right = Object.values(d.bonds).sort((p, q) => d.atoms[q.a1].x + d.atoms[q.a2].x - d.atoms[p.a1].x - d.atoms[p.a2].x)[0];
  await click(page, (d.atoms[right.a1].x + d.atoms[right.a2].x) / 2, (d.atoms[right.a1].y + d.atoms[right.a2].y) / 2);
  d = await doc(page);
  const r2 = Object.values(d.bonds).sort((p, q) => d.atoms[q.a1].x + d.atoms[q.a2].x - d.atoms[p.a1].x - d.atoms[p.a2].x)[0];
  await tool(page, 'ring5');
  await click(page, (d.atoms[r2.a1].x + d.atoms[r2.a2].x) / 2, (d.atoms[r2.a1].y + d.atoms[r2.a2].y) / 2);
  await tool(page, 'ring6');
  await click(page, 170, 60);
  const top = Object.values((await doc(page)).atoms).filter((a) => a.x > 150).sort((a, b) => a.y - b.y)[0];
  await tool(page, 'ring4');
  await click(page, top.x, top.y);
  await shot(page, 'fused', { x1: 25, y1: 20, x2: 200, y2: 95 });
});

test('選択と回転のハンドル', async ({ page }) => {
  await load(page);
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  await page.keyboard.press('Control+a');
  await page.mouse.move(2, 2);
  const d = await doc(page);
  const xs = Object.values(d.atoms).map((a) => a.x);
  const ys = Object.values(d.atoms).map((a) => a.y);
  await shot(page, 'select', { x1: Math.min(...xs) - 18, y1: Math.min(...ys) - 30, x2: Math.max(...xs) + 18, y2: Math.max(...ys) + 14 });
});

test('Clean Structure の前後', async ({ page }) => {
  await load(page);
  await importSmiles(page, 'CC(C)Cc1ccc(cc1)C(C)C(=O)O');
  // 選択ツールで原子をいくつか引っぱって形を崩す
  await tool(page, 'select');
  // 読み込んだ分子は選ばれた状態なので、選択を外してから1つずつ動かす
  await page.keyboard.press('Escape');
  const as = Object.values((await doc(page)).atoms);
  for (const [i, dx, dy] of [[0, 6, -8], [4, -5, 6], [9, 8, 5], [12, -4, -9]] as const) {
    const a = await pt(page, as[i].x, as[i].y);
    const b = await pt(page, as[i].x + dx, as[i].y + dy);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
  }
  await page.keyboard.press('Escape');
  const box = async () => {
    const d = await doc(page);
    const xs = Object.values(d.atoms).map((a) => a.x);
    const ys = Object.values(d.atoms).map((a) => a.y);
    return { x1: Math.min(...xs) - 22, y1: Math.min(...ys) - 22, x2: Math.max(...xs) + 22, y2: Math.max(...ys) + 22 };
  };
  const b0 = await box();
  await shot(page, 'clean-before', b0);
  await page.keyboard.press('Control+Shift+K');
  await shot(page, 'clean-after', b0);
});

test('反応スキーム', async ({ page }) => {
  await load(page);
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  const r = Object.values((await doc(page)).arrows)[0];
  await tool(page, 'text');
  await click(page, r.x1 + 3, r.y1 - 6);
  await page.getByTestId('text-input').fill('EDC, HOBt');
  await page.keyboard.press('Enter');
  await click(page, r.x1 + 3, r.y1 + 14);
  await page.getByTestId('text-input').fill('DMF, rt');
  await page.keyboard.press('Enter');
  await tool(page, 'select');
  const d = await doc(page);
  const xs = Object.values(d.atoms).map((a) => a.x);
  const ys = Object.values(d.atoms).map((a) => a.y);
  await shot(page, 'scheme', { x1: Math.min(...xs) - 16, y1: Math.min(...ys) - 12, x2: Math.max(...xs) + 16, y2: Math.max(...ys) + 12 });
});

test('矢印の種類', async ({ page }) => {
  await load(page);
  for (const [i, k] of ['arrow-normal', 'arrow-equilibrium', 'arrow-retro'].entries()) {
    await tool(page, k);
    await click(page, 30 + i * 60, 50);
  }
  await shot(page, 'arrows', { x1: 22, y1: 40, x2: 210, y2: 60 });
});

// ---- M1〜M2 の機能

/** 見本を開き、キャンバスの描いた範囲だけを撮る */
async function openSample(page: Page, id: string, zoomOut = 0) {
  await openSampleMenu(page, id);
  for (let i = 0; i < zoomOut; i++) await page.getByRole('button', { name: '−', exact: true }).click();
  await page.mouse.move(2, 2);
}
/** 列の中身の高さまでを撮る */
async function shotColumn(page: Page, name: string) {
  const lib = page.getByTestId('library');
  const box = (await lib.boundingBox())!;
  const last = (await lib.locator('.lib-io').boundingBox())!;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x, y: box.y, width: box.width, height: last.y + last.height + 10 - box.y } });
}
async function shotDrawing(page: Page, name: string, pad = 10) {
  const d = await doc(page);
  const xs = [...Object.values(d.atoms).map((a) => a.x), ...Object.values(d.texts).map((t) => t.x), ...Object.values(d.arrows).flatMap((r) => [r.x1, r.x2])];
  const ys = [...Object.values(d.atoms).map((a) => a.y), ...Object.values(d.texts).map((t) => t.y), ...Object.values(d.arrows).flatMap((r) => [r.y1, r.y2])];
  const textRight = Object.values(d.texts).map((t) => t.x + t.text.length * 5.6);
  await shot(page, name, { x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad - 8, x2: Math.max(...xs, ...textRight) + pad, y2: Math.max(...ys) + pad + 4 });
}

test('全体の画面（ライブラリの列つき）', async ({ page }) => {
  await load(page);
  await page.getByTestId('toggle-library').click();
  await openSample(page, 'coupling');
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  await page.getByTestId('library').getByTestId('register').click();
  await page.keyboard.press('Escape');
  await page.mouse.move(2, 2);
  await page.screenshot({ path: `${OUT}/overview.png` });
});

test('スキームのデータ（3段）と書式', async ({ page }) => {
  await load(page);
  await openSample(page, 'multistep', 2);
  await shotDrawing(page, 'scheme-multistep');
  await page.getByTestId('scheme-panel').getByTestId('scheme-style').selectOption('footnote');
  await page.mouse.move(2, 2);
  await shotDrawing(page, 'scheme-footnote');
  await page.getByTestId('scheme-panel').getByTestId('scheme-style').selectOption('acs');
  await page.getByTestId('scheme-panel').getByTestId('stoich').first().locator('summary').click();
  await page.getByTestId('stoich-scale').first().fill('100');
  await page.mouse.move(2, 2);
  await page.getByTestId('scheme-step').first().screenshot({ path: `${OUT}/scheme-step.png` });
});

test('検討表', async ({ page }) => {
  await load(page);
  await openSample(page, 'conditions', 2);
  await shotDrawing(page, 'table-conditions');
  await page.getByTestId('table-panel').screenshot({ path: `${OUT}/table-panel.png` });
  await openSample(page, 'sar');
  await shotDrawing(page, 'table-sar');
});

test('ライブラリと部品', async ({ page }) => {
  await load(page);
  await page.getByTestId('toggle-library').click();
  const lib = page.getByTestId('library');
  for (const [s, name] of [['CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', 'Boc-Ala-OH'], ['NCC(=O)OC', 'グリシンメチル'], ['CC(=O)Oc1ccccc1C(=O)O', 'アスピリン']]) {
    await importSmiles(page, s);
    await lib.getByTestId('register').click();
    await lib.getByTestId('lib-nickname').fill(name);
    await lib.getByTestId('lib-nickname').blur();
  }
  await page.mouse.move(2, 2);
  await shotColumn(page, 'library');
  await importSmiles(page, '*C(=O)OC(C)(C)C');
  await lib.getByTestId('parts-tab').click();
  await lib.getByTestId('part-name').fill('Boc');
  await lib.getByTestId('add-part').click();
  await importSmiles(page, '*C(=O)OCc1ccccc1');
  await lib.getByTestId('part-name').fill('Cbz');
  await lib.getByTestId('add-part').click();
  await page.mouse.move(2, 2);
  await shotColumn(page, 'parts');
});

test('分析', async ({ page }) => {
  await load(page);
  await openSample(page, 'aspirin');
  await showTab(page, 'analysis');
  await page.getByTestId('analysis').screenshot({ path: `${OUT}/analysis.png` }).catch(async () => {
    await page.locator('.analysis').screenshot({ path: `${OUT}/analysis.png` });
  });
});

test('NMR の予測', async ({ page }) => {
  await load(page);
  await importSmiles(page, 'CC(=O)c1ccccc1');
  await page.keyboard.press('Escape');
  await showTab(page, 'analysis');
  await page.getByTestId('nmr').locator('summary').click();
  // ortho の H の行を固定して、キャンバスの印も写す
  await page.getByTestId('nmr-h1').getByTestId('nmr-row').first().click();
  await page.mouse.move(2, 2);
  await page.getByTestId('nmr').screenshot({ path: `${OUT}/nmr.png` });
});

import { expect, test, type Page } from '@playwright/test';
import { canon, smiles, openSample, menuItem, showTab } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const texts = async (page: Page) => Object.values((await doc(page)).texts).map((t) => t.text);

test('見本を開ける（アスピリン・タキソール）', async ({ page }) => {
  await openSample(page, 'aspirin');
  await expect.poll(() => smiles(page)).toBe(await canon(page, 'CC(=O)Oc1ccccc1C(=O)O'));
  await openSample(page, 'taxol');
  await expect.poll(async () => Object.keys((await doc(page)).atoms).length).toBe(62);
  // 元に戻すで前の図に戻る
  await page.getByRole('button', { name: '↶ 元に戻す' }).click();
  await expect.poll(() => smiles(page)).toBe(await canon(page, 'CC(=O)Oc1ccccc1C(=O)O'));
});

// 完了条件（M2-8）: Phase 1 の見本と多段のスキームを、書式を切り替えて描き直せる
for (const id of ['coupling', 'multistep', 'conditions']) {
  test(`見本「${id}」を書式を切り替えて描き直せる`, async ({ page }) => {
    await openSample(page, id);
    await showTab(page, 'scheme');
    const panel = page.getByTestId('scheme-panel');
    await expect(panel.getByTestId('scheme-style')).toBeVisible();
    const before = await smiles(page);
    expect(before).toContain('>>');

    await panel.getByTestId('scheme-style').selectOption('footnote');
    await expect.poll(async () => (await texts(page)).some((t) => t.startsWith('Reagents and conditions'))).toBe(true);
    expect(await smiles(page)).toBe(before);

    await panel.getByTestId('scheme-style').selectOption('lab');
    await expect.poll(async () => (await texts(page)).some((t) => t.startsWith('Reagents and conditions'))).toBe(false);
    expect(await smiles(page)).toBe(before);

    await panel.getByTestId('scheme-style').selectOption('acs');
    expect(await smiles(page)).toBe(before);
    if (id === 'multistep') expect(before.split('\n')).toHaveLength(3);
    if (id === 'conditions') expect(await texts(page)).toEqual(expect.arrayContaining(['Table 1.', 'T3P (1.5), Et3N (3)']));
  });
}

test('見本「SAR の表」', async ({ page }) => {
  await openSample(page, 'sar');
  await expect.poll(() => texts(page)).toEqual(expect.arrayContaining(['Table 1.', 'R1', 'R2', '1a', '1b', '1c']));
});

test('「このツールについて」でデータの扱いと連絡先を示し、閉じられる', async ({ page }) => {
  await menuItem(page, 'menu-help', 'このツールについて');
  const about = page.getByTestId('about');
  await expect(about).toBeVisible();
  await expect(about).toContainText('サーバーへは送りません');
  // 連絡先（VITE_FEEDBACK_URL）を入れていないときは「準備中」
  await expect(about.getByTestId('feedback-pending')).toBeVisible();
  await about.getByRole('button', { name: '閉じる' }).click();
  await expect(about).toHaveCount(0);
});

test('使い方の統計: 止められて、開き直しても止まったまま。手元のビルドでは何も送らない', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/e') sent.push(r.url());
  });
  await openSample(page, 'coupling');
  await menuItem(page, 'menu-help', 'このツールについて');
  const toggle = page.getByTestId('analytics-toggle');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByTestId('about').getByRole('button', { name: '閉じる' }).click();
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  await menuItem(page, 'menu-help', 'このツールについて');
  await expect(page.getByTestId('analytics-toggle')).not.toBeChecked();
  expect(sent).toEqual([]);
});

test('見本を開くと、全体が画面に収まるように表示を合わせる', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openSample(page, 'conditions');
  // 描いた物の端（原子・文字・線）が、すべてキャンバスの見えている範囲に入る
  const inside = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const d = window.__editor!.get().doc;
    const pts = [...Object.values(d.atoms), ...Object.values(d.texts), ...Object.values(d.arrows).flatMap((r) => [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }])];
    return pts.every((p) => p.x >= vb.x && p.x <= vb.x + vb.width && p.y >= vb.y && p.y <= vb.y + vb.height);
  });
  expect(inside).toBe(true);
});

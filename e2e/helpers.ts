import { expect, type Page } from '@playwright/test';

/** 文書の座標（pt）を画面の座標にして返す */
export async function pt(page: Page, x: number, y: number) {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const v = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    return { zoom: svg.clientWidth / vb.width, x: vb.x, y: vb.y };
  });
  return { x: box.x + (x - v.x) * v.zoom, y: box.y + (y - v.y) * v.zoom };
}

export async function clickAt(page: Page, x: number, y: number) {
  const p = await pt(page, x, y);
  await page.mouse.click(p.x, p.y);
}

export async function dragPt(page: Page, x1: number, y1: number, x2: number, y2: number) {
  const a = await pt(page, x1, y1);
  const b = await pt(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

export async function hoverAt(page: Page, x: number, y: number) {
  const p = await pt(page, x, y);
  await page.mouse.move(p.x, p.y);
}

/** 左の道具を押す。道具のグループが畳んであれば、見出しを押して開いてから押す */
export async function tool(page: Page, id: string) {
  const b = page.locator(`[data-tool="${id}"]`);
  if (!(await b.isVisible())) await page.locator(`.tool-group:has([data-tool="${id}"]) > .tool-group-name`).click();
  await b.click();
}

export async function smiles(page: Page) {
  return (await page.getByTestId('smiles').textContent()) ?? '';
}

/** 画面の操作で描いた doc の原子の座標 */
export async function atoms(page: Page): Promise<{ id: string; x: number; y: number; element: string }[]> {
  return page.evaluate(() => Object.values(window.__editor!.get().doc.atoms).map((a) => ({ id: a.id, x: a.x, y: a.y, element: a.element })));
}

/** RDKit で正規化した SMILES */
export async function canon(page: Page, s: string) {
  return page.evaluate((x) => (window as unknown as { __canon(s: string): string | null }).__canon(x), s);
}

/** 右の欄のタブを開く（ai・scheme・table・analysis・io） */
/** 右の欄の「この文書」に戻る */
export async function goHome(page: Page) {
  for (let i = 0; i < 3 && (await page.getByTestId('side-back').isVisible()); i++) await page.getByTestId('side-back').click();
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'home');
}

/**
 * 右の欄に、スキーム・検討表・分子・読み込みと書き出し・AI の欄を出す（タブは無い）。
 * スキームと検討表は、あれば最初の物、無ければ新しく作る欄
 */
export async function showTab(page: Page, id: 'ai' | 'scheme' | 'table' | 'analysis' | 'io') {
  if (id === 'io') return menuItem(page, 'menu-file', 'SMILES・MOL・CDXML の読み込みと書き出し…');
  if (id === 'ai') return page.getByTestId('open-ai').click();
  await goHome(page);
  if (id === 'scheme') {
    const first = page.getByTestId('home-scheme').first();
    return (await first.count()) ? first.click() : page.getByTestId('new-scheme').click();
  }
  if (id === 'table') {
    const first = page.getByTestId('home-table').first();
    return (await first.count()) ? first.click() : page.getByTestId('new-table').click();
  }
  await page.getByTestId('home-molecules').click();
}

/** 設定のメニューから AI の設定を開く */
export async function openLlmSettings(page: Page) {
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('open-llm-settings').click();
}

/** API キーを入れる（設定のメニューから） */
export async function setApiKey(page: Page, key = 'AIza-test') {
  await openLlmSettings(page);
  await page.getByTestId('llm-key').fill(key);
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
}

/** AI の欄を、作る・直す・書く・仕上げのどれかで開く。直す・書く・仕上げは、スキームの欄の「AI で」から */
export async function openAi(page: Page, mode: 'create' | 'edit' | 'write' | 'finish' = 'create') {
  if (mode === 'create') return page.getByTestId('open-ai').click();
  // スキームの欄が出ていれば、そのまま使う（選んでいる化合物を外さない）
  const view = await page.getByTestId('side-head').getAttribute('data-view');
  if (view === 'ai') await page.getByTestId('side-back').click();
  if ((await page.getByTestId('side-head').getAttribute('data-view')) !== 'scheme') await showTab(page, 'scheme');
  await page.getByTestId(`scheme-ai-${mode}`).click();
}

/** 上のバーのメニュー（menu-file・menu-edit・menu-arrange・menu-help）を開いて、項目を押す */
export async function menuItem(page: Page, menu: string, name: string) {
  await page.getByTestId(menu).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

/** 見本を開く */
export async function openSample(page: Page, id: string) {
  await page.getByTestId('menu-file').click();
  await page.getByTestId(`sample-${id}`).click();
}

/** 読み込みと書き出しの欄で SMILES などを読み込み、もとの欄に戻す */
export async function importSmiles(page: Page, s: string) {
  const back = await page.getByTestId('side-head').getAttribute('data-view');
  await showTab(page, 'io');
  await page.getByTestId('import-text').fill(s);
  await page.getByTestId('import-button').click();
  // 読み込んだ分子は選ばれている。スキーム・検討表の欄に戻すときは一覧から選び直すので、そのあと選択を戻す。
  // ほかの欄では選択を変えない（選び直すと、選んだ物で欄が替わり、次の操作と競い合う）
  const sel = await page.evaluate(() => [...window.__editor!.get().selection]);
  await page.getByTestId('side-back').click();
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'home');
  if (back === 'scheme' || back === 'table' || back === 'analysis' || back === 'io') await showTab(page, back);
  if (back === 'new-scheme') await page.getByTestId('new-scheme').click();
  if (back === 'scheme' || back === 'table') await page.evaluate((ids) => window.__editor!.set({ selection: new Set(ids) }), sel);
  if (back === 'analysis' || back === 'io' || back === 'new-scheme') await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', back);
}

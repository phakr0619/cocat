import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeZip } from '../src/io/zip';
import { menuItem, openSample, showTab, smiles } from './helpers';

// スライドに貼った図を、Cocat で開き直す（docs/reopen-figure.md）。
// コピーでクリップボードに置く HTML の中の PNG・書き出した PNG にデータが入り、pptx・PNG を開くと同じ図に戻る
const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const schemeCount = async (page: Page) => Object.keys((await doc(page)).schemes ?? {}).length;
const hasData = (png: Buffer) => png.includes(Buffer.from('iTXtcocat'));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

/** 「図を画像でコピー」でクリップボードに置いた HTML の中の PNG */
async function copiedPng(page: Page): Promise<Buffer> {
  await menuItem(page, 'menu-edit', '図を画像でコピー');
  await expect(page.locator('.status')).toContainText('図をコピーしました');
  const html = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0];
    return (await item.getType('text/html')).text();
  });
  const m = /src="data:image\/png;base64,([^"]+)"/.exec(html);
  expect(m, 'HTML の中にデータ入りの PNG がある').not.toBeNull();
  return Buffer.from(m![1], 'base64');
}

const rels = (...media: string[]) =>
  `<?xml version="1.0"?><Relationships>${media.map((m, i) => `<Relationship Id="rId${i + 2}" Target="../media/${m}"/>`).join('')}</Relationships>`;

test('コピーした図（HTML の中の PNG）をスライドに貼った pptx を開くと、選ぶ画面から同じ図に戻る。スキームのデータも戻る', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSample(page, 'multistep');
  await expect.poll(() => schemeCount(page)).toBeGreaterThan(0);
  const multiSmiles = await smiles(page);
  const multiSchemes = await schemeCount(page);
  const multiPng = await copiedPng(page);
  expect(hasData(multiPng)).toBe(true);

  await openSample(page, 'aspirin');
  await expect.poll(() => smiles(page)).not.toBe(multiSmiles);
  const aspirinSmiles = await smiles(page);
  const aspirinPng = await copiedPng(page);

  // スライド 1 にアスピリン、スライド 2・3 に 3 段のスキーム（PowerPoint は同じ画像を 1 つにまとめる）、スライド 4 にデータの無い画像
  const plain = readFileSync('tests/llm-eval/images/amide-hatu-acs-200.png');
  const pptx = Buffer.from(
    makeZip([
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels('image2.png') },
      { name: 'ppt/slides/_rels/slide2.xml.rels', data: rels('image1.png') },
      { name: 'ppt/slides/_rels/slide3.xml.rels', data: rels('image1.png') },
      { name: 'ppt/slides/_rels/slide4.xml.rels', data: rels('image3.png') },
      { name: 'ppt/media/image1.png', data: new Uint8Array(multiPng) },
      { name: 'ppt/media/image2.png', data: new Uint8Array(aspirinPng) },
      { name: 'ppt/media/image3.png', data: new Uint8Array(plain) },
    ]),
  );

  await showTab(page, 'io');
  await expect(page.getByTestId('reopen-help')).toContainText('PowerPoint のファイル（.pptx）');
  await page.getByTestId('import-file').setInputFiles({ name: '発表.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: pptx });
  const picker = page.getByTestId('slide-figures');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('slide-figure')).toHaveText(['スライド 1', 'スライド 2・3']);
  await picker.getByTestId('slide-figure').nth(1).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => smiles(page)).toBe(multiSmiles);
  expect(await schemeCount(page)).toBe(multiSchemes);
  // 元に戻すで、開く前の図に戻る
  await page.keyboard.press('Control+z');
  await expect.poll(() => smiles(page)).toBe(aspirinSmiles);
});

test('書き出した PNG にもデータが入り、開き直せる。データの無い PNG・図の無い pptx は理由を出す', async ({ page }) => {
  await openSample(page, 'coupling');
  await expect.poll(() => schemeCount(page)).toBe(1);
  const before = await smiles(page);
  await showTab(page, 'io');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PNG', exact: true }).click()]);
  const png = readFileSync((await dl.path())!);
  expect(hasData(png)).toBe(true);

  // 別の図にしてから、書き出した PNG を開く
  await openSample(page, 'aspirin');
  await expect.poll(() => smiles(page)).not.toBe(before);
  await showTab(page, 'io');
  await page.getByTestId('import-file').setInputFiles({ name: 'coupling.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => smiles(page)).toBe(before);
  expect(await schemeCount(page)).toBe(1);
  await expect(page.getByTestId('io-error')).toHaveCount(0);

  // データの無い PNG（「図として保存」した画像など）
  await page.getByTestId('import-file').setInputFiles({ name: 'saved.png', mimeType: 'image/png', buffer: readFileSync('tests/llm-eval/images/amide-hatu-acs-200.png') });
  await expect(page.getByTestId('io-error')).toContainText('この PNG には Cocat のデータが入っていません');
  await expect(page.getByTestId('io-error')).toContainText('「図として保存」で取り出した画像からは開けない');
  expect(await smiles(page)).toBe(before);

  // Cocat の図が無い pptx
  const empty = Buffer.from(makeZip([{ name: 'ppt/slides/slide1.xml', data: '<p:sld/>' }]));
  await page.getByTestId('import-file').setInputFiles({ name: '空.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: empty });
  await expect(page.getByTestId('io-error')).toContainText('空.pptx の中に、Cocat で作った図が見つかりませんでした');
  expect(await smiles(page)).toBe(before);

  // 「このツールについて」に、図にデータが入ることと入れないものを書く
  await menuItem(page, 'menu-help', 'このツールについて');
  await expect(page.getByTestId('about-figure-data')).toContainText('受け取った人も Cocat で開けます');
  await expect(page.getByTestId('about-figure-data')).toContainText('化合物のメモ、プロジェクトのほかの化合物、化学量論表の量、AI に送った文章は入れません');
});

test('pptx の中の Cocat の図が 1 つだけなら、選ぶ画面を出さずにすぐ開く', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSample(page, 'aspirin');
  const want = await smiles(page);
  const png = await copiedPng(page);
  const pptx = Buffer.from(makeZip([{ name: 'ppt/slides/_rels/slide1.xml.rels', data: rels('image1.png') }, { name: 'ppt/media/image1.png', data: new Uint8Array(png) }]));
  await showTab(page, 'io');
  await page.getByTestId('import-text').fill('CCO');
  await page.getByTestId('import-button').click();
  await expect.poll(() => smiles(page)).not.toBe(want);
  await page.getByTestId('import-file').setInputFiles({ name: 'one.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: pptx });
  await expect.poll(() => smiles(page)).toBe(want);
  await expect(page.getByTestId('slide-figures')).toHaveCount(0);
});

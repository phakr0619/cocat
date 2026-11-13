import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { atoms, canon, clickAt, dragPt, smiles, tool, importSmiles, menuItem, showTab } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);


test('反応スキーム: 矢印・＋・条件の文字を置くと反応 SMILES になる', async ({ page }) => {
  await importSmiles(page, 'CC(=O)O');
  await importSmiles(page, 'OCC');
  const d = await doc(page);
  const xs = Object.values(d.atoms).map((a) => a.x);
  const right = Math.max(...xs);
  // 2つの分子の間に＋、右に矢印と生成物
  const mid = Object.values(d.atoms).filter((a) => a.x < 200);
  await tool(page, 'plus');
  await clickAt(page, Math.max(...mid.map((a) => a.x)) + 14, mid[0].y);
  await tool(page, 'arrow-normal');
  await dragPt(page, right + 20, 100, right + 70, 101);
  const arrow = Object.values((await doc(page)).arrows)[0];
  expect(arrow.y2).toBeCloseTo(arrow.y1, 1);
  await importSmiles(page, 'CCOC(C)=O');
  await tool(page, 'text');
  await clickAt(page, arrow.x1 + 4, arrow.y1 - 6);
  await page.getByTestId('text-input').fill('H2SO4');
  await page.keyboard.press('Enter');
  await clickAt(page, arrow.x1 + 4, arrow.y1 + 14);
  await page.getByTestId('text-input').fill('reflux');
  await page.keyboard.press('Enter');
  expect(Object.values((await doc(page)).texts).map((t) => t.text).sort()).toEqual(['H2SO4', 'reflux']);
  const s = await smiles(page);
  expect(s).toBe(`${await canon(page, 'CC(=O)O')}.${await canon(page, 'CCO')}>>${await canon(page, 'CCOC(C)=O')}`);
  // 平衡・逆合成の矢印に変える（既存の矢印をクリック）
  await tool(page, 'arrow-equilibrium');
  await clickAt(page, (arrow.x1 + arrow.x2) / 2, arrow.y1);
  expect(Object.values((await doc(page)).arrows)[0].kind).toBe('equilibrium');
  await tool(page, 'arrow-retro');
  await clickAt(page, (arrow.x1 + arrow.x2) / 2, arrow.y1);
  expect(Object.values((await doc(page)).arrows)[0].kind).toBe('retro');
});

test('反応 SMILES を読み込むと、＋と矢印を並べて置く', async ({ page }) => {
  await importSmiles(page, 'CC(=O)O.OCC>>CCOC(C)=O');
  const d = await doc(page);
  expect(Object.keys(d.arrows)).toHaveLength(1);
  expect(Object.keys(d.pluses)).toHaveLength(1);
  expect(await smiles(page)).toBe(`${await canon(page, 'CC(=O)O')}.${await canon(page, 'CCO')}>>${await canon(page, 'CCOC(C)=O')}`);
});

test('Clean Structure で形が整い、構造は変わらない', async ({ page }) => {
  await tool(page, 'single');
  await clickAt(page, 50, 80);
  await dragPt(page, 50 + 12.47, 80 - 7.2, 50 + 12.47 + 3, 80 - 7.2 - 14);
  const before = await smiles(page);
  await page.keyboard.press('Control+Shift+K');
  expect(await smiles(page)).toBe(before);
  const d = await doc(page);
  for (const b of Object.values(d.bonds)) {
    const len = Math.hypot(d.atoms[b.a1].x - d.atoms[b.a2].x, d.atoms[b.a1].y - d.atoms[b.a2].y);
    expect(len).toBeCloseTo(14.4, 0);
  }
});

test('整列: 分子と矢印の中心の高さをそろえる', async ({ page }) => {
  await importSmiles(page, 'c1ccccc1');
  await tool(page, 'arrow-normal');
  await clickAt(page, 300, 160);
  await menuItem(page, 'menu-arrange', '横にそろえる');
  const d = await doc(page);
  const ys = Object.values(d.atoms).map((a) => a.y);
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  expect(Object.values(d.arrows)[0].y1).toBeCloseTo(cy, 1);
});

test('書き出し: SMILES・MOL・CDXML・SVG・PNG・CDX をダウンロードでき、CDX は開き直せる', async ({ page }) => {
  await showTab(page, 'io');
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  const expectDownload = async (name: string, check: (body: Buffer) => void) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()]);
    const body = readFileSync((await dl.path())!);
    check(body);
  };
  await expectDownload('SMILES', (b) => expect(b.toString().trim()).toBe('CC(=O)Oc1ccccc1C(=O)O'));
  await expectDownload('MOL', (b) => expect(b.toString()).toContain('V2000'));
  await expectDownload('CDXML', (b) => expect(b.toString()).toContain('<CDXML'));
  await expectDownload('SVG', (b) => expect(b.toString()).toContain('<svg'));
  await expectDownload('PNG', (b) => expect(b.subarray(1, 4).toString()).toBe('PNG'));
  let cdx: Buffer | null = null;
  await expectDownload('CDX', (b) => {
    expect(b.subarray(0, 8).toString()).toBe('VjCD0100');
    cdx = b;
  });
  // 書き出した CDX を「ファイルを開く」で読み直すと、同じ分子がもう 1 つ増える
  await page.getByTestId('import-file').setInputFiles({ name: 'aspirin.cdx', mimeType: 'chemical/x-cdx', buffer: cdx! });
  await expect.poll(() => smiles(page)).toBe('CC(=O)Oc1ccccc1C(=O)O.CC(=O)Oc1ccccc1C(=O)O');
});

test('CDXML のファイルを開ける', async ({ page }) => {
  await page.getByTestId('import-file').setInputFiles({
    name: 'x.cdxml',
    mimeType: 'chemical/x-cdxml',
    buffer: Buffer.from(
      '<?xml version="1.0"?><CDXML><page id="1"><fragment id="2"><n id="3" p="100 100"/><n id="4" p="112.47 92.8" Element="8"/><b id="5" B="3" E="4" Order="2"/></fragment>' +
        '<graphic id="6" BoundingBox="200 100 150 100" GraphicType="Line" ArrowType="FullHead"/><t id="7" p="150 90"><s>heat</s></t></page></CDXML>',
    ),
  });
  // ファイルの読み込みは非同期なので、反映を待つ
  await expect.poll(async () => (await atoms(page)).length).toBe(2);
  const d = await doc(page);
  expect(Object.values(d.arrows)[0].x2).toBeGreaterThan(Object.values(d.arrows)[0].x1);
  expect(Object.values(d.texts)[0].text).toBe('heat');
});

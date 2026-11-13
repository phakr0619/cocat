import { expect, test, type Page } from '@playwright/test';
import { clickAt, hoverAt, tool, importSmiles, showTab } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const tableTexts = async (page: Page) => {
  const d = await doc(page);
  const tid = Object.keys(d.tables ?? {})[0];
  return Object.values(d.texts).filter((t) => t.ref === tid).map((t) => t.text);
};

test('反応式から条件検討の表を作り、入力・貼り付け・CSV・行から反応式を作る', async ({ page }) => {
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  await showTab(page, 'scheme');
  await page.getByTestId('scheme-panel').getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await showTab(page, 'table');
  const panel = page.getByTestId('table-panel');
  await panel.getByTestId('new-conditions-table').click();
  await expect(panel.getByTestId('table-row')).toHaveCount(3);
  await expect.poll(() => tableTexts(page)).toEqual(expect.arrayContaining(['Table 1.', 'entry', 'yield (%)ᵃ', 'ᵃIsolated yield.']));

  // セルに入れる
  await panel.getByTestId('cell-reagent').first().fill('HATU (1.2)');
  await panel.getByTestId('cell-solvent').first().fill('DMF');
  await panel.getByTestId('cell-yield').first().fill('72');
  await panel.getByTestId('cell-yield').first().press('Enter');
  await expect.poll(() => tableTexts(page)).toEqual(expect.arrayContaining(['HATU (1.2)', 'DMF', '72']));

  // Excel から貼り付け（見出しつき）
  await panel.getByText('Excel から貼り付け').click();
  await panel.getByTestId('table-paste').fill('reagent (equiv)\tsolvent\ttemp (°C)\tyield (%)\nEDC·HCl (1.2), HOBt (1.2)\tCH2Cl2\trt\t85\nT3P (1.5)\tEtOAc\t0\t64');
  await panel.getByTestId('table-paste-apply').click();
  await expect.poll(() => tableTexts(page)).toEqual(expect.arrayContaining(['EDC·HCl (1.2), HOBt (1.2)', 'T3P (1.5)', '85', '64']));
  await expect(panel.getByTestId('table-row')).toHaveCount(3);

  // 列を足す・注を足す
  await panel.getByTestId('add-column').selectOption('ratio');
  await panel.getByText('列の見出し・単位・注の記号').click();
  await panel.getByTestId('column-label').last().fill('dr');
  await panel.getByTestId('column-label').last().press('Enter');
  await expect.poll(() => tableTexts(page)).toContain('dr');
  await panel.getByTestId('table-notes').fill('Isolated yield.\nDetermined by 1H NMR.');
  await panel.getByTestId('table-notes').blur();
  await expect.poll(() => tableTexts(page)).toContain('ᵇDetermined by 1H NMR.');

  // CSV で保存
  const dl = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'CSV' }).click();
  const file = await (await dl).createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of file) chunks.push(c as Buffer);
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('entry,reagent (equiv),solvent,temp (°C),time (h),workup,purification,yield (%)ᵃ,dr');
  expect(csv).toContain('2,"EDC·HCl (1.2), HOBt (1.2)",CH2Cl2,rt,,,,85,');

  // セルの注の記号（「64^b」→ 64ᵇ）と、Excel（.xlsx）で保存
  await panel.getByTestId('cell-yield').nth(2).fill('64^b');
  await panel.getByTestId('cell-yield').nth(2).press('Enter');
  await expect.poll(() => tableTexts(page)).toContain('64ᵇ');
  const dl2 = page.waitForEvent('download');
  await panel.getByTestId('table-xlsx').click();
  const x = await dl2;
  expect(x.suggestedFilename()).toBe('table-1.xlsx');
  const parts: Buffer[] = [];
  for await (const c of await x.createReadStream()) parts.push(c as Buffer);
  const xlsx = Buffer.concat(parts);
  expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  expect(xlsx.toString('utf8')).toContain('<t xml:space="preserve">64ᵇ</t>');

  // 2行目の条件で反応式を作る
  await panel.getByTestId('row-to-scheme').nth(1).click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(2);
  const d = await doc(page);
  const sid = Object.keys(d.schemes!)[1];
  expect(Object.values(d.texts).filter((t) => t.ref === sid).map((t) => t.text)).toEqual(['EDC·HCl 1.2 equiv', 'HOBt 1.2 equiv', 'CH2Cl2, rt', '85%']);
});

test('R1 を付けた分子から SAR の表を作り、置換基を構造で描く', async ({ page }) => {
  await importSmiles(page, 'CC(=O)Nc1ccc(C)cc1');
  // 末端のメチル（結合1本の炭素）2つに R1・R2 のラベルを付ける
  const d0 = await doc(page);
  const degree = (id: string) => Object.values(d0.bonds).filter((b) => b.a1 === id || b.a2 === id).length;
  const ends = Object.values(d0.atoms).filter((a) => a.element === 'C' && degree(a.id) === 1);
  for (const [i, a] of ends.entries()) {
    await hoverAt(page, a.x, a.y);
    await page.keyboard.press('Enter');
    await page.getByTestId('label-input').fill(`R${i + 1}`);
    await page.getByTestId('label-input').press('Enter');
  }
  await expect.poll(async () => Object.values((await doc(page)).atoms).filter((a) => a.abbr?.startsWith('R')).length).toBe(2);

  await tool(page, 'select');
  await clickAt(page, ends[0].x, ends[0].y);
  await showTab(page, 'table');
  const panel = page.getByTestId('table-panel');
  await panel.getByTestId('new-sar-table').click();
  await expect.poll(async () => {
    const d = await doc(page);
    const tid = Object.keys(d.tables ?? {})[0];
    return Object.values(d.atoms).filter((a) => a.ref === `${tid}:core`).length;
  }).toBe(11);

  await panel.getByTestId('cell-structure').first().fill('*c1ccc(OC)cc1');
  await panel.getByTestId('cell-structure').nth(1).fill('Me');
  await panel.getByTestId('cell-number').first().fill('12');
  await panel.getByTestId('cell-number').first().press('Enter');
  await expect.poll(async () => {
    const d = await doc(page);
    const tid = Object.keys(d.tables ?? {})[0];
    return Object.values(d.atoms).filter((a) => a.ref === `${tid}:cell`).length;
  }).toBe(9);
  await expect.poll(() => tableTexts(page)).toEqual(expect.arrayContaining(['Table 1.', 'R1', 'R2', 'IC50 (nM)', 'Me', '12']));
});

test('反応スキームが無いときの「＋条件検討の表」は、表だけと知らせ、2つ目は1つ目の下に置く', async ({ page }) => {
  await showTab(page, 'table');
  const panel = page.getByTestId('table-panel');
  await panel.getByTestId('new-conditions-table').click();
  await expect(page.locator('.status')).toContainText('反応スキームが無いので、表だけを作りました');
  await panel.getByTestId('new-conditions-table').click();
  const ys = await page.evaluate(() => {
    const d = window.__editor!.get().doc;
    return Object.keys(d.tables!).map((tid) => {
      const rules = Object.values(d.arrows).filter((r) => r.ref === tid).map((r) => r.y1);
      return [Math.min(...rules), Math.max(...rules)];
    });
  });
  expect(ys).toHaveLength(2);
  expect(ys[1][0]).toBeGreaterThan(ys[0][1]);
});

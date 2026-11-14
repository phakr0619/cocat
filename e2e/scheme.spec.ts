import { expect, test, type Page } from '@playwright/test';
import { canon, clickAt, hoverAt, pt, smiles, tool, importSmiles, menuItem, openSample, showTab } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  await showTab(page, 'scheme');
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);
const texts = async (page: Page) => Object.values((await doc(page)).texts).map((t) => t.text);

/** 自由な（スキームでない）分子のうち、i 番目の最初の原子をクリックして選ぶ */
async function selectFree(page: Page, i: number) {
  const d = await doc(page);
  const free = Object.values(d.atoms).filter((a) => !a.ref);
  // 読み込んだ順に原子の id が増えるので、分子ごとの最初の原子を拾う
  const firsts: typeof free = [];
  const seen = new Set<number>();
  for (const a of free) {
    const group = Math.round(a.x / 200);
    if (!seen.has(group)) {
      seen.add(group);
      firsts.push(a);
    }
  }
  await tool(page, 'select');
  await page.keyboard.press('Escape');
  await clickAt(page, firsts[i].x, firsts[i].y);
}

test('分子を選んでスキームを組み立て、条件・番号・書式を入れる', async ({ page }) => {
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O');
  await importSmiles(page, 'NCC(=O)OC');
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  await page.keyboard.press('Escape');
  const panel = page.getByTestId('scheme-panel');

  await selectFree(page, 0);
  await panel.getByRole('button', { name: '選んだ分子からスキームを始める' }).click();
  await selectFree(page, 0);
  await panel.getByRole('button', { name: '＋基質' }).click();
  await selectFree(page, 0);
  await panel.getByTestId('add-step').click();
  await expect(panel.getByTestId('scheme-step')).toHaveCount(1);

  await panel.getByTestId('step-reagents').fill('EDC·HCl (1.2 equiv), HOBt (1.2 equiv)');
  await panel.getByTestId('step-solvent').fill('CH2Cl2');
  await panel.getByTestId('step-temp').fill('rt');
  await panel.getByTestId('step-yield').fill('85');
  await panel.getByTestId('step-yield').press('Enter');
  await expect.poll(() => texts(page)).toEqual(expect.arrayContaining(['EDC·HCl 1.2 equiv', 'HOBt 1.2 equiv', 'CH2Cl2, rt', '85%']));

  await panel.getByRole('button', { name: '番号を振る' }).click();
  await expect(panel.getByTestId('compound-number')).toHaveCount(3);
  await expect(panel.getByTestId('compound-number').first()).toHaveValue('1');
  await panel.getByTestId('compound-nickname').nth(2).fill('ジペプチド');
  await panel.getByTestId('compound-nickname').nth(2).press('Enter');

  await panel.getByTestId('scheme-style').selectOption('footnote');
  await expect.poll(async () => (await texts(page)).join(' ')).toContain('Reagents and conditions: (a) EDC·HCl 1.2 equiv, HOBt 1.2 equiv, CH2Cl2, rt, 85%.');

  const [reac, , prod] = (await smiles(page)).split('>');
  expect(reac.split('.').sort()).toEqual([await canon(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O'), await canon(page, 'NCC(=O)OC')].sort());
  expect(prod).toBe(await canon(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC'));
  await page.mouse.move(2, 2);
  await page.screenshot({ path: 'test-results/scheme-panel.png' });
});

test('スキームの中の分子をキャンバスで直すと、化合物のデータも直る', async ({ page }) => {
  await importSmiles(page, 'CCO>>CC=O');
  await page.keyboard.press('Escape');
  await page.getByTestId('scheme-panel').getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  const d = await doc(page);
  const s = Object.values(d.schemes!)[0];
  expect(s.steps).toHaveLength(1);
  // 生成物の O を N に変える
  const o = Object.values(d.atoms).find((a) => a.ref === `${s.id}:${s.steps[0].to[0]}` && a.element === 'O')!;
  await hoverAt(page, o.x, o.y);
  await page.keyboard.press('n');
  await expect.poll(async () => {
    const d2 = await doc(page);
    return Object.values(d2.compounds![s.steps[0].to[0]].structure.atoms).map((a) => a.element).sort().join('');
  }).toBe('CCN');
  expect(await smiles(page)).toBe(`${await canon(page, 'CCO')}>>${await canon(page, 'CC=N')}`);
});

test('書式を画面で直し、自分のテンプレートに保存して次の文書でも使える', async ({ page }) => {
  await importSmiles(page, 'CC(=O)O.OCC>>CCOC(C)=O');
  await page.keyboard.press('Escape');
  const panel = page.getByTestId('scheme-panel');
  await panel.getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await panel.getByTestId('step-reagents').fill('H2SO4 (0.1 equiv)');
  await panel.getByTestId('step-reagents').press('Enter');
  await panel.getByTestId('step-solvent').fill('toluene');
  await panel.getByTestId('step-solvent').press('Enter');

  await panel.getByText('書式を編集').click();
  await panel.getByTestId('style-equiv').selectOption('({n} eq.)');
  await expect.poll(() => texts(page)).toContain('H2SO4 (0.1 eq.)');
  await panel.getByTestId('style-place-solvent').selectOption('above');
  await expect.poll(() => texts(page)).toContain('H2SO4 (0.1 eq.), toluene');
  await expect(panel.getByTestId('scheme-style')).toHaveValue(/^custom-/);

  await panel.getByTestId('style-name').fill('私の書式');
  await panel.getByRole('button', { name: '自分のテンプレートに保存' }).click();

  // 新しい文書で、保存したテンプレートを選ぶ
  await menuItem(page, 'menu-file', '新規');
  await importSmiles(page, 'CO>>C=O');
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await panel.getByTestId('step-reagents').fill('PCC (1.5 equiv)');
  await panel.getByTestId('step-reagents').press('Enter');
  await panel.getByTestId('scheme-style').selectOption({ label: '私の書式' });
  await expect.poll(() => texts(page)).toContain('PCC (1.5 eq.)');
});

test('分子をドラッグして、スキームの矢印（基質）と右端（次の段の生成物）へ入れる', async ({ page }) => {
  await importSmiles(page, 'CCO>>CC=O');
  await page.keyboard.press('Escape');
  const panel = page.getByTestId('scheme-panel');
  await panel.getByRole('button', { name: '描いた反応式をスキームにする' }).click();

  const dragWhole = async (smi: string, to: (d: Awaited<ReturnType<typeof doc>>) => { x: number; y: number }) => {
    await importSmiles(page, smi);
    await tool(page, 'select');
    const d = await doc(page);
    // 読み込んだ分子は選ばれた状態。その原子をつかんで動かす
    const sel = await page.evaluate(() => [...window.__editor!.get().selection]);
    const a = d.atoms[sel.find((id) => id.startsWith('a'))!];
    const target = to(d);
    const p = await pt(page, a.x, a.y);
    const q = await pt(page, target.x, target.y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
    await page.mouse.move(q.x, q.y, { steps: 4 });
    await expect(page.locator('.preview text')).toHaveCount(1);
    await page.mouse.up();
  };

  // 矢印の上へ: 段 1 の基質
  await dragWhole('OC(C)=O', (d) => {
    const r = Object.values(d.arrows).find((x) => x.ref)!;
    return { x: (r.x1 + r.x2) / 2, y: r.y1 };
  });
  await expect.poll(async () => (await smiles(page)).split('>')[0].split('.').length).toBe(2);

  // 右端の先へ: 生成物として段を足す
  await dragWhole('CC(O)=O', (d) => {
    const r = Object.values(d.arrows).find((x) => x.ref)!;
    const xs = Object.values(d.atoms).filter((a) => a.ref).map((a) => a.x);
    return { x: Math.max(...xs) + 30, y: r.y1 };
  });
  await expect.poll(async () => Object.values((await doc(page)).arrows).filter((r) => r.ref).length).toBe(2);
  expect((await smiles(page)).split('\n')).toHaveLength(2);
});

test('化学量論表: 基質の量を入れると、試薬の量と理論収量が出る', async ({ page }) => {
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O>>N[C@@H](C)C(=O)O');
  await page.keyboard.press('Escape');
  const panel = page.getByTestId('scheme-panel');
  await panel.getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await panel.getByTestId('step-reagents').fill('TFA (10 equiv)');
  await panel.getByTestId('step-reagents').press('Enter');
  await panel.getByText('化学量論表').click();
  await panel.getByTestId('stoich-scale').fill('189.21');
  const table = panel.getByTestId('stoich-table');
  // Boc-Ala-OH 189.21 → 1.000 mmol、TFA 10 当量 → 10.000 mmol・1140.2 mg・765.7 µL、Ala（89.09）の理論収量 89.1 mg
  await expect(table.locator('tbody tr').nth(0)).toContainText('1.000');
  await expect(table.locator('tbody tr').nth(1)).toContainText('10.000');
  await expect(table.locator('tbody tr').nth(1)).toContainText('1140.2');
  await expect(table.locator('tbody tr').nth(1)).toContainText('765.7');
  await expect(table.locator('tbody tr').nth(2)).toContainText('89.1');
});

test('スキームを複製して、条件だけ変える', async ({ page }) => {
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  const panel = page.getByTestId('scheme-panel');
  await panel.getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await panel.getByTestId('duplicate-scheme').click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(2);
  // 複製の分子を選ぶと、複製のスキームの欄になる
  const d = await doc(page);
  const copy = Object.keys(d.schemes!)[1];
  const atom = Object.values(d.atoms).find((a) => a.ref?.startsWith(`${copy}:`))!;
  await tool(page, 'select');
  await clickAt(page, atom.x, atom.y);
  await panel.getByTestId('step-solvent').fill('DMF');
  await panel.getByTestId('step-solvent').press('Enter');
  await expect.poll(async () => Object.values((await doc(page)).texts).filter((t) => t.ref === copy).map((t) => t.text)).toContain('DMF');
  expect(Object.values((await doc(page)).texts).some((t) => t.text === 'DMF' && t.ref !== copy)).toBe(false);
});

test('スキームを固定すると、共有する化合物の番号を直しても図は変わらず、固定を外すと描き直す', async ({ page }) => {
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  const panel = page.getByTestId('scheme-panel');
  await panel.getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  await panel.getByTestId('duplicate-scheme').click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(2);
  const [first, copy] = Object.keys((await doc(page)).schemes!);
  // 最初のスキームを選んで固定する
  const atom = Object.values((await doc(page)).atoms).find((a) => a.ref?.startsWith(`${first}:`))!;
  await tool(page, 'select');
  await clickAt(page, atom.x, atom.y);
  await panel.getByTestId('pin-scheme').click();
  await expect(panel.getByTestId('scheme-pinned')).toContainText('固定中');
  await expect(panel.getByTestId('compound-number').first()).toBeDisabled();
  await expect(page.getByTestId('pin-scheme')).toHaveCount(0);
  // 複製の側で番号を付けると、複製にだけ出る
  const atom2 = Object.values((await doc(page)).atoms).find((a) => a.ref?.startsWith(`${copy}:`))!;
  await clickAt(page, atom2.x, atom2.y);
  await expect(panel.getByTestId('scheme-pinned')).toHaveCount(0);
  await panel.getByTestId('compound-number').first().fill('9');
  await panel.getByTestId('compound-number').first().press('Enter');
  const refsOf9 = async () => Object.values((await doc(page)).texts).filter((t) => t.text === '9').map((t) => t.ref);
  await expect.poll(refsOf9).toEqual([copy]);
  // 固定を外すと、今の番号で描き直す
  const atom3 = Object.values((await doc(page)).atoms).find((a) => a.ref?.startsWith(`${first}:`))!;
  await clickAt(page, atom3.x, atom3.y);
  await panel.getByTestId('unpin-scheme').click();
  await expect.poll(async () => (await refsOf9()).sort()).toEqual([copy, first].sort());
  await expect(panel.getByTestId('compound-number').first()).toBeEnabled();
});

test('行の折り返し位置: 「矢印の後」にすると、行の右端が矢印になり、次の行は化合物から始まる。どちらか 1 つは外せない', async ({ page }) => {
  await openSample(page, 'multistep');
  await expect(page.getByTestId('scheme-panel')).toBeVisible();
  /** 1 行目の右端が矢印か化合物か */
  const firstRowEnd = () =>
    page.evaluate(() => {
      const d = window.__editor!.get().doc;
      const sid = Object.keys(d.schemes!)[0];
      const arrows = Object.values(d.arrows).filter((a) => a.ref === sid);
      const top = Math.min(...arrows.map((a) => a.y1));
      const rowArrows = arrows.filter((a) => Math.abs(a.y1 - top) < 5);
      const rowAtoms = Object.values(d.atoms).filter((a) => a.ref?.startsWith(`${sid}:`) && Math.abs(a.y - top) < 40);
      const arrowRight = Math.max(...rowArrows.map((a) => Math.max(a.x1, a.x2)));
      const atomRight = Math.max(...rowAtoms.map((a) => a.x));
      return { end: arrowRight > atomRight ? 'arrow' : 'compound', rows: new Set(arrows.map((a) => Math.round(a.y1))).size };
    });
  const before = await firstRowEnd();
  expect(before).toEqual({ end: 'compound', rows: expect.any(Number) });
  expect(before.rows).toBeGreaterThan(1);

  await page.getByText('書式を編集').click();
  const wrap = page.getByTestId('style-wrap-at');
  await expect(wrap.getByTestId('style-wrap-arrow')).not.toBeChecked();
  await expect(wrap.getByTestId('style-wrap-compound')).toBeChecked();
  // 最後の 1 つは外せない
  await expect(wrap.getByTestId('style-wrap-compound')).toBeDisabled();
  await wrap.getByTestId('style-wrap-arrow').check();
  await wrap.getByTestId('style-wrap-compound').uncheck();
  await expect(wrap.getByTestId('style-wrap-arrow')).toBeDisabled();
  expect((await firstRowEnd()).end).toBe('arrow');
});

test('ページの設定があるときは、スキームの行の幅をページに合わせる', async ({ page }) => {
  await openSample(page, 'multistep');
  const rows = () => page.evaluate(() => {
    const d = window.__editor!.get().doc;
    return new Set(Object.values(d.arrows).map((a) => Math.round(a.y1))).size;
  });
  const narrow = await rows();
  // 横長のスライド 2 枚分なら、行の幅が広がって 1 行に収まる
  await menuItem(page, 'menu-settings', 'ページの設定…');
  const dlg = page.getByTestId('page-setup');
  await dlg.getByTestId('page-size').selectOption('slide16x9');
  await dlg.getByTestId('page-cols').fill('2');
  await dlg.getByTestId('page-apply').click();
  expect(await rows()).toBeLessThan(narrow);
  await page.getByText('書式を編集').click();
  await expect(page.getByTestId('style-page-width')).toBeVisible();
});

// ---- 図の上で直す ----
/** スキームの物（矢印・文字）の画面の座標 */
async function screenOf(page: import('@playwright/test').Page, pick: 'arrow' | { text: string }, nth = 0) {
  return page.evaluate(
    ({ pick, nth }) => {
      const d = window.__editor!.get().doc;
      const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
      const vb = svg.viewBox.baseVal;
      const r = svg.getBoundingClientRect();
      const zoom = svg.clientWidth / vb.width;
      const to = (x: number, y: number) => ({ x: r.left + (x - vb.x) * zoom, y: r.top + (y - vb.y) * zoom });
      if (pick === 'arrow') {
        const a = Object.values(d.arrows).filter((x) => x.ref)[nth];
        return to((a.x1 + a.x2) / 2, a.y1);
      }
      const t = Object.values(d.texts).filter((x) => x.text === pick.text)[nth];
      return to(t.x + 2, t.y - 3);
    },
    { pick, nth },
  );
}

test('図の上で直す: 矢印をダブルクリックすると、そばに条件の欄が出て、右の欄を使わずに収率を直せる', async ({ page }) => {
  await openSample(page, 'multistep');
  // 右の欄を畳んでいても直せる
  await page.getByTestId('side-collapse').click();
  const at = await screenOf(page, 'arrow', 2);
  await page.mouse.dblclick(at.x, at.y);
  const pop = page.getByTestId('step-pop');
  await expect(pop).toContainText('段 3');
  await expect(pop.getByTestId('pop-yield')).toHaveValue('92');
  await pop.getByTestId('pop-yield').fill('95');
  await pop.getByTestId('pop-yield').press('Enter');
  expect(await page.evaluate(() => Object.values(window.__editor!.get().doc.schemes!)[0].steps[2].yield)).toBe(95);
  // 図の文字も変わる
  expect(await page.evaluate(() => Object.values(window.__editor!.get().doc.texts).some((t) => t.text === '95%'))).toBe(true);
  // 続けてほかの欄も直せる（描き直しても欄は閉じない）
  await pop.getByTestId('pop-solvent').fill('MeOH/H2O');
  await pop.getByTestId('pop-solvent').press('Enter');
  expect(await page.evaluate(() => Object.values(window.__editor!.get().doc.schemes!)[0].steps[2].solvent)).toBe('MeOH/H2O');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
});

test('図の上で直す: 条件の文字はその段の欄を、番号の文字は番号と呼び名の欄を出す', async ({ page }) => {
  await openSample(page, 'multistep');
  const tfa = await screenOf(page, { text: 'TFA' });
  await page.mouse.dblclick(tfa.x, tfa.y);
  await expect(page.getByTestId('step-pop')).toContainText('段 2');
  await expect(page.getByTestId('text-input')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const four = await screenOf(page, { text: '4' });
  await page.mouse.dblclick(four.x, four.y);
  const pop = page.getByTestId('compound-pop');
  await expect(pop.getByTestId('pop-number')).toHaveValue('4');
  await pop.getByTestId('pop-number').fill('4a');
  await pop.getByTestId('pop-number').press('Enter');
  await pop.getByTestId('pop-nickname').fill('アミン');
  await pop.getByTestId('pop-nickname').press('Enter');
  const c = await page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const s = Object.values(d.schemes!)[0];
    return d.compounds![s.steps[1].to[0]];
  });
  expect(c.number).toBe('4a');
  expect(c.nickname).toBe('アミン');
});

test('次の段: スキームの右端の「＋ 次の段」から、SMILES で生成物を足せる', async ({ page }) => {
  await openSample(page, 'coupling');
  await page.getByTestId('next-step').click();
  await page.getByTestId('next-step-text').fill('C[C@H](N)C(=O)NCC(=O)OC');
  await page.getByTestId('next-step-add').click();
  await expect(page.getByTestId('scheme-step')).toHaveCount(2);
  expect(await page.evaluate(() => Object.values(window.__editor!.get().doc.schemes!)[0].steps.length)).toBe(2);
});

test('右の欄の段: 3 段からは 1 行にまとめ、キャンバスで選んだ段だけを開く', async ({ page }) => {
  await openSample(page, 'multistep');
  const steps = page.getByTestId('scheme-step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(1).getByTestId('step-summary')).toContainText('TFA / CH2Cl2, 0 °C to rt, 1 h');
  await expect(steps.nth(1).getByTestId('step-summary')).toContainText('quant.');
  await expect(steps.nth(1).getByTestId('step-yield')).toBeHidden();
  // 行を押すと開く
  await steps.nth(1).getByTestId('step-summary').click();
  await expect(steps.nth(1).getByTestId('step-yield')).toBeVisible();
  // キャンバスで 3 段目の矢印を選ぶと、3 段目が開く
  await tool(page, 'select');
  const at = await screenOf(page, 'arrow', 2);
  await page.mouse.click(at.x, at.y);
  await expect(steps.nth(2).getByTestId('step-yield')).toBeVisible();
  await expect(steps.nth(2)).toHaveClass(/active/);
});

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { canon, importSmiles, menuItem, openSample, showTab, tool } from './helpers';

// 画面の使い勝手: タブ・メニュー・はじめに・何も無いときの案内・化合物の小さな絵・検討表の行のドラッグ
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

test('何も描いていないときだけ案内を出し、案内はキャンバスのクリックを邪魔しない', async ({ page }) => {
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  await expect(page.getByTestId('empty-hint')).toHaveCSS('pointer-events', 'none');
  await importSmiles(page, 'c1ccccc1');
  await expect(page.getByTestId('empty-hint')).toHaveCount(0);
  await menuItem(page, 'menu-file', '新規');
  await expect(page.getByTestId('empty-hint')).toBeVisible();
});

test('右の欄は、何も選んでいなければ「この文書」。押した物の欄を出し、見本を開くと中身に合う欄を出す', async ({ page }) => {
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'home');
  await expect(page.getByTestId('side-home')).toBeVisible();
  await expect(page.getByTestId('tts')).toBeHidden();
  await expect(page.getByTestId('scheme-panel')).toBeHidden();
  await showTab(page, 'analysis');
  await expect(page.getByTestId('analysis')).toBeVisible();
  await expect(page.getByTestId('side-home')).toBeHidden();
  await page.getByTestId('side-back').click();
  await expect(page.getByTestId('side-home')).toBeVisible();
  // 見本を開くと、中身に合う欄を出す。「この文書」には、スキームと検討表を 1 つずつ並べる
  await openSample(page, 'conditions');
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'table');
  await page.getByTestId('side-back').click();
  await expect(page.getByTestId('home-table')).toHaveCount(1);
  await expect(page.getByTestId('home-scheme')).toHaveCount(1);
  // スキームの行には、最初の基質と最後の生成物の小さな絵を出す
  await expect(page.getByTestId('home-scheme').locator('.thumb')).toHaveCount(2);
  // 一覧のスキームを押すと、そのスキームの欄になる（分子は選ばない）
  await page.getByTestId('home-scheme').click();
  await expect(page.getByTestId('scheme-panel')).toBeVisible();
  const sel = await page.evaluate(() => [...window.__editor!.get().selection]);
  expect(sel.length).toBeGreaterThan(0);
  expect(sel.every((id) => !id.startsWith('a'))).toBe(true);
});

test('何も描いていないときは、キャンバスに 3 つの入口を出す。AI の入口は、キーが無ければ AI の設定を開く', async ({ page }) => {
  const w = page.getByTestId('welcome');
  await expect(w).toBeVisible();
  await w.getByRole('button', { name: '反応スキーム' }).click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(1);
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'scheme');
  await menuItem(page, 'menu-file', '新規');
  await page.getByTestId('entry-ai').click();
  await expect(page.getByTestId('llm-settings')).toBeVisible();
});

test('「＋ 反応スキーム」で、何も無いところからスキームを始められる。スキームがあっても新しく始める', async ({ page }) => {
  await openSample(page, 'coupling');
  await page.getByTestId('side-back').click();
  await page.getByTestId('new-scheme').click();
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'new-scheme');
  const panel = page.getByTestId('scheme-panel');
  await expect(panel.getByRole('button', { name: '描いた反応式をスキームにする' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '選んだ分子からスキームを始める' })).toBeDisabled();
  // 分子を選ぶと、そこから始められる（欄は替わらない）
  await importSmiles(page, 'c1ccccc1');
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'new-scheme');
  await panel.getByRole('button', { name: '選んだ分子からスキームを始める' }).click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(2);
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'scheme');
});

test('分子と矢印を描くと、キャンバスの上に「スキームにする」を出す。押すとスキームになり、閉じれば出さない', async ({ page }) => {
  await importSmiles(page, 'CCO>>CC=O');
  const bar = page.getByTestId('from-drawing');
  await expect(bar).toBeVisible();
  await bar.getByTestId('from-drawing-close').click();
  await expect(bar).toHaveCount(0);
  await menuItem(page, 'menu-file', '新規');
  await importSmiles(page, 'CCO>>CC=O');
  await expect(bar).toBeVisible();
  await bar.getByTestId('from-drawing-apply').click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(1);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'scheme');
  await expect(page.getByTestId('scheme-panel').getByTestId('scheme-step')).toBeVisible();
});

test('上のバーのメニューは、押すと開き、外を押すか Esc で閉じる。項目にキーの操作を出す', async ({ page }) => {
  await page.getByTestId('menu-edit').click();
  const list = page.getByRole('menu', { name: '編集' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('menuitem', { name: 'コピー', exact: true })).toContainText('Ctrl+C');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await page.getByTestId('menu-arrange').click();
  await expect(page.getByRole('menu', { name: '整える' })).toBeVisible();
  await page.getByTestId('canvas').click({ position: { x: 400, y: 400 } });
  await expect(page.getByRole('menu', { name: '整える' })).toHaveCount(0);
  // キーの操作の一覧
  await menuItem(page, 'menu-help', 'キーの操作の一覧');
  await expect(page.getByTestId('shortcuts')).toContainText('Clean Structure');
  await page.getByTestId('shortcuts').getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByTestId('shortcuts')).toHaveCount(0);
});

test('ライブラリの列は、はじめは閉じていて、開くと次も開いた状態で始まる。開け閉めのボタンは左の道具の列のいちばん下にある', async ({ page }) => {
  await expect(page.getByTestId('library')).toHaveCount(0);
  const tab = page.getByTestId('toggle-library');
  await expect(page.locator('.topbar [data-testid=toggle-library]')).toHaveCount(0);
  await expect(page.locator('.tools [data-testid=toggle-library]')).toBeVisible();
  // 道具をすべて開いて列が長くなっても、ボタンは列の下に見えている
  for (const g of ['図形', '機構']) await page.getByTestId(`tool-group-${g}`).click();
  const tools = (await page.locator('.tools').boundingBox())!;
  const at = (await tab.boundingBox())!;
  expect(at.y + at.height).toBeLessThanOrEqual(tools.y + tools.height + 1);
  expect(at.y + at.height).toBeGreaterThan(tools.y + tools.height - 20);
  await expect(tab).toHaveAccessibleName('ライブラリを開く');
  await tab.click();
  await expect(page.getByTestId('library')).toBeVisible();
  await expect(tab).toHaveAccessibleName('ライブラリを閉じる');
  await page.reload();
  await expect(page.getByTestId('library')).toBeVisible();
});

test('左の道具のグループは見出しで畳む・開く。はじめは図形と機構を畳み、畳んだ状態は再読み込みしても覚えている', async ({ page }) => {
  const head = (name: string) => page.getByTestId(`tool-group-${name}`);
  // はじめの状態: 選択・結合・環・反応は開き、図形・機構は畳む
  for (const name of ['選択', '結合', '環', '反応']) await expect(head(name)).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['図形', '機構']) await expect(head(name)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-tool="rect"]')).toBeHidden();
  await expect(page.locator('[data-tool="arrow-curved"]')).toBeHidden();
  await expect(page.locator('[data-tool="single"]')).toBeVisible();
  // 見出しはボタンで、押すと開く・畳む
  await expect(head('図形')).toHaveRole('button');
  await head('図形').click();
  await expect(head('図形')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-tool="rect"]')).toBeVisible();
  await head('環').click();
  await expect(head('環')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-tool="benzene"]')).toBeHidden();
  // 雛形のボタンも環と一緒に隠れる
  await expect(page.getByTestId('open-templates')).toBeHidden();
  // 再読み込みしても覚えている
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  await expect(head('図形')).toHaveAttribute('aria-expanded', 'true');
  await expect(head('環')).toHaveAttribute('aria-expanded', 'false');
  await expect(head('機構')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-tool="benzene"]')).toBeHidden();
  await expect(page.locator('[data-tool="rect"]')).toBeVisible();
});

test('畳んだグループの道具を選んでいるときは、見出しにその道具を出す', async ({ page }) => {
  const head = page.getByTestId('tool-group-機構');
  // 畳んだグループの道具も、開いてから選べる（e2e の tool は見出しを押して開く）
  await tool(page, 'arrow-curved');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(head.getByTestId('tool-group-active')).toHaveCount(0);
  // 選んだまま畳むと、見出しに選んでいる道具を出す
  await head.click();
  await expect(page.locator('[data-tool="arrow-curved"]')).toBeHidden();
  await expect(head).toHaveClass(/has-active/);
  await expect(head.getByTestId('tool-group-active').locator('svg.tool-icon')).toHaveCount(1);
  await expect(head).toHaveAttribute('title', /選んでいる道具: 電子の動き/);
  // 道具は選んだまま
  expect(await page.evaluate(() => window.__editor!.get().tool)).toBe('arrow-curved');
  // ほかの道具に替えると、印は消える
  await tool(page, 'single');
  await expect(head).not.toHaveClass(/has-active/);
  await expect(head.getByTestId('tool-group-active')).toHaveCount(0);
});

test('ブラウザに覚えさせられないときも、道具のグループを畳む・開くことができる', async ({ page }) => {
  await page.addInitScript(() => {
    // 道具のグループの分だけ読み書きできなくする（ほかの設定は今まで通り）
    const { getItem, setItem } = Storage.prototype;
    Storage.prototype.getItem = function (k: string) {
      if (k.includes('tool-groups')) throw new Error('blocked');
      return getItem.call(this, k);
    };
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k.includes('tool-groups')) throw new Error('blocked');
      setItem.call(this, k, v);
    };
  });
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  const head = page.getByTestId('tool-group-図形');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-tool="rect"]')).toBeVisible();
});

test('反応スキームの欄の化合物に、構造の小さな絵を出す', async ({ page }) => {
  await showTab(page, 'scheme');
  await importSmiles(page, 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O.NCC(=O)OC>>CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC');
  await page.getByTestId('scheme-panel').getByRole('button', { name: '描いた反応式をスキームにする' }).click();
  const rows = page.getByTestId('scheme-compound');
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(rows.nth(i).locator('.thumb svg')).toHaveCount(1);
});

test('検討表の行を、つまみのドラッグで並べ替える', async ({ page }) => {
  await showTab(page, 'table');
  const panel = page.locator('[data-table-ui]');
  await panel.getByTestId('new-conditions-table').click();
  const solvents = panel.getByTestId('cell-solvent');
  for (const [i, v] of ['DMF', 'THF', 'MeCN'].entries()) {
    await solvents.nth(i).fill(v);
    await solvents.nth(i).press('Enter');
  }
  const order = async () => {
    const d = await doc(page);
    const t = Object.values(d.tables!)[0];
    const col = t.columns.find((c) => c.kind === 'solvent')!.id;
    return t.rows.map((r) => r.cells[col]);
  };
  await expect.poll(order).toEqual(['DMF', 'THF', 'MeCN']);
  // 3 行目を 1 行目へ
  await panel.getByTestId('row-drag').nth(2).dragTo(panel.getByTestId('table-row').nth(0));
  await expect.poll(order).toEqual(['MeCN', 'DMF', 'THF']);
  // 1 行目を 2 行目へ
  await panel.getByTestId('row-drag').nth(0).dragTo(panel.getByTestId('table-row').nth(1));
  await expect.poll(order).toEqual(['DMF', 'MeCN', 'THF']);
});

test('左の道具: 結合と環は絵で出し、くさびの実線（up）と破線（down）は同じ行に並ぶ。ボタンは 13 型の画面でも押しやすい大きさ', async ({ page }) => {
  for (const id of ['single', 'double', 'wedge', 'hash', 'benzene', 'chair', 'ring5']) {
    await expect(page.locator(`[data-tool="${id}"] svg.tool-icon`), id).toHaveCount(1);
  }
  const up = (await page.locator('[data-tool="wedge"]').boundingBox())!;
  const down = (await page.locator('[data-tool="hash"]').boundingBox())!;
  expect(Math.abs(up.y - down.y)).toBeLessThan(1);
  expect(down.x).toBeGreaterThan(up.x);
  expect(up.height).toBeGreaterThanOrEqual(32);
  expect(up.width).toBeGreaterThanOrEqual(36);
  // ベンゼンは環の最初
  const first = page.locator('.tool-group[data-group="環"] [data-tool]').first();
  await expect(first).toHaveAttribute('data-tool', 'benzene');
});

test('書き出し: ファイル名を付けると、どの形式もその名前で保存する。開いたファイルの名前を引き継ぎ、新規で戻る', async ({ page }) => {
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  await showTab(page, 'io');
  const name = page.getByTestId('export-name');
  // 書き出すのはキャンバス全体だと書いてある
  await expect(page.getByTestId('export-scope')).toContainText('キャンバス全体');
  await expect(name).toHaveValue('');
  await expect(name).toHaveAttribute('placeholder', 'structure');
  const save = async (label: string) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('io-panel').getByRole('button', { name: label, exact: true }).click()]);
    return dl.suggestedFilename();
  };
  expect(await save('CDX')).toBe('structure.cdx');
  await name.fill('アスピリン 合成');
  expect(await save('CDX')).toBe('アスピリン 合成.cdx');
  expect(await save('CDXML')).toBe('アスピリン 合成.cdxml');
  expect(await save('PNG')).toBe('アスピリン 合成.png');
  // 拡張子を付けたまま入れても二重にならない
  await name.fill('aspirin.cdxml');
  expect(await save('MOL')).toBe('aspirin.mol');
  // 文書の保存（Ctrl+S と同じ）も同じ名前
  const [doc] = await Promise.all([page.waitForEvent('download'), menuItem(page, 'menu-file', '保存')]);
  expect(doc.suggestedFilename()).toBe('aspirin.acedoc');
  // 新規で名前は空に戻る
  await menuItem(page, 'menu-file', '新規');
  await showTab(page, 'io');
  await expect(name).toHaveValue('');
  // ファイルを開くと、その名前を引き継ぐ
  await page.getByTestId('import-file').setInputFiles({ name: 'taxol-core.smi', mimeType: 'text/plain', buffer: Buffer.from('c1ccccc1') });
  await expect(name).toHaveValue('taxol-core');
  expect(await save('SVG')).toBe('taxol-core.svg');
});

test('書き出し: 選んでいるときは「選んだ物だけ書き出す」を選べ、選んだ分子だけを書き出す。選んでいなければ全体', async ({ page }) => {
  await importSmiles(page, 'CCO.c1ccccc1');
  await page.evaluate(() => window.__editor!.set({ selection: new Set() }));
  await showTab(page, 'io');
  const only = page.getByTestId('export-only-selected');
  await expect(only).toHaveCount(0);
  const saveText = async (label: string) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('io-panel').getByRole('button', { name: label, exact: true }).click()]);
    return readFileSync((await dl.path())!, 'utf8');
  };
  // 選んでいなければ全体
  expect(await canon(page, (await saveText('SMILES')).trim())).toBe(await canon(page, 'CCO.c1ccccc1'));
  // ベンゼンの原子と結合だけを選ぶ（エタノールの O から辿れない物）
  await page.evaluate(() => {
    const e = window.__editor!;
    const d = e.get().doc;
    const bonds = Object.values(d.bonds);
    const eth = new Set(Object.values(d.atoms).filter((a) => a.element === 'O').map((a) => a.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of bonds) if (eth.has(b.a1) !== eth.has(b.a2)) (eth.add(b.a1), eth.add(b.a2), (grew = true));
    }
    const ring = Object.keys(d.atoms).filter((id) => !eth.has(id));
    e.set({ selection: new Set([...ring, ...bonds.filter((b) => !eth.has(b.a1)).map((b) => b.id)]) });
  });
  await expect(only).toBeVisible();
  await expect(only).not.toBeChecked();
  await expect(page.getByTestId('export-scope')).toContainText('キャンバス全体');
  expect(await canon(page, (await saveText('SMILES')).trim())).toBe(await canon(page, 'CCO.c1ccccc1'));
  await only.check();
  await expect(page.getByTestId('export-scope')).toContainText('選んだ物だけ');
  expect(await canon(page, (await saveText('SMILES')).trim())).toBe(await canon(page, 'c1ccccc1'));
  const mol = await saveText('MOL');
  expect(mol.split('\n')[3].trim().split(/\s+/)[0]).toBe('6');
  // 選択を外すと、切り替えは消えて全体に戻る
  await page.evaluate(() => window.__editor!.set({ selection: new Set() }));
  await expect(only).toHaveCount(0);
  expect(await canon(page, (await saveText('SMILES')).trim())).toBe(await canon(page, 'CCO.c1ccccc1'));
});

test('左の道具のグループは 選択・結合・環・反応 の順。見出しのドラッグ（Alt+↑↓）で並べ替え、再読み込みしても覚えている', async ({ page }) => {
  const order = () => page.locator('.tools .tool-group').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group));
  expect(await order()).toEqual(['選択', '結合', '環', '反応', '図形', '機構']);
  await page.getByTestId('tool-group-機構').dragTo(page.getByTestId('tool-group-結合'));
  await expect.poll(order).toEqual(['選択', '機構', '結合', '環', '反応', '図形']);
  await page.getByTestId('tool-group-反応').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(order).toEqual(['選択', '機構', '結合', '反応', '環', '図形']);
  await expect(page.getByTestId('tool-group-反応')).toBeFocused();
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  expect(await order()).toEqual(['選択', '機構', '結合', '反応', '環', '図形']);
  // 畳む・開くは今までどおり（並べ替えで押した扱いにならない）
  await expect(page.locator('[data-tool="single"]')).toBeVisible();
});

test('左の道具の列の幅を、右の縁のつまみのドラッグで変える。広げると列が増え、再読み込みしても覚えている。ダブルクリックで元の幅', async ({ page }) => {
  const width = async () => (await page.locator('.tools').boundingBox())!.width;
  expect(await width()).toBeCloseTo(92, 0);
  const h = (await page.getByTestId('tools-resize').boundingBox())!;
  await page.mouse.move(h.x + 3, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + 103, h.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBeCloseTo(192, 0);
  // 4 列になり、くさびの実線と破線は同じ行のまま
  const wedge = (await page.locator('[data-tool="wedge"]').boundingBox())!;
  const hash = (await page.locator('[data-tool="hash"]').boundingBox())!;
  const single = (await page.locator('[data-tool="single"]').boundingBox())!;
  expect(Math.abs(wedge.y - hash.y)).toBeLessThan(1);
  expect(Math.abs(wedge.y - single.y)).toBeLessThan(1);
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  expect(await width()).toBeCloseTo(192, 0);
  await page.getByTestId('tools-resize').dblclick();
  expect(await width()).toBeCloseTo(92, 0);
  // 矢印キーでも変えられる
  await page.getByTestId('tools-resize').focus();
  await page.keyboard.press('ArrowRight');
  expect(await width()).toBeCloseTo(100, 0);
});

test('サービスの名前は Cocat。タブの題・上のバー・「このツールについて」に出し、名前の由来を書く', async ({ page }) => {
  await expect(page).toHaveTitle(/^Cocat/);
  await expect(page.locator('.topbar h1')).toHaveText('Cocat');
  await page.getByTestId('menu-help').click();
  await page.getByTestId('open-about').click();
  await expect(page.getByTestId('about').locator('h2')).toHaveText('Cocat（ベータ版）');
  await expect(page.getByTestId('about-name')).toContainText('co-catalyst（助触媒）');
});

test('名前や SMILES から作る: 段ごとに入れてスキームにする。空の欄と読めない名前は枠にし、描いた分子で埋められる', async ({ page }) => {
  await page.getByTestId('new-scheme').click();
  const form = page.getByTestId('new-scheme-form');
  await form.locator('summary').click();
  await form.getByTestId('new-scheme-substrate-1').fill('CCO');
  await form.getByTestId('new-scheme-reagents').fill('PCC (1.5 equiv)');
  await form.getByTestId('new-scheme-solvent').fill('CH2Cl2');
  await form.getByTestId('new-scheme-yield').fill('80');
  // 1 段目の生成物は空（枠）。2 段目の生成物は読めない名前（枠）
  await form.getByTestId('new-scheme-add-step').click();
  await expect(form.getByTestId('new-scheme-step')).toHaveCount(2);
  await form.getByTestId('new-scheme-product').nth(1).fill('xyzzy-unknown');
  await form.getByTestId('new-scheme-create').click();
  await expect.poll(async () => Object.keys((await doc(page)).schemes ?? {}).length).toBe(1);
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'scheme');
  await expect(page.getByTestId('status')).toContainText('構造にできなかった名前: xyzzy-unknown');
  let d = await doc(page);
  const s = Object.values(d.schemes!)[0];
  expect(s.steps).toHaveLength(2);
  expect(s.steps[0]).toMatchObject({ reagents: [{ text: 'PCC', equiv: 1.5 }], solvent: 'CH2Cl2', yield: 80 });
  expect(s.steps[1].from).toEqual(s.steps[0].to);
  // 枠は 2 つ（空の生成物と、読めない名前）
  await expect(page.getByTestId('compound-placeholder')).toHaveCount(2);
  // キャンバスでは、枠を点線の枠で示す（おかしな原子の赤い印は出さない）。SMILES で入れた基質には呼び名を付けない
  await expect(page.getByTestId('placeholder-frame')).toHaveCount(2);
  expect(d.compounds![s.steps[0].from[0]].nickname).toBeUndefined();

  // 分子を描いて選び、1 段目の生成物の枠を埋める
  await importSmiles(page, 'CC=O');
  const rows = page.getByTestId('scheme-compound');
  await rows.nth(1).getByTestId('compound-replace').click();
  await expect(page.getByTestId('compound-placeholder')).toHaveCount(1);
  await expect(page.getByTestId('placeholder-frame')).toHaveCount(1);
  d = await doc(page);
  const product = d.compounds![s.steps[0].to[0]];
  expect(Object.values(product.structure.atoms).map((a) => a.element).sort()).toEqual(['C', 'C', 'O']);
  // 描いた分子はスキームに入った（スキームの外の分子は残らない）
  expect(Object.values(d.atoms).filter((a) => !a.ref)).toHaveLength(0);
});

test('道具のキー: 何も指していないときは道具を選び、原子や結合を指しているときはその物を変える', async ({ page }) => {
  const current = () => page.evaluate(() => window.__editor!.get().tool);
  const box = (await page.getByTestId('canvas').boundingBox())!;
  // 何も無い所を指して押す
  await page.mouse.move(box.x + 60, box.y + 60);
  for (const [key, id] of [['v', 'select'], ['2', 'double'], ['3', 'triple'], ['w', 'wedge'], ['h', 'hash'], ['a', 'benzene'], ['r', 'arrow-normal'], ['t', 'text'], ['1', 'single']] as const) {
    await page.keyboard.press(key);
    expect(await current()).toBe(id);
  }
  // 今の道具の案内に、道具の説明とキーを出す
  await expect(page.getByTestId('tool-hint')).toContainText('単結合');
  await expect(page.getByTestId('tool-hint')).toContainText('1 キー');
  // 結合を 1 本描いて、その結合を指して 2 を押すと、道具は変わらず結合が二重になる
  await page.mouse.click(box.x + 300, box.y + 300);
  const b = await page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const bond = Object.values(d.bonds)[0];
    return { x: (d.atoms[bond.a1].x + d.atoms[bond.a2].x) / 2, y: (d.atoms[bond.a1].y + d.atoms[bond.a2].y) / 2 };
  });
  const v = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    return { zoom: svg.clientWidth / vb.width, x: vb.x, y: vb.y };
  });
  await page.mouse.move(box.x + (b.x - v.x) * v.zoom, box.y + (b.y - v.y) * v.zoom);
  await page.keyboard.press('2');
  expect(await current()).toBe('single');
  expect(await page.evaluate(() => Object.values(window.__editor!.get().doc.bonds)[0].order)).toBe(2);
  // 道具を指すと、名前とキーの吹き出しがすぐに出る
  await page.locator('[data-tool="benzene"]').hover();
  await expect(page.locator('.tool-tip')).toContainText('ベンゼン');
  await expect(page.locator('.tool-tip kbd')).toHaveText('A');
});

test('右の欄は畳める。メニューから欄を出すと開く。畳んだことは開き直しても残る', async ({ page }) => {
  const canvasWidth = async () => (await page.getByTestId('canvas').boundingBox())!.width;
  const before = await canvasWidth();
  await page.getByTestId('side-collapse').click();
  await expect(page.getByTestId('side-head')).toBeHidden();
  expect(await canvasWidth()).toBeGreaterThanOrEqual(before + 300);
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  await expect(page.getByTestId('side-head')).toBeHidden();
  // 読み込みと書き出しを開くと、欄も開く
  await showTab(page, 'io');
  await expect(page.getByTestId('io-panel')).toBeVisible();
  await page.getByTestId('side-collapse').click();
  await page.getByTestId('side-open').click();
  await expect(page.getByTestId('io-panel')).toBeVisible();
});

test('上のバーの文書の名前は、書き出しのファイル名と同じ値。拡大・縮小はキャンバスの右下にある', async ({ page }) => {
  await importSmiles(page, 'CCO');
  await page.getByTestId('doc-name').fill('エタノール');
  await showTab(page, 'io');
  await expect(page.getByTestId('export-name')).toHaveValue('エタノール');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('io-panel').getByRole('button', { name: 'MOL', exact: true }).click()]);
  expect(dl.suggestedFilename()).toBe('エタノール.mol');
  const level = page.getByTestId('zoom-level');
  const z0 = await level.textContent();
  await page.getByTestId('zoom-in').click();
  await expect(level).not.toHaveText(z0!);
  // 上のバーの中には無い
  await expect(page.locator('.topbar').getByTestId('zoom-level')).toHaveCount(0);
});

test('選んだ物の帯: 分子を選ぶと、そばに Clean・反転・色・画像でコピーが出る。ドラッグの間と、選択を外すと消える', async ({ page }) => {
  await importSmiles(page, 'CC(=O)Oc1ccccc1C(=O)O');
  await tool(page, 'select');
  const bar = page.getByTestId('sel-bar');
  await expect(bar).toBeVisible();
  // 左右反転: 原子の x の並びが逆になる
  const xs = () => page.evaluate(() => Object.values(window.__editor!.get().doc.atoms).map((a) => a.x));
  const before = await xs();
  await page.getByTestId('sel-flip-h').click();
  const after = await xs();
  expect(after.some((x, i) => Math.abs(x - before[i]) > 1)).toBe(true);
  // 色
  await page.getByTestId('sel-color').click();
  await page.getByTestId('sel-colors').getByTestId('color-赤').click();
  expect(await page.evaluate(() => Object.values(window.__editor!.get().doc.atoms).every((a) => a.color === '#d32f2f'))).toBe(true);
  // ほかの操作から、分子量などの欄を出す
  await page.getByTestId('sel-more').click();
  await page.getByTestId('ctx-menu').getByTestId('ctx-analysis').click();
  await expect(page.getByTestId('analysis')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
});

test('右クリック: 押しただけならメニューを出し、分子の上ならその分子を選ぶ。ドラッグすると表示を動かしてメニューは出さない', async ({ page }) => {
  await importSmiles(page, 'c1ccccc1');
  await page.keyboard.press('Escape');
  const a = await page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const at = Object.values(d.atoms)[0];
    const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const r = svg.getBoundingClientRect();
    const zoom = svg.clientWidth / vb.width;
    return { x: r.left + (at.x - vb.x) * zoom, y: r.top + (at.y - vb.y) * zoom, vx: vb.x };
  });
  await page.mouse.click(a.x, a.y, { button: 'right' });
  const menu = page.getByTestId('ctx-menu');
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => window.__editor!.get().selection.size)).toBe(12);
  await expect(menu.getByRole('menuitem', { name: 'Clean Structure' })).toBeVisible();
  // 選んだ物だけ書き出す: 書き出すの画面が、選んだ物だけの状態で開く
  await menu.getByTestId('ctx-export').click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog.getByTestId('export-only-selected')).toBeChecked();
  await dialog.getByRole('button', { name: '閉じる' }).click();
  // 何も無い所: 選択を外し、貼り付けと全体を表示を出す
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + 200, { button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '全体を表示' })).toBeVisible();
  expect(await page.evaluate(() => window.__editor!.get().selection.size)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // ドラッグ: 表示が動き、メニューは出ない
  await page.mouse.move(box.x + 40, box.y + 200);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + 140, box.y + 260, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect(menu).toHaveCount(0);
  const vx = await page.evaluate(() => (document.querySelector('[data-testid=canvas]') as SVGSVGElement).viewBox.baseVal.x);
  expect(Math.abs(vx - a.vx)).toBeGreaterThan(10);
});

test('書き出す: 上のバーのボタンから、書き出す範囲の絵・ファイル名・形式を 1 つの画面で選ぶ', async ({ page }) => {
  await importSmiles(page, 'CCO');
  await page.getByTestId('doc-name').fill('エタノール');
  await page.getByTestId('open-export').click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog.getByTestId('export-preview').locator('img')).toBeVisible();
  await expect(dialog.getByTestId('export-name')).toHaveValue('エタノール');
  const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'CDXML', exact: true }).click()]);
  expect(dl.suggestedFilename()).toBe('エタノール.cdxml');
  // 画像でコピーもここから
  await dialog.getByTestId('export-copy-image').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.status')).toContainText('図をコピーしました');
});

test('入力欄（Ctrl+K）: 名前や SMILES から構造を置き、雛形を選び、メニューの操作を呼べる', async ({ page }) => {
  const input = page.getByTestId('command-input');
  await page.keyboard.press('Control+k');
  await expect(input).toBeFocused();
  // SMILES: そのまま置く
  await input.fill('CC(=O)Oc1ccccc1C(=O)O');
  await expect(page.getByTestId('command-item').first()).toContainText('SMILES');
  await input.press('Enter');
  expect(await page.evaluate(() => Object.keys(window.__editor!.get().doc.atoms).length)).toBe(13);
  await expect(input).toHaveValue('');
  // 操作: メニューの項目を名前で探して呼ぶ
  await page.keyboard.press('Control+k');
  await input.fill('すべて選択');
  // 先頭は操作。手元で読めない文字を名前として読む候補は、いちばん後ろ
  await expect(page.getByTestId('command-item').first()).toContainText('すべて選択');
  await expect(page.getByTestId('command-item').first()).toContainText('Ctrl+A');
  await input.press('Enter');
  expect(await page.evaluate(() => window.__editor!.get().selection.size)).toBe(26);
  // 見本もここから開ける
  await page.keyboard.press('Control+k');
  await input.fill('3段');
  await page.getByTestId('command-item').filter({ hasText: '3段のスキーム' }).click();
  await expect(page.getByTestId('scheme-step')).toHaveCount(3);
  // 雛形: 選ぶと、クリックした所に置く道具になる
  await page.keyboard.press('Control+k');
  await input.fill('ピリジン');
  await page.getByTestId('command-item').filter({ hasText: 'クリックした所に置く' }).filter({ hasText: 'ピリジン' }).first().click();
  expect(await page.evaluate(() => window.__editor!.get().tool)).toBe('part');
  // Esc で閉じて、入力を消す
  await page.keyboard.press('Control+k');
  await input.fill('zzzz');
  await expect(page.getByTestId('command-list')).toContainText('名前として読む');
  await input.press('Escape');
  await expect(page.getByTestId('command-list')).toHaveCount(0);
  await expect(input).toHaveValue('');
});

test('狭い画面: 幅 1024px でも上のバーは 1 行に収まる。幅 900px より狭いと、右の欄ははじめ畳んであり、開くとキャンバスに重なる', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(bar.height).toBeLessThan(48);
  expect(await page.locator('.topbar').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await expect(page.getByTestId('open-export')).toBeVisible();
  await expect(page.getByTestId('command-input')).toBeVisible();
  await expect(page.getByTestId('side-head')).toBeVisible();
  // 幅 860px: 覚えた開け閉めが無ければ、畳んで始める
  await page.evaluate(() => localStorage.clear());
  await page.setViewportSize({ width: 860, height: 700 });
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  await expect(page.getByTestId('side-head')).toBeHidden();
  const before = (await page.getByTestId('canvas').boundingBox())!.width;
  await page.getByTestId('side-open').click();
  await expect(page.getByTestId('side-head')).toBeVisible();
  // 重なって開くので、キャンバスの幅は変わらない
  expect((await page.getByTestId('canvas').boundingBox())!.width).toBe(before);
});

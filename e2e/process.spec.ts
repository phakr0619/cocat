import { expect, test, type Page } from '@playwright/test';
import { openSample, setApiKey, showTab } from './helpers';

// 実験の記録: 仕込み・操作の流れと重さ・操作ごとの記録を入れ、フロー図と収支を描く
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

const run = (page: Page) => page.evaluate(() => Object.values(window.__editor!.get().doc.runs ?? {})[0]);
const runTexts = (page: Page) =>
  page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const id = Object.keys(d.runs ?? {})[0];
    return Object.values(d.texts).filter((t) => t.ref === id).map((t) => t.text.replace(/ +/g, ' '));
  });
const boxes = (page: Page) =>
  page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const id = Object.keys(d.runs ?? {})[0];
    return Object.values(d.shapes ?? {}).filter((s) => s.ref === id);
  });

test('見本の実験の記録: フロー図に重さと収支を出し、右の欄に収率・PMI・生成物の行方・確かめてほしい所を出す', async ({ page }) => {
  await openSample(page, 'run');
  await expect(page.getByTestId('run-dock')).toBeVisible();
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'run');
  const results = page.getByTestId('run-results');
  await expect(results).toContainText('11.9 g');
  await expect(results).toContainText('86.5%');
  await expect(results).toContainText('34.1');
  // PMI の内訳: 溶媒・水と水溶液・そのほか
  await expect(results).toContainText('溶媒 18.5、水・水溶液 12.6、そのほか 3.0');
  await expect(page.getByTestId('run-fate')).toContainText('母液・洗液');
  await expect(page.getByTestId('run-warnings')).toContainText('揮発分 の重さが未入力です。差から 3.0 g としています');
  const texts = await runTexts(page);
  expect(texts).toContain('収支 99.2%');
  expect(texts).toContain('1 M HCl 50 g');
  expect(texts.some((t) => t.includes('PMI 34.1'))).toBe(true);
  expect((await boxes(page)).length).toBe(5);
  // 初めて開いたときに、正式な記録ではないことを 1 回知らせる
  await expect(page.getByTestId('run-notice')).toContainText('正式な記録は実験ノートに');
  await page.getByTestId('run-notice').getByRole('button', { name: '分かりました' }).click();
  await expect(page.getByTestId('run-notice')).toHaveCount(0);
  // 自動保存（変更の少し後）を待つ
  await page.waitForTimeout(700);
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  // 読み込み直しても記録は残り、一覧から開ける。知らせはもう出ない
  await page.getByTestId('home-run').click();
  await expect(page.getByTestId('run-dock')).toBeVisible();
  await expect(page.getByTestId('run-notice')).toHaveCount(0);
});

test('フロー図の向き: 横は入れる物が上・出る物が下、縦は入れる物が左・出る物と得た生成物が右', async ({ page }) => {
  await openSample(page, 'run');
  const place = () =>
    page.evaluate(() => {
      const d = window.__editor!.get().doc;
      const id = Object.keys(d.runs!)[0];
      const bs = Object.values(d.shapes!).filter((s) => s.ref === id);
      const t = (s: string) => Object.values(d.texts).find((x) => x.ref === id && x.text.includes(s))!;
      return { boxes: bs, hcl: t('1 M HCl'), water: t('水層'), product: Object.values(d.texts).find((x) => x.ref === id && x.bold && /^3\s/.test(x.text))! };
    });
  let p = await place();
  expect(p.boxes[1].x1).toBeGreaterThan(p.boxes[0].x2);
  expect(p.hcl.y).toBeLessThan(p.boxes[1].y1);
  expect(p.water.y).toBeGreaterThan(p.boxes[1].y2);
  await page.getByTestId('run-direction').selectOption('vertical');
  p = await place();
  expect(p.boxes[1].y1).toBeGreaterThan(p.boxes[0].y2);
  expect(p.hcl.x).toBeLessThan(p.boxes[1].x1);
  expect(p.water.x).toBeGreaterThan(p.boxes[1].x2);
  expect(p.product.x).toBeGreaterThan(p.boxes[4].x2);
  // 重さを出さない
  await page.getByTestId('run-show-mass').uncheck();
  expect((await runTexts(page)).some((t) => t.includes('収支'))).toBe(false);
  // 元に戻すで戻る
  await page.getByTitle('元に戻す (Ctrl+Z)').click();
  expect((await runTexts(page)).some((t) => t.includes('収支'))).toBe(true);
});

test('スキームの段から作る: 基質・試薬・溶媒が仕込みに入り、量と重さを入れると収支と収率が出る', async ({ page }) => {
  await openSample(page, 'coupling');
  await page.getByTestId('step-new-run').click();
  const dock = page.getByTestId('run-dock');
  await expect(dock).toBeVisible();
  await dock.getByTestId('run-tab-materials').click();
  const rows = dock.getByTestId('run-material');
  await expect(rows).toHaveCount(5);
  // 量を入れる。溶媒は体積と密度
  for (const [i, v] of [[0, '10 g'], [1, '4.7 g'], [2, '12.2 g'], [3, '8.6 g'], [4, '100 mL']] as const) {
    await rows.nth(i).getByTestId('material-amount').fill(v);
    await rows.nth(i).getByTestId('material-amount').press('Enter');
  }
  // 密度が無い間は、重さにできないことを知らせる
  await expect(page.getByTestId('run-warnings')).toContainText('密度を入れると重さにできます');
  await rows.nth(4).getByTestId('material-density').fill('1.33');
  await rows.nth(4).getByTestId('material-density').press('Enter');
  // 単位の無い量は入らず、理由を知らせる
  await rows.nth(0).getByTestId('material-amount').fill('10');
  await rows.nth(0).getByTestId('material-amount').press('Enter');
  await expect(page.locator('.status')).toContainText('数と単位');
  expect((await run(page)).materials[0].amount).toEqual({ value: 10, unit: 'g' });
  // 操作と記録: 分液・洗浄の水層と、次へ進む重さを入れると収支が出る
  await dock.getByTestId('run-tab-log').click();
  const ops = dock.getByTestId('run-op');
  await expect(ops).toHaveCount(3);
  await ops.nth(1).getByTestId('output-amount').fill('20 g');
  await ops.nth(1).getByTestId('output-amount').press('Enter');
  await ops.nth(1).getByTestId('op-carry').fill('146 g');
  await ops.nth(1).getByTestId('op-carry').press('Enter');
  // 入 168.5、出 20 + 146 = 166 → 98.5%
  await expect(ops.nth(1).getByTestId('op-closure')).toHaveText('収支 98.5%');
  expect(await runTexts(page)).toContain('収支 98.5%');
  // 得た重さを入れると、収率が出る（理論 13.76 g）
  await ops.nth(2).getByTestId('output-amount').fill('130 g');
  await ops.nth(2).getByTestId('output-amount').press('Enter');
  await ops.nth(2).getByTestId('op-carry').fill('12.4 g');
  await ops.nth(2).getByTestId('op-carry').press('Enter');
  await expect(page.getByTestId('run-results')).toContainText('90.1%');
  // 操作を足す・名前を直す・消す
  await dock.getByTestId('op-add').selectOption('drying');
  await expect(ops).toHaveCount(4);
  expect((await boxes(page)).length).toBe(4);
  await ops.nth(3).getByTestId('op-name').fill('減圧乾燥');
  await ops.nth(3).getByTestId('op-name').press('Enter');
  expect((await runTexts(page))).toContain('減圧乾燥');
  await ops.nth(3).getByTestId('op-remove').click();
  await expect(ops).toHaveCount(3);
});

test('操作ごとの記録: 時刻から打つとその時刻の記録になり、図の箱を選ぶとその操作の行が青くなる', async ({ page }) => {
  await openSample(page, 'run');
  const dock = page.getByTestId('run-dock');
  const events = dock.getByTestId('run-event');
  await expect(events).toHaveCount(10);
  // 図の「晶析・ろ過」の箱を選ぶ
  const at = await page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const id = Object.keys(d.runs!)[0];
    const b = Object.values(d.shapes!).filter((s) => s.ref === id)[3];
    const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const r = svg.getBoundingClientRect();
    const zoom = svg.clientWidth / vb.width;
    return { x: r.left + (b.x1 - vb.x) * zoom + 1, y: r.top + ((b.y1 + b.y2) / 2 - vb.y) * zoom };
  });
  await page.locator('[data-tool="select"]').click();
  await page.mouse.click(at.x, at.y);
  await expect(dock.locator('[data-testid=run-event].h')).toHaveCount(2);
  await expect(dock.getByTestId('run-op').nth(3)).toHaveClass(/\bh\b/);
  // 記録を足す: 選んだ操作に、時刻つきで入る
  await dock.getByTestId('quick-event').fill('15:10 種晶を入れる');
  await dock.getByTestId('quick-event').press('Enter');
  await expect(events).toHaveCount(11);
  let r = await run(page);
  expect(r.events.at(-1)).toMatchObject({ time: '15:10', action: '種晶を入れる', opId: r.operations[3].id });
  // 時刻を打たなければ、今の時刻が入る
  await dock.getByTestId('quick-event').fill('ろ液が濁る');
  await dock.getByTestId('quick-event').press('Enter');
  r = await run(page);
  expect(r.events.at(-1)!.time).toMatch(/^\d{2}:\d{2}$/);
  // 行を直す
  await events.nth(10).getByTestId('event-temp').fill('30 °C');
  await events.nth(10).getByTestId('event-temp').press('Enter');
  expect((await run(page)).events[10].temp).toBe('30 °C');
  // 時刻が前の行より早いと知らせる
  await events.nth(10).getByTestId('event-time').fill('08:00');
  await events.nth(10).getByTestId('event-time').press('Enter');
  await expect(page.getByTestId('run-warnings')).toContainText('前の行より早く');
});

test('記録を出す: 1 枚のページにまとめて印刷し、表を Excel に貼れる形でコピーし、検討表の 1 行にする', async ({ page, context }) => {
  await page.addInitScript(() => {
    const proto = HTMLIFrameElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'contentWindow')!;
    Object.defineProperty(proto, 'contentWindow', {
      get() {
        const w = desc.get!.call(this);
        if (w && !w.__patched) {
          w.__patched = true;
          w.print = () => {
            (window as unknown as { __printed?: number }).__printed = ((window as unknown as { __printed?: number }).__printed ?? 0) + 1;
          };
        }
        return w;
      },
    });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.reload();
  await page.getByTestId('canvas').waitFor();
  await openSample(page, 'run');
  await page.getByTestId('run-pdf').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0)).toBe(1);
  const frame = page.frameLocator('iframe[data-testid="print-frame"]');
  await expect(frame.locator('h1')).toContainText('実験 AB-012');
  await expect(frame.locator('[data-part=scheme] svg')).toHaveCount(1);
  await expect(frame.locator('[data-part=flow] svg')).toHaveCount(1);
  await expect(frame.locator('body')).toContainText('EDC·HCl を 4 回に分けて入れる');
  await expect(frame.locator('body')).toContainText('34.1');
  // 表をコピー
  await page.getByTestId('run-copy').click();
  await expect(page.locator('.status')).toContainText('Excel に貼れます');
  const tsv = await page.evaluate(() => navigator.clipboard.readText());
  expect(tsv).toContain('仕込み\n役割\t名前\t分子量');
  expect(tsv).toContain('12:41\t分液・洗浄\t1 M HCl で洗う\t50 g\t20 °C\t水層 pH 1');
  expect(tsv).toContain('PMI\t34.1');
  // 検討表の行にする。2 回押しても、同じ記録の行は 1 つ
  await page.getByTestId('run-to-table').click();
  await expect(page.getByTestId('side-head')).toHaveAttribute('data-view', 'table');
  const table = () => page.evaluate(() => Object.values(window.__editor!.get().doc.tables!)[0]);
  let t = await table();
  expect(t.rows.length).toBe(1);
  expect(t.columns.map((c) => c.label)).toEqual(['entry', 'notebook', 'scale', 'product', 'yield', 'assay', 'PMI']);
  expect(Object.values(t.rows[0].cells)).toEqual(['AB-012', '10 g', '11.9', '86.5', '99.1', '34.1']);
  await page.getByTestId('side-back').click();
  await page.getByTestId('home-run').click();
  await page.getByTestId('run-to-table').click();
  t = await table();
  expect(t.rows.length).toBe(1);
});

test('記録を消す・フロー図だけを残す。スキームが無くても作れる', async ({ page }) => {
  await page.getByTestId('new-run').click();
  const dock = page.getByTestId('run-dock');
  await expect(dock).toBeVisible();
  expect((await boxes(page)).length).toBe(3);
  await dock.getByTestId('run-tab-materials').click();
  await dock.getByTestId('material-add').click();
  const row = dock.getByTestId('run-material');
  await row.getByTestId('material-name').fill('トルエン');
  await row.getByTestId('material-name').press('Enter');
  await row.getByTestId('material-amount').fill('2.5 kg');
  await row.getByTestId('material-amount').press('Enter');
  expect(await runTexts(page)).toContain('トルエン 2.5 kg');
  // フロー図だけを残す: データは消え、図は残る
  await dock.getByTestId('run-tab-balance').click();
  await dock.getByTestId('run-dissolve').click();
  await expect(dock).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__editor!.get().doc.runs ?? {}).length)).toBe(0);
  expect(await page.evaluate(() => Object.keys(window.__editor!.get().doc.shapes ?? {}).length)).toBe(3);
  // 元に戻して、記録を消す: 図も消える
  await page.getByTitle('元に戻す (Ctrl+Z)').click();
  await showTab(page, 'analysis');
  await page.getByTestId('side-back').click();
  await page.getByTestId('home-run').click();
  await dock.getByTestId('run-tab-balance').click();
  await dock.getByTestId('run-remove').click();
  expect(await page.evaluate(() => Object.keys(window.__editor!.get().doc.shapes ?? {}).length)).toBe(0);
});

test('下の表の欄を開いても、画面は横にはみ出さず、右の欄と上のバーが見えている。別の見本に替えると図の全体が見える', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSample(page, 'run');
  await expect(page.getByTestId('run-dock')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await expect(page.getByTestId('open-export')).toBeInViewport();
  await expect(page.getByTestId('run-results')).toBeInViewport();
  // 3 段のスキームに替える: 表の欄が閉じた後の広さで、図の全体が入る
  await openSample(page, 'multistep');
  await expect(page.getByTestId('run-dock')).toHaveCount(0);
  const fits = await page.evaluate(() => {
    const d = window.__editor!.get().doc;
    const svg = document.querySelector('[data-testid=canvas]') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const xs = Object.values(d.atoms).map((a) => a.x);
    const ys = Object.values(d.atoms).map((a) => a.y);
    return Math.min(...xs) > vb.x && Math.max(...xs) < vb.x + vb.width && Math.min(...ys) > vb.y && Math.max(...ys) < vb.y + vb.height;
  });
  expect(fits).toBe(true);
});

// ---- AI の手伝い（Gemini は呼ばず、page.route で決まった答えを返す） ----
const API = 'https://generativelanguage.googleapis.com/**';
async function fakeGemini(page: Page, answer: unknown) {
  const bodies: string[] = [];
  await page.route(API, async (route) => {
    bodies.push(route.request().postData() ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }),
    });
  });
  return bodies;
}

test('メモから作る: キーがあるときだけ出る。メモに無い数字は要確認にして入れず、「記録に入れる」を押すまで記録は変わらない', async ({ page }) => {
  await page.getByTestId('new-run').click();
  const dock = page.getByTestId('run-dock');
  await expect(dock.getByTestId('run-tab-memo')).toHaveCount(0);
  await setApiKey(page);
  const bodies = await fakeGemini(page, {
    operations: [
      { kind: 'reaction', name: '反応' },
      { kind: 'wash', name: '洗浄', outputs: [{ name: '水層', amount: '61 g' }], carry: '150 g' },
      { kind: 'concentration', name: '濃縮', carry: '18.4 g' },
    ],
    materials: [{ name: '1 M HCl', role: 'water', amount: '50 g', operation: 2 }],
    events: [
      { operation: 1, time: '9:20', action: 'EDC·HCl を入れた', amount: '12.2 g', temp: '2 → 6 °C' },
      { operation: 2, time: '12:41', action: '1 M HCl で洗った', amount: '50 g' },
      { operation: 3, action: '濃縮した' },
    ],
  });
  await dock.getByTestId('run-tab-memo').click();
  await dock.getByTestId('run-memo-text').fill('9:20 EDC·HCl 12.2 g を入れた。内温 2 → 6 °C。\n12:41 1 M HCl 50 g で洗った。有機層 152.0 g、水層 61 g。\n濃縮して 18.4 g。');
  await expect(dock.getByTestId('run-memo-preview')).toContainText('MEMO:');
  await dock.getByTestId('run-memo-run').click();
  await expect(page.getByTestId('llm-consent')).toContainText('ロット、描いた図は送りません');
  await page.getByTestId('llm-consent-ok').click();
  const draft = dock.getByTestId('run-memo-draft');
  await expect(draft.getByTestId('ai-notice')).toContainText('メモと見比べてください');
  // 「150 g」はメモに無いので、要確認にして入れない
  await expect(draft.getByTestId('run-memo-issues')).toContainText('「150」は、メモに無い数字です');
  await expect(draft.getByTestId('run-memo-ops')).toContainText('出る: 水層 61 g');
  await expect(draft.getByTestId('run-memo-ops')).not.toContainText('150 g');
  // 送った本文に、メモが入っている
  expect(bodies[0]).toContain('EDC·HCl 12.2 g');
  // まだ記録は変わっていない
  expect((await run(page)).events.length).toBe(0);
  await draft.getByTestId('run-memo-apply').click();
  const r = await run(page);
  expect(r.operations.map((o) => o.name)).toEqual(['反応', '洗浄', '濃縮']);
  expect(r.events.length).toBe(3);
  expect(r.operations[1].carry).toBeUndefined();
  expect(r.operations[2].carry).toEqual({ value: 18.4, unit: 'g' });
  expect(r.materials.map((m) => m.name)).toContain('1 M HCl');
  expect((await boxes(page)).length).toBe(3);
  // 元に戻すと、前の記録に戻る
  await page.getByTitle('元に戻す (Ctrl+Z)').click();
  expect((await run(page)).events.length).toBe(0);
});

test('実験項を書く: 実験の記録を使うと、記録の量と行を送り、記録の値で書く。時刻とロットは送らない', async ({ page }) => {
  await setApiKey(page);
  await openSample(page, 'run');
  const bodies = await fakeGemini(page, {
    text: '{{C1}} ({{s1.C1.mg}}), {{C2}} ({{s1.C2.mg}}) and {{s1.R2}} ({{s1.R2.mg}}) were dissolved in {{s1.M1}} ({{s1.M1.amount}}). {{s1.R1}} ({{s1.R1.mg}}) was added in 4 portions. The mixture was washed with {{s1.M2}} ({{s1.M2.amount}}) to give {{C3}} ({{s1.C3.mg}}, {{s1.yield}}).',
    questions: [],
  });
  await page.getByTestId('side-back').click();
  await page.getByTestId('home-scheme').click();
  await page.getByTestId('scheme-ai-write').click();
  const panel = page.getByTestId('tts-write');
  await expect(panel.getByTestId('tts-write-use-runs')).toBeChecked();
  await expect(panel.getByTestId('tts-write-runs-note')).toContainText('時刻とロットは送りません');
  await panel.locator('.tts-preview summary').click();
  const preview = panel.getByTestId('tts-write-preview');
  await expect(preview).toContainText('RECORD of step 1');
  await expect(preview).toContainText('{{s1.C1.mg}} = 10 g');
  await expect(preview).not.toContainText('09:12');
  await expect(preview).not.toContainText('L-2311');
  await panel.getByTestId('tts-write-run').click();
  await expect(page.getByTestId('llm-consent-run')).toContainText('記録の行も送ります');
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-write-out')).toHaveValue(/CH2Cl2 \(100 mL\)/);
  await expect(panel.getByTestId('tts-write-out')).toHaveValue(/3 \(11\.9 g, 86\.5%\)/);
  await expect(panel.getByTestId('tts-write-ok')).toBeVisible();
  expect(bodies[0]).toContain('Some steps have a RECORD');
  // 使わないことにすると、化学量論表の値に戻り、記録の行は送らない
  await panel.getByTestId('tts-write-use-runs').uncheck();
  await expect(preview).not.toContainText('RECORD of step 1');
  await expect(preview).toContainText('{{s1.C1.mg}} = 10000.0 mg');
});

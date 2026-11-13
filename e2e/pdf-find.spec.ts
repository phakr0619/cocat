import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import { openAi, setApiKey, openLlmSettings } from './helpers';

// PDF の画面で、図の範囲を AI で見つける・画像の解像度が低い図の警告を出す。
// Gemini は呼ばず、page.route で決まった答えを返す。図を探す呼び出し（system に findFigures の指示）と下書きの呼び出しで答えを変える。PDF はテストの中で作る
const API = 'https://generativelanguage.googleapis.com/**';
const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

const amide = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 }],
  questions: [] as string[],
};

/** 図の答え。box_2d は [ymin, xmin, ymax, xmax]（0〜1000） */
type Fig = { box_2d: number[]; label?: string; kind: 'reaction-scheme' | 'structure' | 'other' };
/** ページの上のほう（高さの 0〜26%、幅の 0〜60%）の反応スキーム 1 つ */
const ONE: Fig[] = [{ box_2d: [0, 0, 260, 600], label: 'Scheme 1', kind: 'reaction-scheme' }];

type Plan = {
  /** 図を探す呼び出しの答え。数字は HTTP のエラー */
  figures: Fig[] | number;
  /** 図を探す呼び出しの遅れ（ミリ秒） */
  delay?: number;
};

/** 送られた本文を呼び出しごとに分けて記録する（find: 図を探す、draft: 下書き） */
async function fakeGemini(page: Page, plan: Plan) {
  const find: string[] = [];
  const draft: string[] = [];
  await page.route(API, async (route: Route) => {
    const body = route.request().postData() ?? '';
    const headers = { 'access-control-allow-origin': '*' };
    if (body.includes('You locate figures')) {
      find.push(body);
      if (plan.delay) await new Promise((r) => setTimeout(r, plan.delay));
      if (typeof plan.figures === 'number') return route.fulfill({ status: plan.figures, contentType: 'application/json', headers, body: JSON.stringify({ error: { message: 'boom' } }) });
      return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ figures: plan.figures }) }] }, finishReason: 'STOP' }] }) });
    }
    draft.push(body);
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(amide) }] }, finishReason: 'STOP' }] }) });
  });
  return { find, draft };
}

/** 化学っぽい図（SVG の線と文字）と本文の、2 ページの PDF */
async function makePdf(browser: Browser): Promise<Buffer> {
  const p = await browser.newPage();
  const svg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200">
    <g fill="none" stroke="#000" stroke-width="2"><polygon points="60,60 90,43 120,60 120,95 90,112 60,95"/><line x1="120" y1="78" x2="170" y2="78"/><line x1="170" y1="78" x2="200" y2="61"/>
    <path d="M230 100 H300" /><polygon points="330,60 360,43 390,60 390,95 360,112 330,95"/></g>
    <text x="200" y="90" font-size="14" font-family="sans-serif">HATU, DIPEA</text><text x="30" y="170" font-size="16" font-family="sans-serif">${label}</text></svg>`;
  await p.setContent(`<html><body style="font: 12pt sans-serif">
    <h1>A short study of amide coupling</h1><p>${'Boc-Ala-OH was coupled with H-Gly-OMe using HATU in DMF at room temperature. '.repeat(8)}</p>
    <div>${svg('Scheme 1')}</div><p>${'The product 3 was obtained in 85% yield. '.repeat(6)}</p>
    <div style="break-before: page">${svg('Scheme 2')}<p>${'Experimental section. '.repeat(20)}</p></div></body></html>`);
  const buf = await p.pdf({ format: 'A4' });
  await p.close();
  return buf;
}

/** 解像度の低い画像（300×150 px の PNG を 288 pt × 144 pt に貼る = 75 dpi）を、ページの左上（40 px の余白）に置いた 1 ページの PDF */
async function makeLowResPdf(browser: Browser): Promise<Buffer> {
  const p = await browser.newPage();
  const png = await p.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 150;
    const x = c.getContext('2d')!;
    x.fillStyle = '#fff';
    x.fillRect(0, 0, 300, 150);
    x.strokeStyle = '#000';
    x.lineWidth = 3;
    x.strokeRect(20, 20, 80, 80);
    x.beginPath();
    x.moveTo(120, 60);
    x.lineTo(180, 60);
    x.stroke();
    x.strokeRect(200, 20, 80, 80);
    return c.toDataURL('image/png');
  });
  await p.setContent(`<html><body style="margin: 0; padding: 40px; font: 12pt sans-serif">
    <img src="${png}" style="width: 384px; height: 192px; display: block"><p>${'Low resolution figure pasted as an image. '.repeat(10)}</p></body></html>`);
  await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const buf = await p.pdf({ format: 'A4' });
  await p.close();
  return buf;
}

/** PNG の IHDR から幅と高さ */
function pngSize(b: Buffer) {
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
/** 送った本文にある画像（1 枚目）の大きさ */
function sentImageSize(body: string) {
  const part = (JSON.parse(body).contents[0].parts as { inline_data?: { mime_type: string; data: string } }[]).find((x) => x.inline_data);
  expect(part?.inline_data?.mime_type).toBe('image/png');
  return pngSize(Buffer.from(part!.inline_data!.data, 'base64'));
}

/** キーを入れる。consented: 同意済みにして始める */
async function openWithKey(page: Page, consented: boolean) {
  if (consented) await page.addInitScript(() => localStorage.setItem('ai-chem-editor:llm', JSON.stringify({ consented: true })));
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  return panel;
}

async function drag(page: Page, view: Locator, x0: number, y0: number, x1: number, y1: number) {
  const b = (await view.boundingBox())!;
  await page.mouse.move(b.x + x0, b.y + y0);
  await page.mouse.down();
  await page.mouse.move(b.x + (x0 + x1) / 2, b.y + (y0 + y1) / 2);
  await page.mouse.move(b.x + x1, b.y + y1);
  await page.mouse.up();
}

const attach = (panel: Locator, buffer: Buffer) => panel.getByTestId('tts-image-input').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer });

test('同意済み: ページを開くと自動で図を探し、範囲が先に描かれ、使うと範囲の画像で送る。同じページは一度だけ探す', async ({ page, browser }) => {
  const pdf = await makePdf(browser);
  const sent = await fakeGemini(page, { figures: ONE, delay: 600 });
  const panel = await openWithKey(page, true);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  // 探している間は状態を出す。やめるボタンもある
  await expect(picker.getByTestId('pdf-find-status')).toHaveText(/AI で図を探しています/);
  await expect(picker.getByTestId('pdf-find-cancel')).toBeVisible();
  await expect(picker.getByTestId('pdf-find')).toHaveCount(0);
  const before = (await picker.boundingBox())!;
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-find-status')).toHaveCount(0);
  await expect(picker.getByTestId('pdf-use')).toHaveText('この範囲を使う');
  // 探し終わって文の行が変わっても、ダイアログは上下に動かない（高さは画面に合わせて決まっている）
  const after = (await picker.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  await expect(picker.getByTestId('pdf-find-one')).toBeVisible();
  expect(sent.find).toHaveLength(1);

  // 2 ページ目へ。探して、範囲を描く。1 ページ目に戻って 2 ページ目に戻っても、探し直さずに範囲を描き直す
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  await expect(picker.getByTestId('pdf-page-view')).toHaveAttribute('data-page', '2');
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  expect(sent.find).toHaveLength(2);
  await picker.locator('[data-testid=pdf-page-thumb][data-page="1"]').click();
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  expect(sent.find).toHaveLength(2);

  // 先に描かれた範囲は、ページの幅の 6 割・高さの 4 分の 1 ほど（余白を足した分だけ少し大きい）
  const view = (await picker.getByTestId('pdf-page-view').boundingBox())!;
  const crop = (await picker.getByTestId('pdf-crop').boundingBox())!;
  expect(crop.width / view.width).toBeGreaterThan(0.58);
  expect(crop.width / view.width).toBeLessThan(0.66);
  expect(crop.height / view.height).toBeGreaterThan(0.24);
  expect(crop.height / view.height).toBeLessThan(0.31);

  // 送る内容を見る: ページ全体の画像の説明と、送り先
  await picker.getByTestId('pdf-find-details').locator('summary').click();
  await expect(picker.getByTestId('pdf-find-preview')).toContainText(/IMAGE: paper\.pdf p\.2（image\/png、\d+×2048 px/);
  await expect(picker.getByTestId('pdf-find-details')).toContainText('図の位置を探すために、このページの画像を Google（Gemini）に送ります');
  await expect(picker.getByTestId('pdf-notice')).toContainText('ページ全体の画像を送ります');
  await expect(picker.getByTestId('pdf-notice')).not.toContainText('選んだ範囲の画像だけを');

  // 使う: 本番に送る画像は範囲の画像（名前は「paper.pdf p.2 (crop)」）
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.2 (crop)');
  await expect(picker).toHaveCount(0);
  await panel.getByTestId('tts-run').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  // 下書きの呼び出しは、図の画像と、その後の本文の文字（画像なし）の 2 回
  expect(sent.draft).toHaveLength(2);
  expect(sent.draft[1]).not.toContain('inline_data');
  expect(JSON.parse(sent.draft[0]).contents[0].parts[0].text).toContain('IMAGE: paper.pdf p.2 (crop)');
  // 図を探す呼び出しにはページ全体の画像（A4 の縦長、長辺 2048 px）、下書きの呼び出しには範囲の画像（横長）
  const whole = sentImageSize(sent.find[1]);
  expect(whole.height).toBe(2048);
  expect(whole.width / whole.height).toBeCloseTo(595 / 842, 1);
  const cropped = sentImageSize(sent.draft[0]);
  expect(cropped.width).toBe(2048);
  expect(cropped.width / cropped.height).toBeGreaterThan(1.3);
  // 図を探す呼び出しに、文章（下書きの指示）や画像の名前は付かない
  expect(sent.find[1]).not.toContain('paper.pdf');
  // 線の図なので、解像度の警告は出ない。AI の注意は出る
  await expect(panel.getByTestId('tts-draft').getByTestId('ai-notice')).toBeVisible();
  await expect(panel.getByTestId('tts-draft').getByTestId('ai-notice-image')).toHaveCount(1);
  await expect(panel.getByTestId('ai-notice-lowres')).toHaveCount(0);
});

test('同意前: 自動では送らない。「AI で図の範囲を探す」を押すと同意の画面を通ってから探す。やめれば送らない', async ({ page, browser }) => {
  const pdf = await makePdf(browser);
  const sent = await fakeGemini(page, { figures: ONE });
  const panel = await openWithKey(page, false);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await expect(picker.getByTestId('pdf-find')).toBeVisible();
  await expect(picker.getByTestId('pdf-find-status')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sent.find).toHaveLength(0);
  // 送る内容は、同意の前でも見られる
  await picker.getByTestId('pdf-find-details').locator('summary').click();
  await expect(picker.getByTestId('pdf-find-preview')).toContainText('IMAGE: paper.pdf p.1（image/png');

  // 同意の画面: 図の範囲のためにページ全体の画像を送ることがある、と書いてある。やめれば送らない
  await picker.getByTestId('pdf-find').click();
  const consent = page.getByTestId('llm-consent');
  await expect(consent).toBeVisible();
  await expect(consent.getByTestId('llm-consent-pdf')).toContainText('図の範囲を探すときは、選んだページ全体の画像を送ることがあります');
  await expect(consent.getByTestId('llm-consent-pdf')).toContainText('Google（Gemini）に送るのは選んだ範囲の画像だけです');
  await consent.getByRole('button', { name: 'やめる' }).click();
  await expect(consent).toHaveCount(0);
  expect(sent.find).toHaveLength(0);
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);

  await picker.getByTestId('pdf-find').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  expect(sent.find).toHaveLength(1);
  await expect(picker.getByTestId('pdf-find')).toHaveCount(0);
  // 同意したので、次のページからは自動で探す
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  expect(sent.find).toHaveLength(2);
  // 下書きの送りでは、もう同意は聞かない
  await picker.getByTestId('pdf-use').click();
  await panel.getByTestId('tts-run').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(sent.draft).toHaveLength(2);
});

test('キーが無ければ、PDF を添付する入口が出ず、AI で図の範囲を探すボタンも出ない。Gemini は呼ばれない', async ({ page, browser }) => {
  const pdf = await makePdf(browser);
  const sent = await fakeGemini(page, { figures: ONE });
  const panel = await openWithKey(page, true);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  expect(sent.find).toHaveLength(1);
  // PDF の画面を閉じ、AI の設定でキーを消す（E2E は本番用のビルドで動かすので、ソースの関数は呼ばずに画面で消す）。
  // 添付の入口も、図を探すボタンも出ず、これ以上は送らない
  await picker.getByTestId('pdf-cancel').click();
  await expect(picker).toHaveCount(0);
  await openLlmSettings(page);
  await page.getByTestId('llm-forget').click();
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByTestId('pdf-find')).toHaveCount(0);
  await expect(page.getByTestId('tts-image-attach')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sent.find).toHaveLength(1);
  expect(sent.draft).toHaveLength(0);
});

test('図が 2 つ: 候補の四角から選ぶ。0 件: メッセージを出して手で選ぶ', async ({ page, browser }) => {
  const pdf = await makePdf(browser);
  const sent = await fakeGemini(page, {
    figures: [
      { box_2d: [50, 50, 300, 900], label: 'Scheme 1', kind: 'reaction-scheme' },
      { box_2d: [500, 50, 800, 900], label: 'Scheme 2', kind: 'reaction-scheme' },
      { box_2d: [850, 50, 950, 900], kind: 'other' },
    ],
  });
  const panel = await openWithKey(page, true);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-found')).toHaveCount(2);
  await expect(picker.getByTestId('pdf-find-choose')).toHaveText('図が複数あります。使う図を選んでください。');
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);
  await expect(picker.getByTestId('pdf-use')).toHaveText('このページ全体を使う');
  // 2 つ目を選ぶ: 範囲になり、候補は消える。範囲を消すと候補が戻る
  await picker.getByTestId('pdf-found').nth(1).click();
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-found')).toHaveCount(0);
  const view = (await picker.getByTestId('pdf-page-view').boundingBox())!;
  const crop = (await picker.getByTestId('pdf-crop').boundingBox())!;
  expect((crop.y - view.y) / view.height).toBeGreaterThan(0.45);
  await picker.getByRole('button', { name: '範囲を消す' }).click();
  await expect(picker.getByTestId('pdf-found')).toHaveCount(2);
  // 候補を押さずにドラッグで選んでもよい
  await picker.locator('.pdf-main').evaluate((e) => (e.scrollTop = 0)); // 2 つ目の候補を押したときに、下へ動いている
  await drag(page, picker.getByTestId('pdf-page-view'), 30, 30, 360, 230);
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-found')).toHaveCount(0);
  expect(sent.find).toHaveLength(1);

  // 0 件
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  await expect(picker.getByTestId('pdf-found')).toHaveCount(2);
});

test('図が見つからない・失敗: メッセージを出し、手で選べる。やめると探すのをやめ、押して探し直せる', async ({ page, browser }) => {
  const pdf = await makePdf(browser);
  const sent = await fakeGemini(page, { figures: [] });
  const panel = await openWithKey(page, true);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-find-none')).toHaveText('図が見つかりませんでした。ドラッグで範囲を選んでください。');
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await drag(page, picker.getByTestId('pdf-page-view'), 30, 30, 360, 230);
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  expect(sent.find).toHaveLength(1);
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.1 (crop)');

  // 失敗（500）: llmErrorText の文を出す。手で選べて、使える。押して探し直せる
  await page.unrouteAll();
  const bad = await fakeGemini(page, { figures: 500 });
  await panel.getByTestId('tts-pdf-reselect').click();
  await expect(picker.getByTestId('pdf-find-error')).toContainText('Gemini の側でエラーが起きました');
  await expect(picker.getByTestId('pdf-find-error')).toContainText('ドラッグで範囲を選んでください');
  await expect(picker.getByTestId('pdf-find')).toBeVisible();
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  expect(bad.find).toHaveLength(1);
  await page.waitForTimeout(500);
  expect(bad.find).toHaveLength(1);
  await picker.getByTestId('pdf-find').click();
  // 画面が静かなままだと、ヘッドレスの Chromium は canvas.toBlob（ページの画像を作る所）の完了を数秒遅らせる。マウスを動かして起こす
  await expect(async () => {
    await page.mouse.move(10, 10 + (Date.now() % 50));
    await expect(picker.getByTestId('pdf-find-error')).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 15_000 });
  await expect(picker.getByTestId('pdf-find-error')).toBeVisible();
  expect(bad.find).toHaveLength(2);
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.1');

  // 探している最中の「やめる」
  await page.unrouteAll();
  const slow = await fakeGemini(page, { figures: ONE, delay: 1500 });
  await panel.getByTestId('tts-pdf-reselect').click();
  await picker.getByTestId('pdf-find-status').waitFor();
  // 返事を待っている間にやめる場合を確かめる。ページの画像を作り終えて要求が届くまで待つ（遅い機械では、画像を作る前にやめると要求を送らない）
  await expect(async () => {
    await page.mouse.move(10, 10 + (Date.now() % 50));
    expect(slow.find).toHaveLength(1);
  }).toPass({ timeout: 15_000 });
  await picker.getByTestId('pdf-find-cancel').click();
  await expect(picker.getByTestId('pdf-find-status')).toHaveCount(0);
  await expect(picker.getByTestId('pdf-find')).toBeVisible();
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);
  await page.waitForTimeout(1800);
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);
  expect(slow.find).toHaveLength(1);
});

test('画像として貼られた図の解像度が低ければ、範囲を選んだときと下書きに警告を出す。範囲が画像に重ならなければ出さない。画像ファイルの添付には出さない', async ({ page, browser }) => {
  const pdf = await makeLowResPdf(browser);
  const sent = await fakeGemini(page, { figures: [] });
  const panel = await openWithKey(page, false);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  // ページ全体で使うときも、画像が貼られていれば警告する（300 px を 4 インチ = 75 dpi）
  // 警告は濃いオレンジ（赤はエラーに見えるので使わない）
  await expect(picker.getByTestId('pdf-lowres')).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  await expect(picker.getByTestId('pdf-lowres')).toContainText(/この図は画像として貼られていて、解像度が低め（約 7[0-9] dpi）です。読み違いがいつもより起きやすくなります/);
  // 画像の上に範囲を選べば出る。画像の無い所を選べば消える
  const view = picker.getByTestId('pdf-page-view');
  await drag(page, view, 60, 60, 300, 180);
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-lowres')).toBeVisible();
  await drag(page, view, 440, 80, 680, 200);
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-lowres')).toHaveCount(0);
  await drag(page, view, 60, 60, 300, 180);
  await expect(picker.getByTestId('pdf-lowres')).toBeVisible();
  await picker.getByTestId('pdf-use').click();
  await expect(picker).toHaveCount(0);

  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  const draft = panel.getByTestId('tts-draft');
  await expect(draft).toBeVisible();
  expect(sent.find).toHaveLength(0); // 同意前は探さない
  await expect(draft.getByTestId('ai-notice')).toBeVisible();
  await expect(draft.getByTestId('ai-notice-image')).toHaveCount(1);
  await expect(draft.getByTestId('ai-notice-lowres')).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  await expect(draft.getByTestId('ai-notice-lowres')).toContainText(/この図は解像度が低い（約 7[0-9] dpi）ので、読み違いがいつもより起きやすくなります。/);
  // 下書きには小さい数だけ残す（画像そのものは残さない）
  const d = await doc(page);
  const dpi = Object.values(d.schemes!)[0].draft!.imageDpi!;
  expect(dpi).toBeGreaterThan(70);
  expect(dpi).toBeLessThan(80);
  expect(JSON.stringify(d)).not.toContain('iVBORw0KGgo');
  // 確定すると警告は消える（下書きではなくなる）
  await panel.getByTestId('tts-confirm').click();
  await expect(panel.getByTestId('ai-notice-lowres')).toHaveCount(0);

  // 画像ファイルの添付: 紙の上の大きさが分からないので、解像度の警告は出さない。AI の注意は出る
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 60; c.height = 30; c.getContext('2d')!.fillRect(5, 5, 20, 20); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png });
  await panel.getByTestId('tts-run').click();
  await expect(draft).toBeVisible();
  await expect(draft.getByTestId('ai-notice-image')).toHaveCount(1);
  await expect(draft.getByTestId('ai-notice-lowres')).toHaveCount(0);
});

test('低い画面（1280×720）でも、解像度の警告と「送る内容を見る」を開いたまま、下のボタンが画面の中に見えていて押せる', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const pdf = await makeLowResPdf(browser);
  await fakeGemini(page, { figures: [{ box_2d: [40, 50, 290, 700], kind: 'reaction-scheme' }] });
  const panel = await openWithKey(page, true);
  await attach(panel, pdf);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-lowres')).toBeVisible();
  await picker.getByTestId('pdf-find-details').locator('summary').click();
  await expect(picker.getByTestId('pdf-find-preview')).toBeVisible();
  // ダイアログ全体はスクロールしない（ボタンがスクロールの先に隠れない）。ボタンの下端はダイアログの中・画面の中
  expect(await picker.evaluate((d) => d.scrollHeight - d.clientHeight)).toBeLessThanOrEqual(1);
  const dlg = (await picker.boundingBox())!;
  // ダイアログ自体も画面に収まる（右の欄の拡大（--side-zoom）の中にあるので、vh で高さを決めるとはみ出す）
  expect(dlg.y).toBeGreaterThanOrEqual(0);
  expect(dlg.y + dlg.height).toBeLessThanOrEqual(720);
  for (const id of ['pdf-use', 'pdf-cancel']) {
    const b = (await picker.getByTestId(id).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(Math.min(dlg.y + dlg.height, 720));
  }
  // ページの絵の欄は縮んでも残る
  expect((await picker.locator('.pdf-main').boundingBox())!.height).toBeGreaterThan(150);
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.1 (crop)');
});

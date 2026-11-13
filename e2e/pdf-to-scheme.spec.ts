import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import { openAi, setApiKey } from './helpers';

// 論文の PDF から図を選んで作る。Gemini は呼ばず、page.route で決まった答えを返す。
// PDF はテストの中で作る（別の page の page.pdf()）。論文・出版社の図は使わない
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

async function fakeGemini(page: Page, answer: unknown) {
  const bodies: string[] = [];
  await page.route(API, async (route: Route) => {
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

/** 化学っぽい図（SVG の線と文字）と本文の、2 ページの PDF を作る */
async function makePdf(browser: Browser): Promise<Buffer> {
  const p = await browser.newPage();
  const svg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200">
    <g fill="none" stroke="#000" stroke-width="2"><polygon points="60,60 90,43 120,60 120,95 90,112 60,95"/><line x1="120" y1="78" x2="170" y2="78"/><line x1="170" y1="78" x2="200" y2="61"/>
    <path d="M230 100 H300" /><polygon points="330,60 360,43 390,60 390,95 360,112 330,95"/></g>
    <text x="200" y="90" font-size="14" font-family="sans-serif">HATU, DIPEA</text><text x="30" y="170" font-size="16" font-family="sans-serif">${label}</text></svg>`;
  await p.setContent(`<html><body style="font: 12pt sans-serif">
    <h1>A short study of amide coupling 簡単な報告</h1><p>${'Boc-Ala-OH was coupled with H-Gly-OMe using HATU in DMF at room temperature. '.repeat(8)}</p>
    <div>${svg('Scheme 1')}</div><p>${'The product 3 was obtained in 85% yield. '.repeat(6)}</p>
    <div style="break-before: page">${svg('Scheme 2')}<p>${'Experimental section. '.repeat(20)}</p></div></body></html>`);
  const buf = await p.pdf({ format: 'A4' });
  await p.close();
  return buf;
}

/** PNG の IHDR から幅と高さ */
function pngSize(b: Buffer) {
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

async function openWithKey(page: Page) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  return panel;
}

/** 大きい絵の上で、(x0, y0) から (x1, y1) までドラッグする（絵の左上からの px） */
async function drag(page: Page, view: Locator, x0: number, y0: number, x1: number, y1: number) {
  const b = (await view.boundingBox())!;
  await page.mouse.move(b.x + x0, b.y + y0);
  await page.mouse.down();
  await page.mouse.move(b.x + (x0 + x1) / 2, b.y + (y0 + y1) / 2);
  await page.mouse.move(b.x + x1, b.y + y1);
  await page.mouse.up();
}

/** 添付欄のサムネイルの画像に、白でない所があるか */
const hasInk = (thumb: Locator) =>
  thumb.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
    return dark;
  });

test('PDF から作る: ページと範囲を選んで画像にし、送る・下書き・やり直し・外すまで', async ({ page, browser }) => {
  const pdf = await makePdf(browser);
  const bodies = await fakeGemini(page, amide);
  const panel = await openWithKey(page);

  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdf });
  const picker = page.getByTestId('pdf-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('pdf-notice')).toContainText('外へは送りません');
  await expect(picker.getByTestId('pdf-page-thumb')).toHaveCount(2);
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await expect(picker.getByTestId('pdf-use')).toHaveText('このページ全体を使う');

  // 2 ページ目を選び、ドラッグで範囲を選ぶ
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  const view = picker.getByTestId('pdf-page-view');
  await expect(view).toHaveAttribute('data-page', '2');
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);
  await drag(page, view, 40, 40, 330, 190);
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  await expect(picker.getByTestId('pdf-use')).toHaveText('この範囲を使う');
  // 選び直せる・消せる
  await drag(page, view, 30, 30, 300, 220);
  await picker.getByRole('button', { name: '範囲を消す' }).click();
  await expect(picker.getByTestId('pdf-crop')).toHaveCount(0);
  await drag(page, view, 30, 30, 360, 230);
  await picker.getByTestId('pdf-use').click();
  await expect(picker).toHaveCount(0);

  const thumb = panel.getByTestId('tts-image-thumb');
  await expect(thumb).toBeVisible();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.2 (crop)');
  expect(await hasInk(thumb)).toBeGreaterThan(500);
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-preview')).toContainText('IMAGE: paper.pdf p.2 (crop)（image/png');

  // 同じ PDF を開き直さずに、ほかの範囲を選ぶ。範囲なしは「p.1」でページ全体（長辺 2048 px）
  await panel.getByTestId('tts-pdf-reselect').click();
  await expect(picker).toBeVisible();
  await picker.getByTestId('pdf-cancel').click();
  await expect(picker).toHaveCount(0);
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.2 (crop)');
  await panel.getByTestId('tts-pdf-reselect').click();
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.1');
  await expect(panel.getByTestId('tts-preview')).toContainText(/IMAGE: paper\.pdf p\.1（image\/png、\d+×2048 px/);

  // 2 ページ目の範囲に戻して送る
  await panel.getByTestId('tts-pdf-reselect').click();
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await drag(page, picker.getByTestId('pdf-page-view'), 30, 30, 360, 230);
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.2 (crop)');
  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent-pdf')).toContainText('PDF はこの端末の中で開き、外へは送りません');
  await expect(page.getByTestId('llm-consent-pdf')).toContainText('査読で預かった原稿は送らないでください');
  await expect(page.getByTestId('llm-consent-pdf')).toContainText('図の範囲を探すときは、選んだページ全体の画像を送ることがあります');
  await expect(page.getByTestId('llm-consent-image')).toBeVisible();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  await expect(panel.getByTestId('tts-draft-image')).toHaveText('『paper.pdf』の 2 ページから読み取りました。');

  // 送ったのは、選んだ範囲の PNG だけ（長辺 2048 px 以下）。PDF は送らない。
  // 2 回目は、本文の図のページの文字だけ（条件を補うため）。画像も PDF も付けない
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).not.toContain('inline_data');
  expect(bodies[1]).not.toContain('application/pdf');
  expect(bodies[1]).toContain('page with the figure');
  const parts = JSON.parse(bodies[0]).contents[0].parts;
  expect(parts[0].text).toContain('IMAGE: paper.pdf p.2 (crop)');
  expect(parts[1].inline_data.mime_type).toBe('image/png');
  expect(bodies[0]).not.toContain('application/pdf');
  const size = pngSize(Buffer.from(parts[1].inline_data.data, 'base64'));
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048);
  expect(Math.max(size.width, size.height)).toBeGreaterThan(300);
  // 文書には画像も PDF も残さない（名前だけ）
  const d = await doc(page);
  expect(Object.values(d.schemes!)[0].draft).toMatchObject({ image: 'paper.pdf p.2 (crop)' });
  const json = JSON.stringify(d);
  expect(json).not.toContain(parts[1].inline_data.data.slice(0, 40));
  expect(json).not.toContain('iVBORw0KGgo');
  expect(json).not.toContain('%PDF');
  expect(json).not.toContain('application/pdf');

  // 外す: 添付も「ほかの範囲を選ぶ」も消える
  await panel.getByTestId('tts-image-remove').click();
  await expect(thumb).toHaveCount(0);
  await expect(panel.getByTestId('tts-pdf-reselect')).toHaveCount(0);
});

test('PDF の添付: 壊れた PDF は理由を出す。やめれば何も添付しない。別の画像に替えると「ほかの範囲を選ぶ」は消える', async ({ page, browser }) => {
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('これは PDF ではありません') });
  await expect(panel.getByTestId('tts-image-error')).toHaveText('PDF を読めませんでした');
  await expect(page.getByTestId('pdf-picker')).toHaveCount(0);
  await expect(panel.getByTestId('tts-image-thumb')).toHaveCount(0);

  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
  await expect(panel.getByTestId('tts-image-error')).toHaveText('PDF を読めませんでした');

  // 拡張子だけが .pdf で型が空でも PDF として開く。やめれば添付されない
  const pdf = await makePdf(browser);
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'paper.pdf', mimeType: '', buffer: pdf });
  await expect(page.getByTestId('pdf-picker')).toBeVisible();
  await expect(panel.getByTestId('tts-image-error')).toHaveCount(0);
  await page.getByTestId('pdf-cancel').click();
  await expect(page.getByTestId('pdf-picker')).toHaveCount(0);
  await expect(panel.getByTestId('tts-image-thumb')).toHaveCount(0);
  await expect(panel.getByTestId('tts-run')).toBeDisabled();

  // 小さすぎる範囲は断る
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByTestId('pdf-use')).toBeEnabled();
  await drag(page, page.getByTestId('pdf-page-view'), 100, 100, 112, 111);
  await page.getByTestId('pdf-use').click();
  await expect(page.getByTestId('pdf-error')).toContainText('範囲が小さすぎます');
  await expect(page.getByTestId('pdf-picker')).toBeVisible();
  await page.getByRole('button', { name: '範囲を消す' }).click();
  await page.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.1');
  await expect(panel.getByTestId('tts-pdf-reselect')).toBeVisible();

  // 別の画像に替えると、PDF は捨てて「ほかの範囲を選ぶ」も消える
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; c.getContext('2d')!.fillRect(10, 10, 50, 50); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png });
  await expect(panel.getByTestId('tts-image-name')).toHaveText('a.png');
  await expect(panel.getByTestId('tts-pdf-reselect')).toHaveCount(0);
});

// pypdf で作った、パスワード（pw）付きの 1 ページの PDF
const ENCRYPTED_PDF = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDViMjEyNGFiYWE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8OWQ4ZWRkYjgwMmNhZjZkODRhY2QzMzk3ZDlkYzVhOTM2NWUzYTBmM2U2MzA0ZDliMDdlOGIyOTdlOTBiNWM5ND4KL1UgPDFkOGRiMDA1ZmQ4ZDZjZGQ3ZjNjMmM2YmI1MDc5M2JhMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjYzNTYxNjY2MTY1NjYzMTMxPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK';

test('パスワードの付いた PDF は開かない', async ({ page }) => {
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'locked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(ENCRYPTED_PDF, 'base64') });
  await expect(panel.getByTestId('tts-image-error')).toHaveText('パスワードの付いた PDF は開けません。パスワードを外してから入れてください');
  await expect(page.getByTestId('pdf-picker')).toHaveCount(0);
});

/** infra/cloudfront.tf の content_security_policy と同じ文字列（本番を変えたらテストも同じになる） */
function productionCsp(): string {
  const tf = readFileSync('infra/cloudfront.tf', 'utf8');
  const block = /content_security_policy = join\("; ", \[([\s\S]*?)\]\)/.exec(tf)![1];
  const parts = block.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"')).map((l) => /^"(.*)",?$/.exec(l)![1]);
  expect(parts.length).toBeGreaterThan(5);
  return parts.join('; ');
}

test('本番と同じ CSP で PDF を開いて描いて画像にしても、CSP の違反が出ない', async ({ page, browser }) => {
  const csp = productionCsp();
  expect(csp).toContain("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'");
  // dev サーバー（Vite）が index.html に入れる HMR 用のインラインのスクリプトだけは、nonce を付けて許す（本番の HTML には無い）。
  // ほかは本番と同じ文字列のまま
  const nonce = 'e2e-vite-dev';
  await page.route(
    (u) => u.pathname === '/',
    async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<script(?![^>]*\bsrc=)/g, `<script nonce="${nonce}"`);
      await route.fulfill({
        response: res,
        body: html,
        headers: { ...res.headers(), 'content-security-policy': csp.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`) },
      });
    },
  );
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => /Content Security Policy|Refused to/i.test(e.message) && violations.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked=${e.blockedURI} source=${e.sourceFile}:${e.lineNumber} ${e.sample}`);
    });
  });
  const pdf = await makePdf(browser);
  const bodies = await fakeGemini(page, amide);
  const panel = await openWithKey(page);
  // CSP がかかっているのに、アプリが動いている
  await expect(panel.getByTestId('tts-image-attach')).toBeVisible();

  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdf });
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-page-thumb')).toHaveCount(2);
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  // 小さい絵も描き終わるまで待つ
  await expect.poll(() => picker.locator('.pdf-thumb canvas').evaluateAll((cs) => cs.every((c) => (c as HTMLCanvasElement).width > 1))).toBe(true);
  await picker.locator('[data-testid=pdf-page-thumb][data-page="2"]').click();
  await drag(page, picker.getByTestId('pdf-page-view'), 30, 30, 360, 230);
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.2 (crop)');
  expect(await hasInk(panel.getByTestId('tts-image-thumb'))).toBeGreaterThan(500);
  // 画像にした後の送りまで
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  // 図の画像と、本文の文字（PDF の文字の取り出しも CSP の中で動く）
  expect(bodies).toHaveLength(2);

  const fromPage = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect([...fromPage, ...violations]).toEqual([]);
});

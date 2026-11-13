import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openAi, setApiKey } from './helpers';

// PDF の中の画像の解像度を、描く命令の並びから測る。評価の PDF（tests/llm-eval/pdfs/、アプリで描いた図から作ったもの）で確かめる。Gemini は呼ばない
// E2E は本番用のビルドで動かすので、ソースを直接読まずに画面（PDF の画面の data-dpi）で測る
type EvalCase = { id: string; base: string; form: 'png' | 'svg' | 'scan'; send: 'page' | 'crop'; pdf: string; crop?: { x: number; y: number; width: number; height: number } };
const cases = (JSON.parse(readFileSync('tests/llm-eval/pdf-cases.json', 'utf8')) as { cases: EvalCase[] }).cases;
/** 件の id から、図の PNG の dpi（72・150・200） */
const dpiOf = (base: string) => Number(/-(\d+)$/.exec(base)![1]);
const pngWidth = (base: string) => readFileSync(`tests/llm-eval/images/${base}.png`).readUInt32BE(16);

/** A4（pt）。評価の PDF はすべて A4 */
const A4_WIDTH = 595.28;

/** キーを入れる（同意はしないので、図を探す呼び出しはしない）。Gemini へは送らせない */
async function openWithKey(page: Page) {
  await page.route('https://generativelanguage.googleapis.com/**', (r) => r.abort());
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  return panel;
}

/** PDF の画面で測った値を読む。測り終えた所（data-dpi-at）を待つ */
async function readDpi(picker: Locator, at: string): Promise<number | null> {
  await expect(picker).toHaveAttribute('data-dpi-at', at);
  const v = (await picker.getAttribute('data-dpi'))!;
  return v === 'none' ? null : Number(v);
}

/** PDF を添付し、ページ全体と、図の範囲（c.crop、pt）をドラッグで選んだときの dpi を、画面で測る */
async function measure(page: Page, panel: Locator, c: EvalCase): Promise<{ crop: number | null; whole: number | null }> {
  await panel.getByTestId('tts-image-input').setInputFiles({ name: c.pdf, mimeType: 'application/pdf', buffer: readFileSync(`tests/llm-eval/pdfs/${c.pdf}`) });
  const picker = page.getByTestId('pdf-picker');
  const whole = await readDpi(picker, '1');
  // 範囲の上端が見えるところまで絵を送ってから、範囲の四角をドラッグする
  const view = picker.getByTestId('pdf-page-view');
  const shown = (await view.boundingBox())!.width;
  const scale = shown / A4_WIDTH;
  // 右の欄の拡大（--side-zoom）の中にあるので、画面の px と scrollTop の単位がずれる。その比で直す
  const zoom = shown / (await view.evaluate((e) => (e as HTMLElement).offsetWidth));
  const r = c.crop!;
  await picker.locator('.pdf-main').evaluate((e, top) => (e.scrollTop = top), Math.max(0, (r.y * scale - 20) / zoom));
  const b = (await view.boundingBox())!;
  await page.mouse.move(b.x + r.x * scale, b.y + r.y * scale);
  await page.mouse.down();
  await page.mouse.move(b.x + (r.x + r.width / 2) * scale, b.y + (r.y + r.height / 2) * scale);
  await page.mouse.move(b.x + (r.x + r.width) * scale, b.y + (r.y + r.height) * scale);
  await page.mouse.up();
  await expect(picker.getByTestId('pdf-crop')).toBeVisible();
  const crop = await readDpi(picker, '1:crop');
  await picker.getByTestId('pdf-cancel').click();
  await expect(picker).toHaveCount(0);
  return { crop, whole };
}

// 各 dpi（72・150・200）から 2 件ずつ。png 形は図の PNG をページに置いた大きさ、scan 形は 150 dpi の画像、svg 形は線の図
const PICK = ['reductive-amination-acs-72', 'boc-protection-acs-72', 'suzuki-lab-150', 'mitsunobu-lab-150', 'amide-hatu-acs-200', 'wittig-acs-200'];

test('評価の PDF: 図の範囲の dpi が、図の PNG の dpi に近い（png）・およそ 150（scan）・null（svg）', async ({ page }) => {
  test.setTimeout(180_000);
  const panel = await openWithKey(page);
  const report: string[] = [];
  for (const base of PICK) {
    for (const form of ['png', 'scan', 'svg'] as const) {
      const c = cases.find((x) => x.base === base && x.form === form && x.send === 'crop')!;
      const got = await measure(page, panel, c);
      report.push(`${c.id}: crop=${got.crop === null ? 'null' : got.crop.toFixed(1)} page=${got.whole === null ? 'null' : got.whole.toFixed(1)}`);
      if (form === 'svg') {
        expect(got.crop, c.id).toBeNull();
      } else if (form === 'scan') {
        expect(got.crop, c.id).toBeGreaterThan(150 * 0.9);
        expect(got.crop, c.id).toBeLessThan(150 * 1.1);
      } else {
        // 図は pngWidth px を、範囲の幅から余白（6 pt ずつ）を引いた幅（pt）に置いたもの。本文の幅に収まらない図は縮めて置くので、その分 dpi が上がる
        const drawnPt = c.crop!.width - 12;
        const want = pngWidth(base) / (drawnPt / 72);
        expect(got.crop, c.id).toBeGreaterThan(want * 0.9);
        expect(got.crop, c.id).toBeLessThan(want * 1.1);
        // 件の dpi 以上で、縮めていなければ件の dpi に近い
        expect(got.crop!, c.id).toBeGreaterThan(dpiOf(base) * 0.9);
      }
    }
  }
  process.stdout.write(report.join('\n') + '\n');
});

import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { openAi, setApiKey } from './helpers';

// 論文の図から作るとき、本文・SI の文字も読んで条件を補い、名前と構造を確かめる。
// Gemini と OPSIN は呼ばず、page.route で決まった答えを返す。PDF はテストの中で作る（論文・出版社の PDF は使わない）
const API = 'https://generativelanguage.googleapis.com/**';
const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

const RIGHT = 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC';
/** ①の答え: 生成物 3 の構造を読み違え（エステルを酸に）、温度・時間は図に無く、収率は 85% */
const figure = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)O', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }], solvent: 'DMF', yield: 85 }],
  questions: [] as string[],
};
const NAME = 'Methyl (tert-butoxycarbonyl)-L-alanylglycinate';
/** ②の答え（SI の文字から）: 名前・温度・時間・収率 82% */
const facts = {
  compounds: [{ label: '3', names: [NAME], page: 'SI p.1', quote: `${NAME} (3)` }],
  steps: [
    {
      to: ['3'],
      from: ['Boc-Ala-OH', 'H-Gly-OMe'],
      reagents: [{ text: 'HATU', equiv: 1.2 }],
      solvent: 'DMF',
      temp: '0 °C',
      time: '3 h',
      yield: 82,
      page: 'SI p.1',
      quote: 'The mixture was stirred at 0 °C for 3 h',
    },
  ],
};

/** 答えを順に返す Gemini の代わり。送った本文を記録する */
async function fakeGemini(page: Page, answers: unknown[]) {
  const bodies: string[] = [];
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '');
    const answer = answers[Math.min(bodies.length - 1, answers.length - 1)];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }),
    });
  });
  return bodies;
}

async function fakeOpsin(page: Page) {
  const sent: string[] = [];
  await page.route('**/api/opsin', async (route: Route) => {
    sent.push(route.request().postData() ?? '');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ status: 'SUCCESS', smiles: RIGHT }] }) });
  });
  return sent;
}

async function makePdf(browser: Browser, html: string): Promise<Buffer> {
  const p = await browser.newPage();
  await p.setContent(`<html><body style="font: 11pt sans-serif">${html}</body></html>`);
  const buf = await p.pdf({ format: 'A4' });
  await p.close();
  return buf;
}

/** 本文（2 ページ。1 ページ目に図）と SI（1 ページ。3 の合成手順） */
async function makePapers(browser: Browser) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="160" viewBox="0 0 420 160"><g fill="none" stroke="#000" stroke-width="2">
    <polygon points="60,60 90,43 120,60 120,95 90,112 60,95"/><path d="M180 78 H260"/><polygon points="300,60 330,43 360,60 360,95 330,112 300,95"/></g>
    <text x="180" y="70" font-size="12" font-family="sans-serif">HATU, DMF</text><text x="320" y="140" font-size="14" font-family="sans-serif">3</text></svg>`;
  const main = await makePdf(
    browser,
    `<h1>A short study of amide coupling</h1><div>${svg}</div><p>Scheme 1: Synthesis of dipeptide 3. Boc-Ala-OH and H-Gly-OMe were coupled with HATU in DMF.</p>
     <div style="break-before: page"><p>${'We thank the reviewers. '.repeat(10)}</p></div>`,
  );
  const si = await makePdf(
    browser,
    `<p>Supporting Information</p><p>General methods. ${'All reactions were carried out under argon in dried glassware. '.repeat(3)}</p>
     <p>${NAME} (3)</p>
     <p>To a solution of Boc-Ala-OH (1.0 mmol) and H-Gly-OMe (1.1 mmol) in DMF (5 mL) was added HATU (1.2 equiv). The mixture was stirred at 0 °C for 3 h and purified to give 3 (82% yield) as a white solid.</p>
     <p>Ethyl 2-oxopropanoate (9)</p>
     <p>${'This paragraph is about something else entirely and should not be sent. '.repeat(4)}</p>`,
  );
  return { main, si };
}

async function openWithKey(page: Page) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  await setApiKey(page);
  await openAi(page);
  return panel;
}

test('本文と SI を足して作る: SI の文字から条件を補い、食い違いは要確認、名前の構造にする、送った段落を外して補い直す', async ({ page, browser }) => {
  const { main, si } = await makePapers(browser);
  const bodies = await fakeGemini(page, [figure, facts, { compounds: [], steps: [] }]);
  const opsin = await fakeOpsin(page);
  const panel = await openWithKey(page);

  // 2 本をまとめて選ぶ（SI を先に選んでも、ファイル名で SI と分かる）
  await panel.getByTestId('tts-image-input').setInputFiles([
    { name: 'paper-SI.pdf', mimeType: 'application/pdf', buffer: si },
    { name: 'paper.pdf', mimeType: 'application/pdf', buffer: main },
  ]);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-si-name')).toHaveText('SI: paper-SI.pdf（1 ページ）');
  await expect(picker.getByTestId('pdf-page-thumb')).toHaveCount(2);
  // 取り違えたら入れ替えられる
  await picker.getByTestId('pdf-si-swap').click();
  await expect(page.getByTestId('pdf-si-name')).toHaveText('SI: paper.pdf（2 ページ）');
  await expect(page.getByTestId('pdf-page-thumb')).toHaveCount(1);
  await page.getByTestId('pdf-si-swap').click();
  await expect(page.getByTestId('pdf-si-name')).toHaveText('SI: paper-SI.pdf（1 ページ）');
  await expect(page.getByTestId('pdf-use')).toBeEnabled();
  await page.getByTestId('pdf-use').click();
  await expect(picker).toHaveCount(0);

  await expect(panel.getByTestId('tts-image-name')).toHaveText('paper.pdf p.1');
  await expect(panel.getByTestId('tts-paper-text')).toContainText('本文と SI（paper-SI.pdf）からも、条件と名前を読む');
  await expect(panel.getByTestId('tts-paper-text-check')).toBeChecked();
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-preview-paper')).toContainText('図の化合物番号が出てくる本文・SI の段落');

  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent-pdf-text')).toContainText('図の化合物の段落の文字も送ります。PDF そのものは送りません');
  await page.getByTestId('llm-consent-ok').click();
  const draft = panel.getByTestId('tts-draft');
  await expect(draft).toBeVisible();

  // ①は画像、②は文字だけ（PDF も画像も送らない）。②には SI の 3 の段落が入り、関係ない段落は入らない
  expect(bodies).toHaveLength(2);
  const second = JSON.parse(bodies[1]);
  expect(bodies[1]).not.toContain('inline_data');
  expect(bodies[1]).not.toContain('%PDF');
  const sentText = second.contents[0].parts.map((p: { text?: string }) => p.text ?? '').join('');
  expect(sentText).toContain('Compounds in the figure: Boc-Ala-OH, H-Gly-OMe, 3');
  expect(sentText).toContain('stirred at 0 °C for 3 h');
  expect(sentText).not.toContain('something else entirely');
  // OPSIN へは名前だけ
  expect(opsin).toEqual([NAME]);

  // 図に無い温度・時間は SI から補い、出所を出す。収率の食い違いは図の値のまま要確認
  await expect(draft.getByTestId('tts-text-sources')).toContainText('1 段目の温度: SI p.1 から補いました');
  await expect(draft.getByTestId('tts-text-sources')).toContainText('1 段目の時間: SI p.1 から補いました');
  await expect(draft.getByTestId('tts-issues')).toContainText('1 段目の収率: 図は 85%、SI p.1 は 82%');
  await expect(draft.getByTestId('ai-notice-paper')).toBeVisible();
  let d = await doc(page);
  const scheme = Object.values(d.schemes!)[0];
  expect(scheme.steps[0]).toMatchObject({ temp: '0 °C', time: '3 h', yield: 85 });

  // 名前の構造と図の構造が違う → 要確認と「名前の構造にする」
  const check = draft.getByTestId('tts-name-checks').locator('li');
  await expect(check).toHaveAttribute('data-result', 'mismatch');
  await expect(draft.getByTestId('tts-issues')).toContainText(`名前「${NAME}」の構造と、図から読んだ構造が違います`);
  await draft.getByTestId('tts-use-name').click();
  await expect(check).toHaveAttribute('data-result', 'replaced');
  await expect(draft.getByTestId('tts-use-name')).toHaveCount(0);
  await expect(draft.getByTestId('tts-issues')).not.toContainText('構造と、図から読んだ構造が違います');
  d = await doc(page);
  const c3 = Object.values(d.compounds!).find((c) => c.number === '3')!;
  expect(Object.values(c3.structure.atoms).filter((a) => a.element === 'O')).toHaveLength(5);
  expect(Object.values(c3.structure.atoms).filter((a) => a.element === 'C')).toHaveLength(11);

  // 送った文字を見て、SI の段落を外して補い直す（図は読み直さない）
  await draft.getByTestId('tts-paper-sent').locator('summary').click();
  const parts = draft.getByTestId('tts-paper-part');
  const n = await parts.count();
  expect(n).toBeGreaterThan(1);
  await expect(draft.getByTestId('tts-paper-refill')).toBeDisabled();
  for (let i = 0; i < n; i++) {
    const label = await parts.nth(i).locator('xpath=..').innerText();
    if (label.startsWith('SI')) await parts.nth(i).uncheck();
  }
  await draft.getByTestId('tts-paper-refill').click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).not.toContain('stirred at 0 °C');
  expect(bodies[2]).not.toContain('inline_data');
  await expect(panel.getByTestId('tts-draft').getByTestId('tts-text-sources')).toHaveCount(0);
  d = await doc(page);
  expect(Object.values(d.schemes!).filter((s) => s.draft)).toHaveLength(1);
  expect(Object.values(d.schemes!)[0].steps[0].temp).toBeUndefined();
  // 文書には PDF も送った文字も残さない（出所と名前の確かめだけ）
  expect(JSON.stringify(d)).not.toContain('%PDF');
  expect(JSON.stringify(d)).not.toContain('purified to give');
});

test('本文・SI の文字を読まないこともできる（チェックを外せば、送るのは図の画像だけ）', async ({ page, browser }) => {
  const { main } = await makePapers(browser);
  const bodies = await fakeGemini(page, [figure]);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: main });
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-si-add')).toBeVisible();
  await expect(picker.getByTestId('pdf-use')).toBeEnabled();
  await picker.getByTestId('pdf-use').click();
  await expect(panel.getByTestId('tts-paper-text')).toContainText('本文からも、条件と名前を読む');
  await panel.getByTestId('tts-paper-text-check').uncheck();
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(bodies).toHaveLength(1);
  await expect(panel.getByTestId('tts-paper')).toHaveCount(0);
  await expect(panel.getByTestId('ai-notice-paper')).toHaveCount(0);
});

test('本文と SI の PDF を、AI の欄にドラッグで落としても添付できる', async ({ page, browser }) => {
  const { main, si } = await makePapers(browser);
  const panel = await openWithKey(page);
  // ブラウザの中で、2 本の PDF を持つ DataTransfer を作って落とす
  const files = [
    { name: 'paper.pdf', data: main.toString('base64') },
    { name: 'paper-SI.pdf', data: si.toString('base64') },
  ];
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer();
    for (const f of fs) d.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: 'application/pdf' }));
    return d;
  }, files);
  await panel.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(panel.getByTestId('tts-drop-hint')).toBeVisible();
  await panel.dispatchEvent('drop', { dataTransfer: dt });
  await expect(panel.getByTestId('tts-drop-hint')).toHaveCount(0);
  const picker = page.getByTestId('pdf-picker');
  await expect(picker.getByTestId('pdf-si-name')).toHaveText('SI: paper-SI.pdf（1 ページ）');
  await expect(picker.getByTestId('pdf-page-thumb')).toHaveCount(2);
});

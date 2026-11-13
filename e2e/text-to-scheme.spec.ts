import { expect, test, type Page, type Route } from '@playwright/test';
import { openAi, setApiKey, openLlmSettings, showTab } from './helpers';

// Gemini は呼ばず、page.route で決まった答えを返す
const API = 'https://generativelanguage.googleapis.com/**';
const doc = (page: Page) => page.evaluate(() => window.__editor!.get().doc);

const amide = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O', confidence: 'high' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC', confidence: 'high' },
    { ref: 'C', name: '3', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC', confidence: 'high' },
  ],
  steps: [{ from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 }],
  questions: [] as string[],
};

/** 送られた本文を記録し、answers を順に返す */
async function fakeGemini(page: Page, ...answers: unknown[]) {
  const bodies: string[] = [];
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '');
    const a = answers.length > 1 ? answers.shift() : answers[0];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] }, finishReason: 'STOP' }] }),
    });
  });
  return bodies;
}

async function openWithKey(page: Page) {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  const panel = page.getByTestId('tts');
  // キーが無いうちは、上のバーに「AI で作る」を出さない
  await expect(page.getByTestId('open-ai')).toHaveCount(0);
  await setApiKey(page);
  await openAi(page);
  return panel;
}

test('文章から下書きを作る: 初めは同意を取り、下書きを描き、確定で普通のスキームになる', async ({ page }) => {
  const bodies = await fakeGemini(page, amide);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  await expect(panel.getByTestId('tts-free-warning')).toBeVisible();
  await expect(panel.getByTestId('tts-free-limits')).toContainText('1〜3 分');
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-preview')).toContainText('HATU で縮合');

  // 初めて送るときは同意を取る。やめれば送らない
  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent')).toBeVisible();
  // 同意の画面: 送り先の名前は設定から。AI の答えは間違っていることがある、という一般の注意も出る
  await expect(page.getByTestId('llm-consent').getByRole('heading')).toHaveText('Google（Gemini）に送ります');
  await expect(page.getByTestId('llm-consent').getByTestId('ai-notice')).toContainText('間違っていることがあります');
  await expect(page.getByTestId('llm-consent').getByTestId('ai-notice')).toContainText('正しいとは限りません');
  await page.getByTestId('llm-consent').getByRole('button', { name: 'やめる' }).click();
  expect(bodies).toHaveLength(0);
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();

  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  // 文章からの下書き: 「元の文章と見比べて」。画像用の一文は出ない
  const notice = panel.getByTestId('tts-draft').getByTestId('ai-notice');
  await expect(notice).toContainText('AI が文章から作った下書きです。間違っていることがあるので、元の文章と見比べてから確定してください。');
  // 確かめられることの範囲は「詳しく」の中
  await expect(notice.getByTestId('ai-notice-more')).toContainText('文章が指す構造と同じかどうかは確かめられません');
  await expect(panel.getByTestId('ai-notice-image')).toHaveCount(0);
  await expect(panel.getByTestId('ai-notice-lowres')).toHaveCount(0);
  expect(bodies).toHaveLength(1);
  const sent = JSON.parse(bodies[0]);
  expect(sent.contents[0].parts[0].text).toContain('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  expect(sent.generationConfig.responseMimeType).toBe('application/json');

  let d = await doc(page);
  const [s] = Object.values(d.schemes!);
  expect(s.draft).toBeTruthy();
  expect(s.steps[0]).toMatchObject({ solvent: 'DMF', temp: 'rt', yield: 85 });
  expect(Object.values(d.texts).map((t) => t.text)).toEqual(expect.arrayContaining(['3', 'DMF, rt, 2 h']));
  await expect(page.getByTestId('smiles')).toContainText('>>');
  // キャンバスでは下書きの枠で囲む（要確認は無い）
  await expect(page.getByTestId('draft-frame')).toHaveCount(1);
  await expect(page.getByTestId('draft-issue')).toHaveCount(0);

  // 2回目からは同意を聞かない
  await panel.getByTestId('tts-confirm').click();
  await expect(panel.getByTestId('tts-draft')).toHaveCount(0);
  await expect(page.getByTestId('draft-frame')).toHaveCount(0);
  d = await doc(page);
  expect(Object.values(d.schemes!)[0].draft).toBeUndefined();
  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent')).toHaveCount(0);
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(Object.keys((await doc(page)).schemes!)).toHaveLength(2);
});

test('構造が分からない化合物は要確認に出し、一覧かキャンバスの印を押すとその分子を選ぶ。やめると下書きと印が消える', async ({ page }) => {
  await fakeGemini(page, { ...amide, compounds: [amide.compounds[0], { ref: 'B', name: 'ABC-123' }, amide.compounds[2]] });
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と ABC-123 を縮合');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  const issues = panel.getByTestId('tts-issues');
  await expect(issues).toContainText('ABC-123: 構造が分かりませんでした');
  await expect(page.getByTestId('draft-issue')).toHaveCount(1);
  await issues.getByRole('button').first().click();
  const sel = await page.evaluate(() => [...window.__editor!.get().selection]);
  const d = await doc(page);
  expect(sel.map((id) => d.atoms[id].abbr)).toEqual(['ABC-123']);

  // キャンバスの上の印: 指すと文を出し、押すとその化合物を選ぶ
  await page.evaluate(() => window.__editor!.set({ selection: new Set() }));
  const mark = page.getByTestId('issue-mark');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute('title', /ABC-123: 構造が分かりませんでした/);
  await mark.click();
  const sel2 = await page.evaluate(() => [...window.__editor!.get().selection]);
  expect(sel2.map((id) => d.atoms[id]?.abbr)).toEqual(['ABC-123']);

  await panel.getByTestId('tts-discard').click();
  await expect(panel.getByTestId('tts-draft')).toHaveCount(0);
  await expect(mark).toHaveCount(0);
  expect(await doc(page)).toMatchObject({ schemes: {}, compounds: {}, atoms: {} });
});

test('LLM の質問に答えて「もう一度」で、答えを付けて送り直し、下書きを置き換える', async ({ page }) => {
  const bodies = await fakeGemini(page, { ...amide, questions: ['溶媒は何ですか？'] }, amide);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と H-Gly-OMe を縮合');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-questions')).toContainText('溶媒は何ですか？');
  await panel.getByTestId('tts-answer').fill('DMF');
  await panel.getByTestId('tts-retry').click();
  await expect(panel.getByTestId('tts-questions')).toHaveCount(0);
  expect(JSON.parse(bodies[1]).contents[0].parts[0].text).toContain('A: DMF');
  expect(Object.keys((await doc(page)).schemes!)).toHaveLength(1);
});

test('キーが違えば理由を言い、下書きは作らない', async ({ page }) => {
  await page.route(API, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }),
    }),
  );
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('x');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-error')).toContainText('キーが違うか');
  expect(Object.keys((await doc(page)).schemes ?? {})).toHaveLength(0);
});

test('手順の無い文章（全合成の名前だけ）は、下書きを作らずに聞き返す。答えて送り直すと下書きを作る', async ({ page }) => {
  const bodies = await fakeGemini(page, { compounds: [], steps: [], questions: ['どの論文の経路ですか？各段の基質・試薬を書いてください'] }, amide);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('Calyciphylline F の全合成スキーム');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-ask')).toContainText('どの論文の経路ですか？');
  await expect(panel.getByTestId('tts-seconds')).toBeVisible();
  expect(Object.keys((await doc(page)).schemes ?? {})).toHaveLength(0);
  await panel.getByTestId('tts-answer').fill('Boc-Ala-OH と H-Gly-OMe を HATU で縮合');
  await panel.getByTestId('tts-retry').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  await expect(panel.getByTestId('tts-ask')).toHaveCount(0);
  expect(JSON.parse(bodies[1]).contents[0].parts[0].text).toContain('A: Boc-Ala-OH と H-Gly-OMe を HATU で縮合');
});

test('考える深さは既定で浅い（速い）。設定で変えると、その深さで送る', async ({ page }) => {
  const bodies = await fakeGemini(page, amide);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('x');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(JSON.parse(bodies[0]).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });

  await openLlmSettings(page);
  await page.getByTestId('llm-thinking').selectOption('medium');
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
  await panel.getByTestId('tts-confirm').click();
  await panel.getByTestId('tts-run').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  expect(JSON.parse(bodies[1]).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
});

test('無料のキーで 1 日の上限に当たると、無料ではよくあることと戻る時刻を言う。有料のキーにすると、無料の案内は消える', async ({ page }) => {
  await page.route(API, (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: { code: 429, message: 'Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }),
    }),
  );
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('x');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-error')).toContainText('使える量の上限');
  await expect(panel.getByTestId('tts-error')).toContainText('16〜17 時ごろに戻ります');

  await openLlmSettings(page);
  await page.getByTestId('llm-paid').check();
  await page.getByTestId('llm-settings').getByRole('button', { name: '閉じる' }).click();
  await expect(panel.getByTestId('tts-free-limits')).toHaveCount(0);
  await panel.getByTestId('tts-run').click();
  await expect(panel.getByTestId('tts-error')).toContainText('使える量の上限');
  await expect(panel.getByTestId('tts-error')).not.toContainText('無料のキー');
});

test('言葉で直す: 操作の並びを差の一覧で見せ、確定で図を直す。元に戻すで戻る。使えない指示は理由を出す', async ({ page }) => {
  const bodies = await fakeGemini(
    page,
    amide,
    {
      ops: [
        { op: 'replace_reagent', step: 1, reagent: 'DIPEA', text: 'Et3N', equiv: 3 },
        { op: 'set_condition', step: 1, field: 'yield', value: '92' },
        { op: 'renumber', start: 1 },
        { op: 'set_style', style: 'footnote' },
        { op: 'replace_reagent', step: 2, reagent: 'TFA', text: 'HCl' },
      ],
      questions: [],
    },
  );
  const panel = await openWithKey(page);
  // スキームが無いうちは、直すの入口（スキームの欄の「AI で」）を出さない
  await showTab(page, 'scheme');
  await expect(page.getByTestId('scheme-ai')).toHaveCount(0);
  await openAi(page, 'create');
  await panel.getByTestId('tts-text').fill('Boc-Ala-OH と H-Gly-OMe を HATU で縮合して 3 を得た');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await panel.getByTestId('tts-confirm').click();

  await openAi(page, 'edit');
  await panel.getByTestId('tts-text').fill('DIPEA を Et3N にして、収率は 92%。番号を振り直して脚注の書式に');
  await expect(panel.getByTestId('tts-run')).toHaveText('直し方を作る');
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-preview')).toContainText('reagents=HATU (1.2 equiv) | DIPEA (3 equiv)');
  const before = await doc(page);
  await panel.getByTestId('tts-run').click();

  // 直し方にも AI の注意（会社・モデルの名前は入れない）
  const editNotice = panel.getByTestId('tts-proposal').getByTestId('ai-notice');
  await expect(editNotice).toContainText('AI が作った直し方です');
  await expect(editNotice).toContainText('指示のとおりに直せているとは限らない');
  await expect(editNotice).not.toContainText('Gemini');
  const changes = panel.getByTestId('tts-changes');
  await expect(changes).toContainText('1 段目の試薬: HATU (1.2 equiv), DIPEA (3 equiv) → HATU (1.2 equiv), Et3N (3 equiv)');
  await expect(changes).toContainText('1 段目の収率: 85 → 92');
  await expect(changes).toContainText('書式: ACS（条件を矢印の上下） → 脚注（Reagents and conditions）');
  await expect(changes).toContainText('化合物番号:');
  await expect(panel.getByTestId('tts-rejected')).toContainText('2 段目がありません');
  expect(JSON.parse(bodies[1]).contents[0].parts[0].text).toContain('INSTRUCTION:\nDIPEA を Et3N に');
  // 確定するまで文書は変わらない
  expect(await doc(page)).toEqual(before);

  await panel.getByTestId('tts-edit-confirm').click();
  await expect(panel.getByTestId('tts-proposal')).toHaveCount(0);
  let d = await doc(page);
  let [s] = Object.values(d.schemes!);
  expect(s.styleId).toBe('footnote');
  expect(s.steps[0]).toMatchObject({ yield: 92, reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'Et3N', equiv: 3 }] });
  expect(Object.values(d.compounds!).map((c) => c.number).sort()).toEqual(['1', '2', '3']);

  // 元に戻す1回で、直す前に戻る
  await page.getByTitle('元に戻す (Ctrl+Z)').click();
  d = await doc(page);
  [s] = Object.values(d.schemes!);
  expect(s.styleId).toBe('acs');
  expect(s.steps[0].reagents.map((r) => r.text)).toEqual(['HATU', 'DIPEA']);
});

test('言葉で直す: やめると何も変えない。質問だけが返れば、答えて送り直せる', async ({ page }) => {
  const bodies = await fakeGemini(page, amide, { ops: [], questions: ['どの試薬を替えますか？'] }, { ops: [{ op: 'set_condition', step: 1, field: 'temp', value: '0 °C' }], questions: [] });
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('縮合');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await panel.getByTestId('tts-confirm').click();
  const before = await doc(page);

  await openAi(page, 'edit');
  await panel.getByTestId('tts-text').fill('試薬を替えて');
  await panel.getByTestId('tts-run').click();
  await expect(panel.getByTestId('tts-no-change')).toBeVisible();
  await expect(panel.getByTestId('tts-edit-confirm')).toBeDisabled();
  await panel.getByTestId('tts-answer').fill('温度を 0 °C に');
  await panel.getByTestId('tts-retry').click();
  await expect(panel.getByTestId('tts-changes')).toContainText('1 段目の温度: rt → 0 °C');
  expect(JSON.parse(bodies[2]).contents[0].parts[0].text).toContain('A: 温度を 0 °C に');

  await panel.getByTestId('tts-edit-discard').click();
  await expect(panel.getByTestId('tts-proposal')).toHaveCount(0);
  expect(await doc(page)).toEqual(before);
});

/** 下書きを作って確定し、「直す」にする。化合物の id（A・B・C の順）を返す */
async function confirmedAmide(page: Page) {
  await fakeGemini(page, amide);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-text').fill('縮合');
  await panel.getByTestId('tts-run').click();
  await page.getByTestId('llm-consent-ok').click();
  await panel.getByTestId('tts-confirm').click();
  await openAi(page, 'edit');
  const s = Object.values((await doc(page)).schemes!)[0];
  return { panel, ids: [...s.steps[0].from, ...s.steps[0].to] };
}
const CBZ_ALA = 'O=C(OCc1ccccc1)N[C@@H](C)C(=O)O';
const CBZ_DIPEPTIDE = 'O=C(OCc1ccccc1)N[C@@H](C)C(=O)NCC(=O)OC';

test('言葉で直す（構造）: 指示で番号を書いた化合物だけ書き換え、指していない化合物は理由を出して書き換えない', async ({ page }) => {
  const { panel, ids } = await confirmedAmide(page);
  const [a, , c] = ids;
  // 後から登録した route が先に使われる
  const bodies = await fakeGemini(page, {
    ops: [
      { op: 'replace_structure', compound: c, smiles: CBZ_DIPEPTIDE, from_group: 'Boc', to_group: 'Cbz' },
      { op: 'replace_structure', compound: a, smiles: CBZ_ALA, from_group: 'Boc', to_group: 'Cbz' },
    ],
    questions: [],
  });
  await panel.getByTestId('tts-text').fill('3 の Boc を Cbz に');
  await panel.getByTestId('tts-run').click();
  await expect(panel.getByTestId('tts-changes')).toContainText(/3 の構造: C11H20N2O5 → C14H18N2O5/);
  await expect(panel.getByTestId('tts-rejected')).toContainText('Boc-Ala-OH は指示でも選択でも指していないので、構造を書き換えません');
  await expect(panel.getByTestId('tts-edit-warnings')).toHaveCount(0);
  await expect(panel.getByTestId('tts-whole-scheme')).toHaveCount(0);
  expect(JSON.parse(bodies[0]).contents[0].parts[0].text).toContain('SELECTED: (none)');

  await panel.getByTestId('tts-edit-confirm').click();
  const d = await doc(page);
  const carbons = (id: string) => Object.values(d.compounds![id].structure.atoms).filter((x) => x.element === 'C').length;
  expect(carbons(c)).toBe(14);
  expect(carbons(a)).toBe(8);
  expect(d.compounds![c].number).toBe('3');
});

test('言葉で直す（構造）: 選んだ化合物は書き換える。確かめに合わなければ要確認を出し、確定はできる。スキーム全体の書き換えは目立たせる', async ({ page }) => {
  const { panel, ids } = await confirmedAmide(page);
  const [a] = ids;
  // A（Boc-Ala-OH）の分子を選ぶ
  await page.evaluate((cid) => {
    const e = window.__editor!;
    const d = e.get().doc;
    e.set({ selection: new Set(Object.values(d.atoms).filter((x) => x.ref?.endsWith(`:${cid}`)).map((x) => x.id)) });
  }, a);
  const bodies = await fakeGemini(page, {
    // 立体が消えた Cbz 体
    ops: [{ op: 'replace_structure', compound: a, smiles: 'O=C(OCc1ccccc1)NC(C)C(=O)O', from_group: 'Boc', to_group: 'Cbz' }],
    whole_scheme: true,
    questions: [],
  });
  await panel.getByTestId('tts-text').fill('スキーム全体で Boc を Cbz に');
  await panel.getByTestId('tts-run').click();
  expect(JSON.parse(bodies[0]).contents[0].parts[0].text).toContain(`SELECTED: ${a}`);
  await expect(panel.getByTestId('tts-whole-scheme')).toBeVisible();
  await expect(panel.getByTestId('tts-edit-warnings')).toContainText('要確認: Boc-Ala-OH: 立体の決まった不斉中心の数が 1 → 0 に変わりました');
  await expect(panel.getByTestId('tts-edit-confirm')).toBeEnabled();
  await panel.getByTestId('tts-edit-confirm').click();
  await expect(panel.getByTestId('tts-proposal')).toHaveCount(0);
});

/** テストのための画像をページの中で描く（自分で作った画像だけを使う。論文の図は使わない） */
async function makePng(page: Page, width: number, height: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d')!;
      x.fillStyle = '#fff';
      x.fillRect(0, 0, w, h);
      x.font = `${Math.round(h / 4)}px sans-serif`;
      x.fillStyle = '#000';
      x.fillText('A + B → C', w / 10, h / 2);
      return c.toDataURL('image/png').split(',')[1];
    },
    [width, height],
  );
  return Buffer.from(b64, 'base64');
}

test('画像から下書きを作る: 添付すると縮めて inline_data で送り、文章が無くても作れる。同意と添付欄に権利の注意を出す', async ({ page }) => {
  const bodies = await fakeGemini(page, { ...amide, questions: ['溶媒は何ですか？'] }, amide);
  const panel = await openWithKey(page);
  await expect(panel.getByTestId('tts-image-rights')).toContainText('権利を持っているもの');
  await expect(panel.getByTestId('tts-run')).toBeDisabled();

  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'scheme.png', mimeType: 'image/png', buffer: await makePng(page, 3000, 1000) });
  await expect(panel.getByTestId('tts-image-thumb')).toBeVisible();
  await expect(panel.getByTestId('tts-image-name')).toHaveText('scheme.png');
  await expect(panel.getByTestId('tts-run')).toBeEnabled();
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-preview')).toContainText('IMAGE: scheme.png（image/png、2048×683 px');

  await panel.getByTestId('tts-run').click();
  await expect(page.getByTestId('llm-consent-image')).toContainText('AI に入れてよいと許されているもの');
  await page.getByTestId('llm-consent-ok').click();
  await expect(panel.getByTestId('tts-draft')).toBeVisible();
  await expect(panel.getByTestId('tts-draft-image')).toContainText('scheme.png');
  // 画像からの下書き: 「元の図と見比べて」と、読み違えやすい所。解像度の警告は出ない（画像ファイルは紙の上の大きさが分からない）
  await expect(panel.getByTestId('tts-draft').getByTestId('ai-notice')).toContainText('元の図と見比べてから確定してください。');
  await expect(panel.getByTestId('ai-notice-image')).toHaveText('置換の位置、環の大きさ、くさびの向きは、特に読み違えやすいところです。');
  await expect(panel.getByTestId('ai-notice-lowres')).toHaveCount(0);
  const parts = JSON.parse(bodies[0]).contents[0].parts;
  expect(parts[0].text).toContain('IMAGE: scheme.png');
  expect(parts[0].text).toContain('TEXT:\n(none)');
  expect(parts[1].inline_data.mime_type).toBe('image/png');
  expect(parts[1].inline_data.data.length).toBeGreaterThan(100);
  // 文書には画像そのものを残さない（ファイル名だけ）
  const d = await doc(page);
  expect(Object.values(d.schemes!)[0].draft).toMatchObject({ image: 'scheme.png' });
  expect(JSON.stringify(d)).not.toContain(parts[1].inline_data.data.slice(0, 40));

  // 下書きの質問に答えて送り直すときも、同じ画像を送る
  await panel.getByTestId('tts-answer').fill('DMF');
  await panel.getByTestId('tts-retry').click();
  await expect(panel.getByTestId('tts-questions')).toHaveCount(0);
  expect(JSON.parse(bodies[1]).contents[0].parts[1].inline_data.data).toBe(parts[1].inline_data.data);
  expect(JSON.parse(bodies[1]).contents[0].parts[0].text).toContain('A: DMF');
});

test('画像の添付: 送れない形式は理由を出す。貼り付けでも添付でき、外せる', async ({ page }) => {
  await fakeGemini(page, amide);
  const panel = await openWithKey(page);
  await panel.getByTestId('tts-image-input').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await expect(panel.getByTestId('tts-image-error')).toContainText('PNG・JPEG・WebP');
  await expect(panel.getByTestId('tts-image-thumb')).toHaveCount(0);

  // 文章欄に貼り付ける
  const b64 = (await makePng(page, 200, 100)).toString('base64');
  await panel.getByTestId('tts-text').evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await expect(panel.getByTestId('tts-image-name')).toHaveText('pasted.png');
  await expect(panel.getByTestId('tts-image-error')).toHaveCount(0);
  await panel.getByText('送る内容を見る').click();
  await expect(panel.getByTestId('tts-preview')).toContainText('200×100 px');

  await panel.getByTestId('tts-image-remove').click();
  await expect(panel.getByTestId('tts-image-thumb')).toHaveCount(0);
  await expect(panel.getByTestId('tts-run')).toBeDisabled();

});

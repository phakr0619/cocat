// 公開したサイトの確かめ（Deploy の最後に動かす。手元からも動かせる）。おかしければ終了コード 1。
//
//   node tools/smoke.mjs <サイトの URL> [期待する版] [index.html のファイル]
//
// - 期待する版を渡すと、「このツールについて」の版がそれになっているかを見る
// - index.html を渡すと、公開の index.html がそれと同じ JS を読んでいるか（新しい版が届いているか）を見る。
//   CloudFront のキャッシュが消えるまで、少し待ってやり直す
// - ブラウザで開くときは、使い方の統計を止めてから開く（本番の数字に混ぜない）。/e は中身の無い HEAD で確かめる
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [site, expectedVersion, indexFile] = process.argv.slice(2);
if (!site) {
  console.error('使い方: node tools/smoke.mjs <サイトの URL> [期待する版] [index.html のファイル]');
  process.exit(2);
}
const base = site.replace(/\/$/, '');
const failures = [];
const ok = (name) => console.log(`OK   ${name}`);
const ng = (name, why) => {
  console.log(`NG   ${name}: ${why}`);
  failures.push(name);
};
const check = (name, cond, why) => (cond ? ok(name) : ng(name, why));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsOf = (html) => html.match(/\/assets\/index-[\w-]+\.js/)?.[0];

// 1. ページとヘッダー（新しい版が届くまで、最大 3 分待つ）
const wantJs = indexFile ? jsOf(readFileSync(indexFile, 'utf8')) : null;
let res;
let html = '';
for (let i = 0; i < 18; i++) {
  res = await fetch(`${base}/`, { cache: 'no-store' });
  html = await res.text();
  if (!wantJs || jsOf(html) === wantJs) break;
  await sleep(10_000);
}
check('ページが開く', res.status === 200, `HTTP ${res.status}`);
if (wantJs) check('新しい版の index.html が届いている', jsOf(html) === wantJs, `公開: ${jsOf(html)} / 期待: ${wantJs}`);
const h = (k) => res.headers.get(k) ?? '';
check('CSP（RDKit の wasm を許す）', h('content-security-policy').includes("'wasm-unsafe-eval'") && h('content-security-policy').includes("connect-src 'self'"), h('content-security-policy') || '無い');
check('HSTS', h('strict-transport-security').includes('max-age='), h('strict-transport-security') || '無い');
check('ほかのサイトに埋め込ませない', h('x-frame-options') === 'DENY', h('x-frame-options') || '無い');
check('nosniff', h('x-content-type-options') === 'nosniff', h('x-content-type-options') || '無い');
check('index.html は毎回確かめる', h('cache-control').includes('no-cache'), h('cache-control') || '無い');

// 2. JS と RDKit の wasm
const js = jsOf(html);
if (!js) ng('JS', 'index.html に /assets/index-*.js が無い');
else {
  const r = await fetch(base + js);
  const body = await r.text();
  check('JS が届く', r.status === 200 && !!r.headers.get('content-type')?.includes('javascript'), `HTTP ${r.status} ${r.headers.get('content-type')}`);
  const wasm = body.match(/RDKit_minimal-[\w-]+\.wasm/)?.[0];
  if (!wasm) ng('RDKit の wasm', 'JS の中に wasm の名前が無い');
  else {
    const w = await fetch(`${base}/assets/${wasm}`, { method: 'HEAD' });
    check('RDKit の wasm が application/wasm で届く', w.status === 200 && w.headers.get('content-type') === 'application/wasm', `HTTP ${w.status} ${w.headers.get('content-type')}`);
  }
}

// 3. 使い方の統計の受け口（中身の無い HEAD。集計では名前が無いので数えない）
const e = await fetch(`${base}/e`, { method: 'HEAD', cache: 'no-store' });
check('/e が 204 を返す', e.status === 204, `HTTP ${e.status}`);

// 4. 本物のブラウザで開く
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), proxy });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: !!proxy, viewport: { width: 1366, height: 768 } });
  const errors = [];
  const events = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => new URL(r.url()).pathname === '/e' && events.push(r.url()));
  // 統計を止めてから読み込む（src/analytics.ts の止める印）
  await page.addInitScript(() => localStorage.setItem('ai-chem-editor:analytics-optout', '1'));
  await page.goto(`${base}/`);
  let loaded = false;
  try {
    await page.getByTestId('canvas').waitFor({ timeout: 60_000 });
    loaded = true;
    ok('ブラウザで開き、RDKit が読み込まれる');
  } catch {
    ng('ブラウザで開き、RDKit が読み込まれる', (await page.locator('#root').innerText()).slice(0, 200));
  }
  if (loaded) {
    // 見本は「ファイル」のメニューの中（2026-11 の画面の作り直しから）
    await page.getByTestId('menu-file').click();
    await page.getByTestId('sample-conditions').click();
    await page.waitForTimeout(1000);
    const d = await page.evaluate(() => {
      const doc = window.__editor?.get().doc;
      return doc ? { atoms: Object.keys(doc.atoms).length, tables: Object.keys(doc.tables ?? {}).length, schemes: Object.keys(doc.schemes ?? {}).length } : null;
    });
    check('見本「条件検討の表」が開く（反応式と表）', !!d && d.atoms > 0 && d.tables === 1 && d.schemes === 1, JSON.stringify(d));
    const smiles = (await page.getByTestId('smiles').textContent()) ?? '';
    check('反応 SMILES が出る', smiles.includes('>>'), smiles.slice(0, 80));
    if (expectedVersion) {
      await page.getByTestId('menu-help').click();
      await page.getByTestId('open-about').click();
      const about = (await page.getByTestId('about').textContent()) ?? '';
      const shown = about.match(/版: ([\w.+-]+)/)?.[1];
      check('版が今の Deploy のもの', shown === expectedVersion, `公開: ${shown ?? '版が無い'} / 期待: ${expectedVersion}`);
    }
  }
  check('コンソールにエラーが無い', !errors.length, errors.join(' / ').slice(0, 300));
  check('統計を止めると何も送らない', !events.length, events.join(' '));
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n${failures.length} 件おかしい: ${failures.join('、')}`);
  process.exit(1);
}
console.log('\nすべて OK');

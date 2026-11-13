// PDF からスキームの評価の PDF と画像を作る。ふだんのテストでは飛ばす
//
//   PowerShell:  $env:MAKE_EVAL_PDFS = "1"; npx playwright test e2e/make-eval-pdfs.spec.ts
//
// PDF はすべて自分たちで作ったもの（このアプリで描いた図 ＋ 正解から作った架空の本文。論文・出版社の図は使わない）。
// 件（image-cases.json の 20 件）ごとに、図の入れ方 3 つ（png・svg・scan）の PDF を A4 の 1 ページで作り、
// アプリと同じ部品（src/llm/pdf.ts の openPdf・cropToImage）で「ページ全体」と「図の範囲」の PNG にして保存する。
// 本物の評価（tests/llm-eval/pdf.eval.ts）は、その PNG を送る（node で pdf.js を描かない）
//   tests/llm-eval/pdfs/{id}-{form}.pdf、tests/llm-eval/pdf-images/{id}-{form}-{page|crop}.png、tests/llm-eval/pdf-cases.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildPlan, drawScheme, loadEvalCases, openApp, type EvalPlan } from './eval-scheme';

const PDF_DIR = 'tests/llm-eval/pdfs';
const IMG_DIR = 'tests/llm-eval/pdf-images';
const FORMS = ['png', 'svg', 'scan'] as const;
/** アプリが送る前に縮める長辺。図の画像はこれを超えないように描く（make-eval-images.spec.ts と同じ） */
const MAX_SIDE = 2048;
/** スキャンの形にするときの解像度 */
const SCAN_DPI = 150;
/** 図の範囲に足す余白（pt）。図を切らないために少し広げる */
const CROP_PAD_PT = 6;
/** A4 の本文の幅（CSS px。余白 20 mm ずつ） */
const BODY_PX = 794 - 2 * 76;

// MAKE_EVAL_PDFS=1: PDF・画像・pdf-cases.json を作り直す。MAKE_EVAL_PDFS=pages: コミットしてある PDF から、ページ全体の PNG だけを作る
// （ページ全体の PNG は 1 枚 250〜370 KB と大きいので、リポジトリには入れていない。評価の前にこれで作る）
const MODE = process.env.MAKE_EVAL_PDFS;
test.skip(!MODE, 'MAKE_EVAL_PDFS=1（全部）か pages（ページ全体の PNG だけ）のときだけ作る');

// ---- 架空の本文（正解から作る。図と同じ条件だけを書く。食い違いは段3 の評価） ----

const FILLER = [
  'Methods for assembling this class of molecules have been reviewed extensively, and the choice among them is usually dictated by the availability of starting materials.',
  'The work described here was carried out as part of a small internal study, and all of the data discussed below were collected over a period of several months.',
  'Care was taken to keep the procedures simple so that they could be repeated by a student with little prior experience.',
  'A fictitious group of authors prepared this page only as a test document for software; none of the statements in it describe real experiments.',
  'The general layout follows the usual order of a short communication: a brief introduction, a description of the route, and an experimental section.',
];

const join = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** 化合物の呼び方。番号つきなら "2"、番号なしなら役割（図に番号は無いので、本文にも作らない） */
function namer(plan: EvalPlan, numbered: boolean) {
  const num = new Map(plan.compounds.map((c) => [c.ref, c.name]));
  const produced = new Set(plan.steps.flatMap((s) => s.to));
  return (refs: string[], role: 'from' | 'to') => {
    if (numbered) return `${refs.length > 1 && role === 'from' ? 'compounds' : 'compound'} ${join(refs.map((r) => num.get(r)!))}`;
    if (role === 'to') return 'the product';
    return refs.every((r) => produced.has(r)) ? 'the intermediate' : refs.length > 1 ? 'the two starting materials' : 'the starting material';
  };
}

/** 段ごとの文。例: "Compound 3 was prepared from compounds 1 and 2 using HATU and DIPEA in DMF at 80 °C (85%)." */
function stepSentences(plan: EvalPlan, numbered: boolean, style: 'results' | 'experimental'): string[] {
  const name = namer(plan, numbered);
  return plan.steps.map((st) => {
    const to = name(st.to, 'to');
    const from = name(st.from, 'from');
    const reagents = st.reagents.map((r) => r.text);
    const how = [reagents.length ? `using ${join(reagents)}` : '', st.solvent ? `in ${st.solvent}` : '', st.temp ? `at ${st.temp}` : ''].filter(Boolean).join(' ');
    const y = st.yield != null ? ` (${st.yield}%)` : '';
    const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
    return style === 'results'
      ? `${cap(to)} was prepared from ${from}${how ? ` ${how}` : ''}${y}.`
      : `${cap(to)} was obtained${st.yield != null ? ` in ${st.yield}% yield` : ''} by treating ${from}${how ? ` ${how.replace(/^using /, 'with ')}` : ''}.`;
  });
}

// ---- 論文らしい 1 ページの HTML ----

function paperHtml(a: { index: number; plan: EvalPlan; numbered: boolean; figure: string; figureCss: string }): string {
  const results = stepSentences(a.plan, a.numbered, 'results').join(' ');
  const experimental = stepSentences(a.plan, a.numbered, 'experimental').join(' ');
  const f = (i: number) => FILLER[(a.index + i) % FILLER.length];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 210mm 297mm; margin: 0; }
    html, body { margin: 0; background: #fff; }
    body { padding: 20mm; font: 10pt/1.45 'Times New Roman', 'Liberation Serif', serif; color: #111; }
    .journal { font: 8pt sans-serif; color: #555; border-bottom: 1px solid #999; padding-bottom: 4px; margin-bottom: 14px; }
    h1 { font-size: 16pt; line-height: 1.2; margin: 0 0 6px; }
    .authors { font-size: 10pt; margin-bottom: 2px; } .affil { font-size: 8.5pt; color: #444; margin-bottom: 12px; }
    h2 { font-size: 10.5pt; margin: 12px 0 3px; } p { margin: 0 0 6px; text-align: justify; }
    .fig { margin: 18px 0 14px; text-align: center; } .fig .cap { margin-top: 14px; font-size: 9pt; text-align: left; }
    ${a.figureCss}
  </style></head><body>
    <div class="journal">Example Journal of Synthetic Methods (fictitious) &middot; Short Communication</div>
    <h1>A Practical Route to Functionalized Building Blocks</h1>
    <div class="authors">A. Example, B. Sample and C. Placeholder</div>
    <div class="affil">Department of Imaginary Chemistry, University of Nowhere</div>
    <h2>Introduction</h2><p>${f(0)} ${f(1)}</p>
    <h2>Results and discussion</h2><p>${f(2)} The route outlined in Scheme 1 was examined first. ${results} ${f(3)}</p>
    <div class="fig">${a.figure}<div class="cap"><b>Scheme 1.</b> Synthetic route examined in this study.</div></div>
    <h2>Experimental section</h2><p>All reactions were run in oven-dried glassware under an inert atmosphere unless noted otherwise. ${experimental} ${f(4)}</p>
  </body></html>`;
}

function scanHtml(png: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 210mm 297mm; margin: 0; }
    html, body { margin: 0; padding: 0; width: 210mm; height: 297mm; overflow: hidden; background: #fff; }
    img { display: block; width: 210mm; height: 297mm; }
  </style></head><body><img src="data:image/png;base64,${png}"></body></html>`;
}

// ---- PDF → PNG（アプリと同じ部品を、ページの中で動かす） ----

type Crop = { x: number; y: number; width: number; height: number };
type PdfImage = { data: string; width: number; height: number; bytes: number; name: string };

async function pdfToImage(page: Page, a: { pdf: string; fileName: string; crop?: Crop }): Promise<{ numPages: number; image: PdfImage }> {
  return page.evaluate(
    async ({ pdf, fileName, crop, src }) => {
      const { openPdf } = (await import(/* @vite-ignore */ `${src}/llm/pdf.ts`)) as typeof import('../src/llm/pdf');
      const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
      const o = await openPdf(new File([bytes], fileName, { type: 'application/pdf' }));
      if (!o.ok) throw new Error(o.error);
      try {
        const r = await o.pdf.cropToImage(1, crop);
        if (!r.ok) throw new Error(r.error);
        const { data, width, height, bytes: n, name } = r.image;
        return { numPages: o.pdf.numPages, image: { data, width: width!, height: height!, bytes: n, name } };
      } finally {
        o.pdf.destroy();
      }
    },
    { ...a, src: '/src' },
  );
}

/** PDF の 1 ページ目を、決まった解像度の画像にする（スキャンの形を作る）。画面に出す部品の renderPage と同じ描き方 */
async function renderScan(page: Page, pdf: string): Promise<string> {
  return page.evaluate(
    async ({ pdf, scale, src }) => {
      const { openPdf } = (await import(/* @vite-ignore */ `${src}/llm/pdf.ts`)) as typeof import('../src/llm/pdf');
      const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
      const o = await openPdf(new File([bytes], 'src.pdf', { type: 'application/pdf' }));
      if (!o.ok) throw new Error(o.error);
      try {
        const canvas = document.createElement('canvas');
        await o.pdf.renderPage(1, canvas, scale);
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
        const buf = new Uint8Array(await blob!.arrayBuffer());
        let s = '';
        for (const x of buf) s += String.fromCharCode(x);
        return btoa(s);
      } finally {
        o.pdf.destroy();
      }
    },
    { pdf, scale: SCAN_DPI / 72, src: '/src' },
  );
}

test('評価の PDF と画像を作る', async ({ page, context }) => {
  test.skip(MODE !== '1', 'MAKE_EVAL_PDFS=1 のときだけ');
  test.setTimeout(900_000);
  const { cases, bases } = loadEvalCases();
  mkdirSync(PDF_DIR, { recursive: true });
  mkdirSync(IMG_DIR, { recursive: true });
  await openApp(page);
  const doc = await context.newPage(); // 本文の HTML を PDF にする
  // 図の位置を、PDF にするときの配置（A4 の幅 794 px・印刷用）で測る
  await doc.setViewportSize({ width: 794, height: 1123 });
  await doc.emulateMedia({ media: 'print' });

  const out: Record<string, unknown>[] = [];
  for (const [index, cs] of cases.entries()) {
    const plan = buildPlan(cs, bases.find((b) => b.id === cs.base)!.expect.steps!);
    const svgDraw = await drawScheme(page, { plan, style: cs.style, dpi: cs.dpi, maxSide: MAX_SIDE, format: 'svg' });
    expect(svgDraw.issues, cs.id).toEqual([]);
    const svg = svgDraw.data.replace(/^<\?xml[^>]*>\s*/, '');
    const ptW = parseFloat(svg.match(/width="([\d.]+)pt"/)![1]);
    // 図の幅（CSS px）。もとの大きさ（pt → px）で、本文の幅に収まらなければ縮める。png も svg も同じ大きさにする
    const figW = Math.min(BODY_PX, Math.round((ptW * 96) / 72));
    const png = readFileSync(`tests/llm-eval/images/${cs.id}.png`).toString('base64');

    // 図の入れ方 png・svg の PDF。scan は png の PDF を 150 dpi の画像にしたもの
    let pngPdf: Buffer | undefined;
    let crop: Crop | undefined;
    for (const form of FORMS) {
      let pdf: Buffer;
      if (form === 'scan') {
        const scanPng = await renderScan(page, pngPdf!.toString('base64'));
        await doc.setContent(scanHtml(scanPng));
        await doc.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
        pdf = await doc.pdf({ width: '210mm', height: '297mm', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true });
      } else {
        const figure = form === 'png' ? `<img id="fig" src="data:image/png;base64,${png}">` : svg.replace('<svg ', '<svg id="fig" ');
        await doc.setContent(paperHtml({ index, plan, numbered: cs.numbered, figure, figureCss: `#fig { width: ${figW}px; height: auto; display: block; margin: 0 auto; }` }));
        await doc.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
        // 図の要素の bounding box（CSS px、ページの左上が原点）→ PDF の座標（pt）に余白を足す
        const box = await doc.locator('#fig').boundingBox();
        expect(box, cs.id).not.toBeNull();
        const k = 72 / 96;
        crop = {
          x: box!.x * k - CROP_PAD_PT,
          y: box!.y * k - CROP_PAD_PT,
          width: box!.width * k + 2 * CROP_PAD_PT,
          height: box!.height * k + 2 * CROP_PAD_PT,
        };
        pdf = await doc.pdf({ width: '210mm', height: '297mm', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true });
        if (form === 'png') pngPdf = pdf;
      }
      const fileName = `${cs.id}-${form}.pdf`;
      writeFileSync(`${PDF_DIR}/${fileName}`, pdf);
      const b64 = pdf.toString('base64');
      for (const send of ['page', 'crop'] as const) {
        const r = await pdfToImage(page, { pdf: b64, fileName, crop: send === 'crop' ? crop : undefined });
        expect(r.numPages, `${fileName} は 1 ページ`).toBe(1);
        const file = `${cs.id}-${form}-${send}.png`;
        writeFileSync(`${IMG_DIR}/${file}`, Buffer.from(r.image.data, 'base64'));
        out.push({
          id: `${cs.id}-${form}-${send}`,
          base: cs.id,
          form,
          send,
          pdf: fileName,
          png: file,
          width: r.image.width,
          height: r.image.height,
          bytes: r.image.bytes,
          name: r.image.name,
          ...(send === 'crop' ? { crop: Object.fromEntries(Object.entries(crop!).map(([k2, v]) => [k2, Math.round(v * 10) / 10])) } : {}),
        });
      }
    }
  }
  writeFileSync(
    'tests/llm-eval/pdf-cases.json',
    JSON.stringify(
      {
        about:
          'PDF からスキームの評価の件。PDF は e2e/make-eval-pdfs.spec.ts で、このアプリで描いた図と架空の本文から作った A4 の 1 ページ（論文・出版社の図は使わない）。' +
          'base は image-cases.json の件（正解はその件と同じ）、form は図の入れ方（png・svg・scan）、send は送り方（page＝ページ全体、crop＝図の範囲）。' +
          'png はアプリの cropToImage の出力そのもの。name は画像の説明に使う名前。crop は PDF の座標（pt、左上が原点）',
        cases: out,
      },
      null,
      2,
    ) + '\n',
  );
  await doc.close();
});

test('コミットしてある PDF から、ページ全体の PNG を作る', async ({ page }) => {
  test.skip(MODE !== 'pages', 'MAKE_EVAL_PDFS=pages のときだけ');
  test.setTimeout(600_000);
  const cases = (JSON.parse(readFileSync('tests/llm-eval/pdf-cases.json', 'utf8')) as { cases: { send: string; pdf: string; png: string; width: number; height: number; bytes: number }[] }).cases;
  mkdirSync(IMG_DIR, { recursive: true });
  await openApp(page);
  let sameBytes = 0;
  const pages = cases.filter((c) => c.send === 'page');
  for (const c of pages) {
    const r = await pdfToImage(page, { pdf: readFileSync(`${PDF_DIR}/${c.pdf}`).toString('base64'), fileName: c.pdf });
    // 大きさ（px）は PDF で決まるので、評価したときと同じはず。バイト数は環境（フォントの描き方）で少し変わることがある
    expect([r.image.width, r.image.height], c.png).toEqual([c.width, c.height]);
    if (r.image.bytes === c.bytes) sameBytes++;
    writeFileSync(`${IMG_DIR}/${c.png}`, Buffer.from(r.image.data, 'base64'));
  }
  process.stdout.write(`ページ全体の PNG を ${pages.length} 枚作った（評価したときとバイト数が同じもの ${sameBytes} 枚）\n`);
});

test('Gemini が見つけた図の範囲で、PDF を切り出す', async ({ page }) => {
  test.skip(MODE !== 'auto', 'MAKE_EVAL_PDFS=auto のときだけ（先に npm run eval:llm-figures を RECORD=1 で流す）');
  test.setTimeout(600_000);
  const rec = JSON.parse(readFileSync(`tests/llm-eval/recorded-figures/${process.env.LLM_MODEL ?? 'gemini-3.8-flash'}-${process.env.LLM_THINKING ?? 'low'}.json`, 'utf8')) as {
    cases: Record<string, { base: string; form: string; crop?: Crop }>;
  };
  mkdirSync(IMG_DIR, { recursive: true });
  await openApp(page);
  const out: Record<string, unknown>[] = [];
  let none = 0;
  for (const [key, c] of Object.entries(rec.cases)) {
    // 件の名前は「{画像の件}-{form}-page」
    const stem = key.replace(/-page$/, '');
    const imageCase = stem.slice(0, -(c.form.length + 1));
    // 反応スキームを 1 つに決められなかった件は、画面では利用者に選んでもらう。評価では数えるだけにする
    if (!c.crop) {
      none++;
      continue;
    }
    const fileName = `${stem}.pdf`;
    const r = await pdfToImage(page, { pdf: readFileSync(`${PDF_DIR}/${fileName}`).toString('base64'), fileName, crop: c.crop });
    // 図の線と文字（本当の範囲の中の暗い画素）のうち、見つけた範囲に入った割合。1 なら図は切れていない
    const truth = (JSON.parse(readFileSync('tests/llm-eval/pdf-cases.json', 'utf8')) as { cases: { id: string; crop?: Crop }[] }).cases.find((x) => x.id === `${stem}-crop`)!.crop!;
    const inkCover = await page.evaluate(
      async ({ png, truth, found, pageWidth }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const k = img.width / pageWidth;
        const [x0, y0, x1, y1] = [truth.x, truth.y, truth.x + truth.width, truth.y + truth.height].map((v) => Math.round(v * k));
        const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let all = 0;
        let inside = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] + d[i + 1] + d[i + 2] >= 3 * 160) continue;
          all++;
          const px = x0 + ((i / 4) % (x1 - x0));
          const py = y0 + Math.floor(i / 4 / (x1 - x0));
          if (px >= found.x * k && px < (found.x + found.width) * k && py >= found.y * k && py < (found.y + found.height) * k) inside++;
        }
        return all ? inside / all : 1;
      },
      { png: readFileSync(`${IMG_DIR}/${stem}-page.png`).toString('base64'), truth, found: c.crop, pageWidth: 595.28 },
    );
    const file = `${stem}-auto.png`;
    writeFileSync(`${IMG_DIR}/${file}`, Buffer.from(r.image.data, 'base64'));
    out.push({ id: `${stem}-auto`, base: imageCase, form: c.form, send: 'auto', pdf: fileName, png: file, width: r.image.width, height: r.image.height, bytes: r.image.bytes, name: r.image.name, crop: c.crop, inkCover: Math.round(inkCover * 1000) / 1000 });
  }
  writeFileSync(
    'tests/llm-eval/pdf-auto-cases.json',
    JSON.stringify({ about: 'Gemini が見つけた図の範囲（tests/llm-eval/recorded-figures/）で切り出した件。e2e/make-eval-pdfs.spec.ts を MAKE_EVAL_PDFS=auto で作る', cases: out }, null, 2) + '\n',
  );
  const cut = out.filter((x) => (x.inkCover as number) < 0.999).map((x) => `${x.id}（${x.inkCover}）`);
  process.stdout.write(`切り出した ${out.length} 件（図を 1 つに決められなかった ${none} 件は除いた）。図が切れた件: ${cut.length ? cut.join('、') : 'なし'}\n`);
});

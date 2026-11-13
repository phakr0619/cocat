// 本物の Gemini で、PDF のページ全体の画像から図の位置を答えさせ、本当の位置と比べる
//
//   MAKE_EVAL_PDFS=pages npx playwright test e2e/make-eval-pdfs.spec.ts   # ページ全体の PNG を先に作る
//   AI_CHEM_EVAL_GEMINI_KEY=… npm run eval:llm-figures
//
//   LLM_MODEL・LLM_THINKING・LLM_CASES・LLM_FORMS・LLM_MAX_USD（既定 0.25）・RECORD=1（tests/llm-eval/recorded-figures/ に書く）
//
// 本当の位置は pdf-cases.json の crop（図の要素の四角に 6 pt の余白を足したもの）。見つけた四角にも同じ 6 pt を足して切り出す
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { figureToCrop, findFigures, type FoundFigure } from '../../src/llm/findFigures';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import type { ThinkingLevel } from '../../src/llm/types';
import { hasPdfImage, PDF_CASES, PDF_FORMS, pdfInput } from './pdf-cases';
import { PRICES } from './score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? 'gemini-3.8-flash';
const THINKING = (process.env.LLM_THINKING ?? 'low') as ThinkingLevel;
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const FORMS = (process.env.LLM_FORMS ?? PDF_FORMS.join(',')).split(',').map((s) => s.trim());
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.25);
if (!(MAX_USD > 0)) throw new Error(`LLM_MAX_USD は正の数で（今は ${process.env.LLM_MAX_USD}）`);

/** 評価の PDF は A4（pt） */
export const A4 = { width: 595.28, height: 841.89 };
/** 本当の位置に足してある余白（make-eval-pdfs.spec.ts の CROP_PAD_PT） */
const PAD = 6;

type Box = { x: number; y: number; width: number; height: number };
const area = (b: Box) => Math.max(0, b.width) * Math.max(0, b.height);
const inter = (a: Box, b: Box): Box => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.min(a.x + a.width, b.x + b.width) - x, height: Math.min(a.y + a.height, b.y + b.height) - y };
};

/**
 * 切り出した範囲を、本当の範囲（図の要素の四角＋余白）と比べる。extra: 広さの比、iou: 重なり。
 * 本当の範囲には図の画像の白い余白も入っているので、四角どうしの比べでは「図が切れたか」は分からない。
 * 図の線と文字が範囲に入ったか（インクの割合）は、MAKE_EVAL_PDFS=auto で切り出すときに画素で数える（make-eval-pdfs.spec.ts）
 */
export function compareCrop(found: Box, truthWithPad: Box): { extra: number; iou: number } {
  const i = area(inter(found, truthWithPad));
  return { extra: area(found) / area(truthWithPad), iou: i / (area(found) + area(truthWithPad) - i) };
}

describe.skipIf(!KEY)('本物の Gemini で図の位置を見つける', () => {
  it('ページ全体の画像から図の位置を答えさせ、本当の位置と比べる', async () => {
    const cases = PDF_CASES.filter((c) => c.send === 'page' && FORMS.includes(c.form) && (!ONLY || ONLY.includes(c.id) || ONLY.includes(c.base)));
    const missing = cases.filter((c) => !hasPdfImage(c));
    if (missing.length) throw new Error(`ページ全体の PNG がありません（${missing.length} 枚）。先に MAKE_EVAL_PDFS=pages npx playwright test e2e/make-eval-pdfs.spec.ts で作ってください`);
    const price = PRICES[MODEL];
    const gemini = createGemini({ apiKey: KEY, model: MODEL, timeoutMs: GEMINI_TIMEOUT_MS });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let spent = 0;
    const rows: { id: string; base: string; form: string; figures: FoundFigure[]; crop?: Box; extra?: number; iou?: number; ok: boolean; note: string; seconds: number; usd: number; raw: unknown }[] = [];
    for (const c of cases) {
      const truth = PDF_CASES.find((x) => x.id === c.id.replace(/-page$/, '-crop'))!.crop!;
      const t0 = Date.now();
      let raw: unknown;
      const r = await findFigures(
        {
          ...gemini,
          generateJson: async (req) => {
            const a = await gemini.generateJson(req);
            raw = a.ok ? a.value : { error: a.error };
            return a as never;
          },
        },
        { image: pdfInput(c).images[0], thinking: THINKING },
      );
      const seconds = (Date.now() - t0) / 1000;
      const usd = r.usage && price ? (r.usage.input * price.input + r.usage.output * price.output) / 1e6 : 0;
      spent += usd;
      if (!r.ok) {
        rows.push({ id: c.id, base: c.base, form: c.form, figures: [], ok: false, note: `失敗: ${r.error.kind}`, seconds, usd, raw });
      } else {
        const schemes = r.figures.filter((f) => f.kind === 'reaction-scheme');
        // 図は 1 ページに 1 つ。反応スキームが 1 つだけ見つかれば、それを使う（画面では、2 つ以上なら利用者に選んでもらう）
        const pick = schemes.length === 1 ? schemes[0] : undefined;
        const crop = pick ? figureToCrop(pick, A4, PAD) : undefined;
        const m = crop ? compareCrop(crop, truth) : undefined;
        const ok = !!pick;
        const note = !pick ? `反応スキームが ${schemes.length} 個（全部で ${r.figures.length} 個）` : '';
        rows.push({ id: c.id, base: c.base, form: c.form, figures: r.figures, crop, ...m, ok, note, seconds, usd, raw });
      }
      const last = rows[rows.length - 1];
      process.stdout.write(`${c.id}: ${last.ok ? 'ok' : 'ng'} extra=${last.extra?.toFixed(2) ?? '-'} (${seconds.toFixed(1)} 秒, $${usd.toFixed(4)}) ${last.note}\n`);
      if (spent > MAX_USD) {
        process.stdout.write(`止めました: 料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）\n`);
        break;
      }
    }
    const okN = rows.filter((r) => r.ok).length;
    const extras = rows.filter((r) => r.extra !== undefined).map((r) => r.extra!);
    const lines = [
      `# 図の位置を見つける評価（${stamp}、${MODEL}・${THINKING}）`,
      '',
      `- 反応スキームを 1 つだけ見つけた: ${okN} / ${rows.length}（図が切れていないかは MAKE_EVAL_PDFS=auto で数える）`,
      `- 範囲の広さ ÷ 本当の範囲: 中央値 ${extras.sort((a, b) => a - b)[Math.floor(extras.length / 2)]?.toFixed(2) ?? '-'}、最大 ${Math.max(...extras).toFixed(2)}`,
      `- 料金の目安: $${spent.toFixed(3)}、呼んだ ${rows.length} 回、平均 ${(rows.reduce((a, r) => a + r.seconds, 0) / rows.length).toFixed(1)} 秒`,
      '',
      '| 件 | 形 | 結果 | 広さの比 | IoU | 気になった所 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map((r) => `| ${r.base} | ${r.form} | ${r.ok ? 'ok' : 'ng'} | ${r.extra?.toFixed(2) ?? '-'} | ${r.iou?.toFixed(2) ?? '-'} | ${r.note} |`),
    ];
    mkdirSync('out/llm-eval', { recursive: true });
    writeFileSync(`out/llm-eval/figures-${stamp}.md`, lines.join('\n'));
    writeFileSync(`out/llm-eval/figures-${stamp}.json`, JSON.stringify(rows, null, 2));
    if (process.env.RECORD === '1') {
      mkdirSync('tests/llm-eval/recorded-figures', { recursive: true });
      writeFileSync(
        `tests/llm-eval/recorded-figures/${MODEL}-${THINKING}.json`,
        JSON.stringify({ model: MODEL, thinking: THINKING, recordedAt: stamp, page: A4, pad: PAD, cases: Object.fromEntries(rows.map((r) => [r.id, { base: r.base, form: r.form, ok: r.ok, crop: r.crop, raw: r.raw }])) }, null, 2),
      );
    }
    process.stdout.write(`\n${lines.join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

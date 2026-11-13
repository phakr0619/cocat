// 本物の Gemini で、画像からスキームの件を流して採点する
//
//   PowerShell:  $env:AI_CHEM_EVAL_GEMINI_KEY = "…"; npm run eval:llm-image
//
// キーと環境変数（LLM_MODEL・LLM_THINKING・LLM_CASES・LLM_DELAY_MS・LLM_TIMEOUT_MS・RECORD）は、言葉からスキームの評価（live.eval.ts）と同じ。
// RECORD=1 なら答えを tests/llm-eval/recorded-image/ に書き、recorded-image.test.ts が CI で流し直す
//   LLM_MAX_USD   この回で使ってよい料金の上限（USD。既定 0.5）。料金の目安が超えたら、残りは流さずに止める
//
// 画像は、このアプリで描いて書き出したもの（tests/llm-eval/images/。論文・出版社の図は使わない）。文章は送らない
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { textToScheme } from '../../src/llm/textToScheme';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { IMAGE_CASES, imageInput } from './image-cases';
import { scoreCase, stopReason, summarize, type CaseScore } from './score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODELS = (process.env.LLM_MODEL ?? 'gemini-3.8-flash').split(',').map((s) => s.trim());
const LEVELS = (process.env.LLM_THINKING ?? 'low').split(',').map((s) => s.trim() as ThinkingLevel);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const DELAY = Number(process.env.LLM_DELAY_MS ?? 0);
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? GEMINI_TIMEOUT_MS);
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.5);
if (!(TIMEOUT > 0)) throw new Error(`LLM_TIMEOUT_MS はミリ秒の正の数で（今は ${process.env.LLM_TIMEOUT_MS}）`);
if (!(MAX_USD > 0)) throw new Error(`LLM_MAX_USD は正の数で（今は ${process.env.LLM_MAX_USD}）`);

beforeAll(loadRDKit);

describe.skipIf(!KEY)('本物の Gemini で画像からスキームを評価する', () => {
  it('画像の件を流して採点する', async () => {
    mkdirSync('out/llm-eval', { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const lines: string[] = [];
    let stopped: string | null = null;
    let spent = 0;
    for (const model of MODELS)
      for (const thinking of LEVELS) {
        if (stopped) break;
        const raw: Record<string, unknown[]> = {};
        const runs: { seconds: number; usage?: LlmUsage }[] = [];
        let calls = 0;
        let unknown = 0;
        const scores: CaseScore[] = [];
        const cases = IMAGE_CASES.filter((x) => !ONLY || ONLY.includes(x.id));
        for (const c of cases) {
          const gemini = createGemini({ apiKey: KEY, model, timeoutMs: TIMEOUT });
          const answers: unknown[] = [];
          const llm: LlmProvider = {
            ...gemini,
            generateJson: async (req) => {
              const r = await gemini.generateJson(req);
              answers.push(r.ok ? r.value : { error: r.error });
              calls++;
              if (!r.ok && !r.usage && ['timeout', 'network', 'aborted'].includes(r.error.kind)) unknown++;
              return r as never;
            },
          };
          const t0 = Date.now();
          const r = await textToScheme(llm, { text: c.text, existing: [], image: imageInput(c), thinking });
          const seconds = (Date.now() - t0) / 1000;
          raw[c.id] = answers;
          runs.push({ seconds, usage: r.usage });
          const s = scoreCase(c, r);
          scores.push(s);
          const usd = summarize([s], [{ seconds, usage: r.usage }], model).usd ?? 0;
          spent += usd;
          process.stdout.write(`${model} ${thinking} ${c.id}: ${s.outcome} (${seconds.toFixed(1)} 秒, $${usd.toFixed(4)})${s.notes.length ? ` - ${s.notes.join(' / ')}` : ''}\n`);
          stopped = stopReason(r) ?? (spent > MAX_USD ? `料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）` : null);
          if (stopped) {
            process.stdout.write(`止めました: ${stopped}。残りの ${cases.length - scores.length} 件は流していません\n`);
            break;
          }
          if (DELAY) await new Promise((res) => setTimeout(res, DELAY));
        }
        const sum = summarize(scores, runs, model);
        if (stopped) sum.pass = false;
        const name = `image-${stamp}-${model}-${thinking}`;
        writeFileSync(`out/llm-eval/${name}.json`, JSON.stringify({ model, thinking, summary: sum, scores, runs, raw }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded-image', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded-image/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          ...(stopped && scores.length < cases.length ? [`> **途中で止めました**: ${stopped}。${cases.length} 件のうち ${scores.length} 件だけ流しました`, ''] : []),
          `- 正しい: ${sum.correct} / ${sum.total}（${Math.round((sum.correct / sum.total) * 100)}%）`,
          `- 要確認か聞き返しで止まった: ${sum.flagged}`,
          `- 黙って間違えた: ${sum.silentWrong}`,
          `- 失敗（呼び出しのエラー）: ${sum.errors}`,
          `- 条件の一致: ${Math.round(sum.conditionRate * 100)}%`,
          `- 秒数: 平均 ${sum.seconds?.mean.toFixed(1)} 秒、最長 ${sum.seconds?.max.toFixed(1)} 秒`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(3)}` : '不明'}。呼んだ ${calls} 回`
            + (sum.tokens ? `、入力 ${sum.tokens.input} トークン・出力 ${sum.tokens.output} トークン（うち考えた分 ${sum.tokens.thinking}）` : '')
            + (unknown ? `。時間切れなどで答えが届かなかった ${unknown} 回は数えていない（Google 側で作り終えていれば請求される）` : ''),
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          '| 件 | 結果 | 条件 | 秒 | 気になった所 |',
          '| --- | --- | --- | --- | --- |',
          ...scores.map((s, i) => `| ${IMAGE_CASES.find((c) => c.id === s.id)!.title} | ${s.outcome} | ${s.conditions.hit}/${s.conditions.total} | ${runs[i].seconds.toFixed(1)} | ${s.notes.join('<br>')} |`),
          '',
        );
      }
    const report = [`# 画像からスキームの評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/image-${stamp}.md`, report);
    process.stdout.write(`\n${report}\n結果: out/llm-eval/image-${stamp}.md\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

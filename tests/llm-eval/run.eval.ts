// 本物の Gemini で、実験のメモ → 実験の記録の下書きを流して採点する。
//
//   bash:  AI_CHEM_EVAL_GEMINI_KEY=… LLM_MAX_USD=0.3 npm run eval:llm-run
//
// 環境変数（LLM_MODEL・LLM_THINKING・LLM_CASES・LLM_DELAY_MS・LLM_TIMEOUT_MS・LLM_MAX_USD・RECORD）は、仕上げの評価（finish.eval.ts）と同じ。
// LLM_MAX_USD は必ず決めてから流す（既定 0.2）。料金の目安が超えたら、残りは流さずに止める。
// RECORD=1 で答えを tests/llm-eval/recorded-run/ に書く。結果は out/llm-eval/ に run- を付けて書く。キーはどこにも書かない
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { textToRun } from '../../src/llm/textToRun';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { RUN_CASES, runDocFor, scoreRun } from './run-score';
import { stopReason, summarize, type CaseScore } from './score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODELS = (process.env.LLM_MODEL ?? 'gemini-3.8-flash').split(',').map((s) => s.trim());
const LEVELS = (process.env.LLM_THINKING ?? 'low').split(',').map((s) => s.trim() as ThinkingLevel);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const DELAY = Number(process.env.LLM_DELAY_MS ?? 0);
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? GEMINI_TIMEOUT_MS);
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.2);
if (!(TIMEOUT > 0)) throw new Error(`LLM_TIMEOUT_MS はミリ秒の正の数で（今は ${process.env.LLM_TIMEOUT_MS}）`);
if (!(MAX_USD > 0)) throw new Error(`LLM_MAX_USD は正の数で（今は ${process.env.LLM_MAX_USD}）`);

describe.skipIf(!KEY)('本物の Gemini で、メモ → 実験の記録の下書きを評価する', () => {
  it('件を流して採点する', async () => {
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
        const scores: CaseScore[] = [];
        const cases = RUN_CASES.filter((x) => !ONLY || ONLY.includes(x.id));
        for (const c of cases) {
          const gemini = createGemini({ apiKey: KEY, model, timeoutMs: TIMEOUT });
          const answers: unknown[] = [];
          const llm: LlmProvider = {
            ...gemini,
            generateJson: async (req) => {
              const r = await gemini.generateJson(req);
              answers.push(r.ok ? r.value : { error: r.error });
              return r as never;
            },
          };
          const { doc, runId } = runDocFor(c);
          const t0 = Date.now();
          const r = await textToRun(llm, { doc, runId, memo: c.memo, thinking });
          const seconds = (Date.now() - t0) / 1000;
          const s = scoreRun(c, r);
          raw[c.id] = answers;
          runs.push({ seconds, usage: r.usage });
          scores.push(s);
          const usd = summarize([s], [{ seconds, usage: r.usage }], model).usd ?? 0;
          spent += usd;
          process.stdout.write(`${model} ${thinking} ${c.id}: ${s.outcome} ${s.conditions.hit}/${s.conditions.total} (${seconds.toFixed(1)} 秒, $${usd.toFixed(4)}) - ${s.notes.join(' / ')}\n`);
          stopped = stopReason(r) ?? (spent > MAX_USD ? `料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）` : null);
          if (stopped) {
            process.stdout.write(`止めました: ${stopped}。残りの ${cases.length - scores.length} 件は流していません\n`);
            break;
          }
          if (DELAY) await new Promise((res) => setTimeout(res, DELAY));
        }
        const sum = summarize(scores, runs, model);
        if (stopped) sum.pass = false;
        writeFileSync(`out/llm-eval/run-${stamp}-${model}-${thinking}.json`, JSON.stringify({ model, thinking, summary: sum, scores, runs, raw }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded-run', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded-run/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          ...(stopped && scores.length < cases.length ? [`> **途中で止めました**: ${stopped}。${cases.length} 件のうち ${scores.length} 件だけ流しました`, ''] : []),
          `- 正しい: ${sum.correct} / ${sum.total}`,
          `- 要確認か聞き返しで止まった: ${sum.flagged}`,
          `- 黙って間違えた（メモに無い量を、要確認なしで入れた）: ${sum.silentWrong}`,
          `- 失敗（呼び出しのエラー）: ${sum.errors}`,
          `- 秒数: 平均 ${sum.seconds?.mean.toFixed(1)} 秒、最長 ${sum.seconds?.max.toFixed(1)} 秒`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(4)}` : '不明'}` + (sum.tokens ? `、入力 ${sum.tokens.input} トークン・出力 ${sum.tokens.output} トークン（うち考えた分 ${sum.tokens.thinking}）` : ''),
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          '| 件 | 結果 | 当たり | 秒 | 気になった所 |',
          '| --- | --- | --- | --- | --- |',
          ...scores.map((s, i) => `| ${s.id} | ${s.outcome} | ${s.conditions.hit}/${s.conditions.total} | ${runs[i].seconds.toFixed(1)} | ${s.notes.join('<br>')} |`),
          '',
        );
      }
    const report = [`# メモ → 実験の記録の下書きの評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/run-${stamp}.md`, report);
    process.stdout.write(`\n${report}\n結果: out/llm-eval/run-${stamp}.md\n料金の目安の合計: $${spent.toFixed(4)}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

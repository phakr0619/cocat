// 本物の Gemini で、言葉からスキームの 20 件を流して採点する
//
//   PowerShell:  $env:AI_CHEM_EVAL_GEMINI_KEY = "…"; npm run eval:llm
//   bash:        AI_CHEM_EVAL_GEMINI_KEY=… npm run eval:llm
//
// キーは、この評価のためだけの名前の環境変数から読む。よくある名前（GEMINI_API_KEY）は読まない。
// ほかの用途で環境に入っているキーを、気づかずに使ってしまわないため（2026-10-24 に実際に起きた）
//
// 環境変数（どれも任意）
//   LLM_MODEL     使うモデル。カンマ区切りで比べられる（既定 gemini-3.8-flash）
//   LLM_THINKING  考える深さ low / medium / high。カンマ区切りで比べられる（既定 low）
//   LLM_CASES     流す件の id をカンマ区切りで（既定はすべて）
//   LLM_DELAY_MS  1 件ごとに待つミリ秒（無料のキーで回数の上限に当たるとき。既定 0）
//   LLM_TIMEOUT_MS  1 回の呼び出しを待つ上限のミリ秒（既定はアプリと同じ 180000。Gemini が遅い日に延ばす）
//   RECORD=1      答えを tests/llm-eval/recorded/ に書く（CI で採点が変わらないかを確かめるのに使う。コミットしてよい）
//
// 上限（quota）やキー違いで失敗したら、残りは流さずに止める（流しても同じ失敗になり、無料キーなら 1 日の回数を無駄にする）
//
// 結果は out/llm-eval/ に Markdown と JSON で書き、まとめを画面にも出す。キーはどこにも書かない
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { textToScheme } from '../../src/llm/textToScheme';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { CASES, existingFor, scoreCase, stopReason, summarize, type CaseScore } from './score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODELS = (process.env.LLM_MODEL ?? 'gemini-3.8-flash').split(',').map((s) => s.trim());
const LEVELS = (process.env.LLM_THINKING ?? 'low').split(',').map((s) => s.trim() as ThinkingLevel);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const DELAY = Number(process.env.LLM_DELAY_MS ?? 0);
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? GEMINI_TIMEOUT_MS);
if (!(TIMEOUT > 0)) throw new Error(`LLM_TIMEOUT_MS はミリ秒の正の数で（今は ${process.env.LLM_TIMEOUT_MS}）`);

beforeAll(loadRDKit);

describe.skipIf(!KEY)('本物の Gemini で評価する', () => {
  it('20 件を流して採点する', async () => {
    mkdirSync('out/llm-eval', { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const lines: string[] = [];
    // 上限・キー違いで止めた理由（ほかのモデル・深さも同じキーなので、そこで全部やめる）
    let stopped: string | null = null;
    for (const model of MODELS)
      for (const thinking of LEVELS) {
        if (stopped) break;
        const raw: Record<string, unknown[]> = {};
        const runs: { seconds: number; usage?: LlmUsage }[] = [];
        // 呼んだ回数と、答えが届かず使用量の分からない回数（時間切れ・つながらない。Google 側で作り終えていれば請求される）
        let calls = 0;
        let unknown = 0;
        const scores: CaseScore[] = [];
        const cases = CASES.filter((x) => !ONLY || ONLY.includes(x.id));
        for (const c of cases) {
          // 答えをそのまま記録するために包む
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
          const r = await textToScheme(llm, { text: c.text, existing: existingFor(c), thinking });
          const seconds = (Date.now() - t0) / 1000;
          raw[c.id] = answers;
          runs.push({ seconds, usage: r.usage });
          const s = scoreCase(c, r);
          scores.push(s);
          process.stdout.write(`${model} ${thinking} ${c.id}: ${s.outcome} (${seconds.toFixed(1)} 秒)${s.notes.length ? ` - ${s.notes.join(' / ')}` : ''}\n`);
          stopped = stopReason(r);
          if (stopped) {
            process.stdout.write(`止めました: ${stopped}。残りの ${cases.length - scores.length} 件は流していません\n`);
            break;
          }
          if (DELAY) await new Promise((res) => setTimeout(res, DELAY));
        }
        const sum = summarize(scores, runs, model);
        // 止めた回は全件を測っていないので、完了の条件は満たさないことにする
        if (stopped) sum.pass = false;
        const name = `${stamp}-${model}-${thinking}`;
        writeFileSync(`out/llm-eval/${name}.json`, JSON.stringify({ model, thinking, summary: sum, scores, runs, raw }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          ...(stopped && scores.length < cases.length ? [`> **途中で止めました**: ${stopped}。${cases.length} 件のうち ${scores.length} 件だけ流し、残りの ${cases.length - scores.length} 件は流していません。下の数はこの ${scores.length} 件のものです`, ''] : []),
          `- 正しい: ${sum.correct} / ${sum.total}（${Math.round((sum.correct / sum.total) * 100)}%）`,
          `- 要確認か聞き返しで止まった: ${sum.flagged}`,
          `- 黙って間違えた: ${sum.silentWrong}`,
          `- 失敗（呼び出しのエラー）: ${sum.errors}`,
          `- 条件の一致: ${Math.round(sum.conditionRate * 100)}%`,
          `- 秒数: 平均 ${sum.seconds?.mean.toFixed(1)} 秒、最長 ${sum.seconds?.max.toFixed(1)} 秒`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(3)}（無料のキーなら 0）` : '不明'}。呼んだ ${calls} 回`
            + (sum.tokens ? `、入力 ${sum.tokens.input} トークン・出力 ${sum.tokens.output} トークン（うち考えた分 ${sum.tokens.thinking}）` : '')
            + (unknown ? `。時間切れなどで答えが届かなかった ${unknown} 回は数えていない（Google 側で作り終えていれば請求される）` : ''),
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          '| 件 | 結果 | 条件 | 秒 | 気になった所 |',
          '| --- | --- | --- | --- | --- |',
          ...scores.map((s, i) => `| ${CASES.find((c) => c.id === s.id)!.title} | ${s.outcome} | ${s.conditions.hit}/${s.conditions.total} | ${runs[i].seconds.toFixed(1)} | ${s.notes.join('<br>')} |`),
          '',
        );
      }
    const report = [`# 言葉からスキームの評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/${stamp}.md`, report);
    process.stdout.write(`\n${report}\n結果: out/llm-eval/${stamp}.md\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

// 本物の Gemini で、スキームから実験項の文章を書く件を流して採点する
//
//   PowerShell:  $env:AI_CHEM_EVAL_GEMINI_KEY = "…"; npm run eval:llm-writeup
//   bash:        AI_CHEM_EVAL_GEMINI_KEY=… npm run eval:llm-writeup
//
// キーと環境変数（LLM_MODEL・LLM_THINKING・LLM_CASES・LLM_DELAY_MS・LLM_TIMEOUT_MS・RECORD）は、言葉からスキームの評価（live.eval.ts）と同じ。
//   LLM_MAX_USD   この回で使ってよい料金の上限（USD。既定 0.2）。料金の目安が超えたら、残りは流さずに止める
// RECORD=1 で答えを tests/llm-eval/recorded-writeup/ に書く。結果は out/llm-eval/ に writeup- を付けて書く。キーはどこにも書かない
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { writeUp } from '../../src/llm/writeUp';
import { loadRDKit } from '../rdkit';
import { stopReason, summarize, type CaseScore } from './score';
import { scoreWriteUp, WRITEUP_CASES, writeUpBase } from './writeup-score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODELS = (process.env.LLM_MODEL ?? 'gemini-3.8-flash').split(',').map((s) => s.trim());
const LEVELS = (process.env.LLM_THINKING ?? 'low').split(',').map((s) => s.trim() as ThinkingLevel);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const DELAY = Number(process.env.LLM_DELAY_MS ?? 0);
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? GEMINI_TIMEOUT_MS);
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.2);
if (!(TIMEOUT > 0)) throw new Error(`LLM_TIMEOUT_MS はミリ秒の正の数で（今は ${process.env.LLM_TIMEOUT_MS}）`);
if (!(MAX_USD > 0)) throw new Error(`LLM_MAX_USD は正の数で（今は ${process.env.LLM_MAX_USD}）`);

beforeAll(loadRDKit);

describe.skipIf(!KEY)('本物の Gemini で実験項の文章を評価する', () => {
  it('書く件を流して採点する', async () => {
    mkdirSync('out/llm-eval', { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const lines: string[] = [];
    let stopped: string | null = null;
    let spent = 0;
    for (const model of MODELS)
      for (const thinking of LEVELS) {
        if (stopped) break;
        const raw: Record<string, unknown[]> = {};
        const texts: Record<string, string> = {};
        const runs: { seconds: number; usage?: LlmUsage }[] = [];
        let calls = 0;
        let unknown = 0;
        const scores: CaseScore[] = [];
        const cases = WRITEUP_CASES.filter((x) => !ONLY || ONLY.includes(x.id));
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
          const { doc, schemeId } = writeUpBase(c);
          const t0 = Date.now();
          const r = await writeUp(llm, { doc, schemeId, text: c.text, language: c.language, thinking });
          const seconds = (Date.now() - t0) / 1000;
          raw[c.id] = answers;
          if (r.ok) texts[c.id] = r.checked.text;
          runs.push({ seconds, usage: r.usage });
          const s = scoreWriteUp(c, r);
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
        const name = `writeup-${stamp}-${model}-${thinking}`;
        writeFileSync(`out/llm-eval/${name}.json`, JSON.stringify({ model, thinking, summary: sum, scores, runs, raw, texts }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded-writeup', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded-writeup/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          ...(stopped && scores.length < cases.length ? [`> **途中で止めました**: ${stopped}。${cases.length} 件のうち ${scores.length} 件だけ流しました`, ''] : []),
          `- 正しい: ${sum.correct} / ${sum.total}（${Math.round((sum.correct / sum.total) * 100)}%）`,
          `- 要確認か質問で止まった: ${sum.flagged}`,
          `- 黙って間違えた: ${sum.silentWrong}`,
          `- 失敗（呼び出しのエラー）: ${sum.errors}`,
          `- 使うべき印を使った割合: ${Math.round(sum.conditionRate * 100)}%`,
          `- 秒数: 平均 ${sum.seconds?.mean.toFixed(1)} 秒、最長 ${sum.seconds?.max.toFixed(1)} 秒`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(3)}（無料のキーなら 0）` : '不明'}。呼んだ ${calls} 回`
            + (sum.tokens ? `、入力 ${sum.tokens.input} トークン・出力 ${sum.tokens.output} トークン（うち考えた分 ${sum.tokens.thinking}）` : '')
            + (unknown ? `。時間切れなどで答えが届かなかった ${unknown} 回は数えていない` : ''),
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          '| 件 | 結果 | 秒 | 気になった所 |',
          '| --- | --- | --- | --- |',
          ...scores.map((s, i) => `| ${WRITEUP_CASES.find((c) => c.id === s.id)!.title} | ${s.outcome} | ${runs[i].seconds.toFixed(1)} | ${s.notes.join('<br>')} |`),
          '',
          '### 書いた文',
          '',
          ...Object.entries(texts).flatMap(([id, t]) => [`#### ${id}`, '', '```', t, '```', '']),
        );
      }
    const report = [`# 実験項の文章の評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/writeup-${stamp}.md`, report);
    process.stdout.write(`\n${report}\n結果: out/llm-eval/writeup-${stamp}.md\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

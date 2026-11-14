// 本物の Gemini で、実験の記録を使って実験項を書かせて採点する（見本の「実験の記録（縮合、10 g）」を使う）。
//
//   bash:  AI_CHEM_EVAL_GEMINI_KEY=… LLM_MAX_USD=0.2 npm run eval:llm-writeup-run
//
// 環境変数は仕上げの評価（finish.eval.ts）と同じ。LLM_MAX_USD は必ず決めてから流す（既定 0.2）。
// RECORD=1 で答えを tests/llm-eval/recorded-writeup-run/ に書く。結果は out/llm-eval/ に writeup-run- を付けて書く。キーはどこにも書かない
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { writeUp } from '../../src/llm/writeUp';
import { loadRDKit } from '../rdkit';
import { stopReason, summarize, type CaseScore } from './score';
import { WRITEUP_RUN_CASES, scoreWriteUpRun, writeUpRunDoc } from './writeup-run-score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODELS = (process.env.LLM_MODEL ?? 'gemini-3.8-flash').split(',').map((s) => s.trim());
const LEVELS = (process.env.LLM_THINKING ?? 'low').split(',').map((s) => s.trim() as ThinkingLevel);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? GEMINI_TIMEOUT_MS);
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.2);
if (!(MAX_USD > 0)) throw new Error(`LLM_MAX_USD は正の数で（今は ${process.env.LLM_MAX_USD}）`);

beforeAll(loadRDKit);

describe.skipIf(!KEY)('本物の Gemini で、実験の記録を使った実験項を評価する', () => {
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
        const texts: string[] = [];
        const cases = WRITEUP_RUN_CASES.filter((x) => !ONLY || ONLY.includes(x.id));
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
          const { doc, schemeId } = writeUpRunDoc();
          const t0 = Date.now();
          const r = await writeUp(llm, { doc, schemeId, text: c.text, language: c.language, thinking, useRuns: true });
          const seconds = (Date.now() - t0) / 1000;
          const s = scoreWriteUpRun(c, r);
          raw[c.id] = answers;
          runs.push({ seconds, usage: r.usage });
          scores.push(s);
          texts.push(r.ok ? r.checked.text : '');
          const usd = summarize([s], [{ seconds, usage: r.usage }], model).usd ?? 0;
          spent += usd;
          process.stdout.write(`${model} ${thinking} ${c.id}: ${s.outcome} ${s.conditions.hit}/${s.conditions.total} (${seconds.toFixed(1)} 秒, $${usd.toFixed(4)}) - ${s.notes.join(' / ')}\n`);
          stopped = stopReason(r) ?? (spent > MAX_USD ? `料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）` : null);
          if (stopped) {
            process.stdout.write(`止めました: ${stopped}。残りの ${cases.length - scores.length} 件は流していません\n`);
            break;
          }
        }
        const sum = summarize(scores, runs, model);
        if (stopped) sum.pass = false;
        writeFileSync(`out/llm-eval/writeup-run-${stamp}-${model}-${thinking}.json`, JSON.stringify({ model, thinking, summary: sum, scores, runs, raw, texts }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded-writeup-run', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded-writeup-run/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          `- 正しい: ${sum.correct} / ${sum.total}、要確認: ${sum.flagged}、黙って間違えた: ${sum.silentWrong}、失敗: ${sum.errors}`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(4)}` : '不明'}`,
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          ...scores.flatMap((s, i) => [`### ${s.id}: ${s.outcome}（${s.conditions.hit}/${s.conditions.total}、${runs[i].seconds.toFixed(1)} 秒）`, '', ...s.notes.map((n) => `- ${n}`), '', texts[i], '']),
        );
      }
    const report = [`# 実験の記録を使った実験項の評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/writeup-run-${stamp}.md`, report);
    process.stdout.write(`\n${report}\n料金の目安の合計: $${spent.toFixed(4)}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

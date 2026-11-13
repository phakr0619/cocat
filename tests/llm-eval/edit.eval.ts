// 本物の Gemini で、言葉での編集の件を流して採点する（M3-4 段3）
//
//   PowerShell:  $env:AI_CHEM_EVAL_GEMINI_KEY = "…"; npm run eval:llm-edit
//   bash:        AI_CHEM_EVAL_GEMINI_KEY=… npm run eval:llm-edit
//
// キーと環境変数（LLM_MODEL・LLM_THINKING・LLM_CASES・LLM_DELAY_MS・LLM_TIMEOUT_MS・RECORD）は、言葉からスキームの評価（live.eval.ts）と同じ。
// RECORD=1 で答えを tests/llm-eval/recorded-edit/ に書く。結果は out/llm-eval/ に edit- を付けて書く。キーはどこにも書かない
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { textEdit } from '../../src/llm/textEdit';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { EDIT_CASES, editBase, scoreEdit } from './edit-score';
import { stopReason, summarize, type CaseScore } from './score';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODELS = (process.env.LLM_MODEL ?? 'gemini-3.8-flash').split(',').map((s) => s.trim());
const LEVELS = (process.env.LLM_THINKING ?? 'low').split(',').map((s) => s.trim() as ThinkingLevel);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const DELAY = Number(process.env.LLM_DELAY_MS ?? 0);
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS ?? GEMINI_TIMEOUT_MS);
if (!(TIMEOUT > 0)) throw new Error(`LLM_TIMEOUT_MS はミリ秒の正の数で（今は ${process.env.LLM_TIMEOUT_MS}）`);

beforeAll(loadRDKit);

describe.skipIf(!KEY)('本物の Gemini で編集を評価する', () => {
  it('編集の件を流して採点する', async () => {
    mkdirSync('out/llm-eval', { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const lines: string[] = [];
    let stopped: string | null = null;
    for (const model of MODELS)
      for (const thinking of LEVELS) {
        if (stopped) break;
        const raw: Record<string, unknown[]> = {};
        const runs: { seconds: number; usage?: LlmUsage }[] = [];
        let calls = 0;
        let unknown = 0;
        const scores: CaseScore[] = [];
        const cases = EDIT_CASES.filter((x) => !ONLY || ONLY.includes(x.id));
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
          const base = editBase(c);
          const t0 = Date.now();
          const r = await textEdit(llm, { doc: base.doc, schemeId: base.schemeId, text: c.text, selected: base.selected, thinking });
          const seconds = (Date.now() - t0) / 1000;
          raw[c.id] = answers;
          runs.push({ seconds, usage: r.usage });
          const s = scoreEdit(c, base, r);
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
        if (stopped) sum.pass = false;
        const name = `edit-${stamp}-${model}-${thinking}`;
        writeFileSync(`out/llm-eval/${name}.json`, JSON.stringify({ model, thinking, summary: sum, scores, runs, raw }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded-edit', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded-edit/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          ...(stopped && scores.length < cases.length ? [`> **途中で止めました**: ${stopped}。${cases.length} 件のうち ${scores.length} 件だけ流しました`, ''] : []),
          `- 正しい: ${sum.correct} / ${sum.total}（${Math.round((sum.correct / sum.total) * 100)}%）`,
          `- 要確認か聞き返しで止まった: ${sum.flagged}`,
          `- 黙って間違えた: ${sum.silentWrong}`,
          `- 失敗（呼び出しのエラー）: ${sum.errors}`,
          `- 秒数: 平均 ${sum.seconds?.mean.toFixed(1)} 秒、最長 ${sum.seconds?.max.toFixed(1)} 秒`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(3)}（無料のキーなら 0）` : '不明'}。呼んだ ${calls} 回`
            + (sum.tokens ? `、入力 ${sum.tokens.input} トークン・出力 ${sum.tokens.output} トークン（うち考えた分 ${sum.tokens.thinking}）` : '')
            + (unknown ? `。時間切れなどで答えが届かなかった ${unknown} 回は数えていない` : ''),
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          '| 件 | 結果 | 秒 | 気になった所 |',
          '| --- | --- | --- | --- |',
          ...scores.map((s, i) => `| ${EDIT_CASES.find((c) => c.id === s.id)!.title} | ${s.outcome} | ${runs[i].seconds.toFixed(1)} | ${s.notes.join('<br>')} |`),
          '',
        );
      }
    const report = [`# 言葉での編集の評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/edit-${stamp}.md`, report);
    process.stdout.write(`\n${report}\n結果: out/llm-eval/edit-${stamp}.md\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

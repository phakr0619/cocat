// 本物の Gemini で、構造 → 名前を流して採点する。OPSIN は手元の jar を使う（先に server/opsin で mvn package）
//
//   PowerShell:  $env:AI_CHEM_EVAL_GEMINI_KEY = "…"; npm run eval:llm-name
//   bash:        AI_CHEM_EVAL_GEMINI_KEY=… npm run eval:llm-name
//
// キーと環境変数（LLM_MODEL・LLM_THINKING・LLM_CASES・LLM_DELAY_MS・LLM_TIMEOUT_MS・LLM_MAX_USD・RECORD）は、仕上げの評価（finish.eval.ts）と同じ。
// 比べるため、名前を AI で構造に戻す確かめ（OPSIN を使う前の形）も 1 件 1 回ずつ流し、違う名前を通してしまったかを数える。
// RECORD=1 で答えを tests/llm-eval/recorded-name/ に書く。結果は out/llm-eval/ に name- を付けて書く。キーはどこにも書かない
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { nameToStructure } from '../../src/llm/nameToStructure';
import { inchikeyOf, structureToName } from '../../src/llm/structureToName';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { hasOpsinJar, javaOpsin } from '../javaOpsin';
import { loadRDKit } from '../rdkit';
import { NAME_CASES, nameTruth, scoreName } from './name-score';
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

beforeAll(loadRDKit);

describe.skipIf(!KEY)('本物の Gemini で構造 → 名前を評価する', () => {
  it('件を流して採点する', async () => {
    if (!hasOpsinJar()) throw new Error('OPSIN の jar がありません。server/opsin で mvn -B package を実行してください');
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
        /** AI で戻す確かめ（前の形）: 違う名前を通した・正しい名前を落とした */
        const old = { falseAccept: 0, falseReject: 0, unknown: 0 };
        const cases = NAME_CASES.filter((x) => !ONLY || ONLY.includes(x.id));
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
          const t0 = Date.now();
          let opsinSmiles: string | undefined;
          const r = await structureToName(llm, {
            smiles: c.smiles,
            thinking,
            opsin: async (n) => {
              const a = (await javaOpsin([n]))?.[0];
              opsinSmiles = a?.smiles;
              return a?.smiles ? { smiles: a.smiles } : null;
            },
          });
          const seconds = (Date.now() - t0) / 1000;
          let usage = r.usage;
          const truth = r.ok ? nameTruth(c, opsinSmiles ? { status: 'SUCCESS', smiles: opsinSmiles } : undefined) : null;
          const s = scoreName(c, r, truth);
          // 比べる: 同じ名前を AI で構造に戻したら、どう確かめたか
          if (r.ok && r.checkedBy === 'opsin') {
            const back = await nameToStructure(llm, { name: r.name, thinking });
            usage = back.usage && usage ? { input: usage.input + back.usage.input, output: usage.output + back.usage.output, thinking: (usage.thinking ?? 0) + (back.usage.thinking ?? 0) } : usage;
            const oldOk = back.ok && inchikeyOf(back.smiles) === inchikeyOf(c.smiles);
            if (!back.ok) old.unknown++;
            else if (oldOk && truth === false) old.falseAccept++;
            else if (!oldOk && truth === true) old.falseReject++;
            if (back.ok && oldOk !== truth) s.notes.push(`AI で戻す確かめなら ${oldOk ? '確かめ済み' : '要確認'}（${back.smiles}）`);
          }
          raw[c.id] = answers;
          runs.push({ seconds, usage });
          scores.push(s);
          const usd = summarize([s], [{ seconds, usage }], model).usd ?? 0;
          spent += usd;
          process.stdout.write(`${model} ${thinking} ${c.id}: ${s.outcome} (${seconds.toFixed(1)} 秒, $${usd.toFixed(4)}) - ${s.notes.join(' / ')}\n`);
          stopped = stopReason(r) ?? (spent > MAX_USD ? `料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）` : null);
          if (stopped) {
            process.stdout.write(`止めました: ${stopped}。残りの ${cases.length - scores.length} 件は流していません\n`);
            break;
          }
          if (DELAY) await new Promise((res) => setTimeout(res, DELAY));
        }
        const sum = summarize(scores, runs, model);
        if (stopped) sum.pass = false;
        const named = scores.filter((s) => s.conditions.hit).length;
        const name = `name-${stamp}-${model}-${thinking}`;
        writeFileSync(`out/llm-eval/${name}.json`, JSON.stringify({ model, thinking, summary: sum, old, scores, runs, raw }, null, 2));
        if (process.env.RECORD === '1') {
          mkdirSync('tests/llm-eval/recorded-name', { recursive: true });
          writeFileSync(`tests/llm-eval/recorded-name/${model}-${thinking}.json`, JSON.stringify({ model, thinking, recordedAt: stamp, outcomes: Object.fromEntries(scores.map((s) => [s.id, s.outcome])), old, raw }, null, 2));
        }
        lines.push(
          `## ${model}（考える深さ: ${thinking}）`,
          '',
          ...(stopped && scores.length < cases.length ? [`> **途中で止めました**: ${stopped}。${cases.length} 件のうち ${scores.length} 件だけ流しました`, ''] : []),
          `- 正しい名前を書いた（OPSIN で戻して同じ構造）: ${named} / ${sum.total}`,
          `- 確かめ済みにした正しい名前: ${sum.correct}`,
          `- 要確認にした: ${sum.flagged}`,
          `- 黙って間違えた（違う名前を確かめ済みにした）: ${sum.silentWrong}`,
          `- 失敗（呼び出しのエラー）: ${sum.errors}`,
          `- 比べ: AI で戻す確かめ（前の形）なら、違う名前を通した ${old.falseAccept} 件・正しい名前を要確認にした ${old.falseReject} 件・戻せなかった ${old.unknown} 件`,
          `- 秒数: 平均 ${sum.seconds?.mean.toFixed(1)} 秒、最長 ${sum.seconds?.max.toFixed(1)} 秒（比べの呼び出しは含まない）`,
          `- 料金の目安: ${sum.usd !== undefined ? `$${sum.usd.toFixed(3)}（比べの呼び出しを含む。無料のキーなら 0）` : '不明'}`
            + (sum.tokens ? `、入力 ${sum.tokens.input} トークン・出力 ${sum.tokens.output} トークン（うち考えた分 ${sum.tokens.thinking}）` : ''),
          `- 完了の条件（8 割以上が正しく、黙って間違えたものが無い）: ${sum.pass ? '満たす' : '満たさない'}`,
          '',
          '| 件 | 結果 | 秒 | 名前・気になった所 |',
          '| --- | --- | --- | --- |',
          ...scores.map((s, i) => `| ${s.id} | ${s.outcome} | ${runs[i].seconds.toFixed(1)} | ${s.notes.join('<br>')} |`),
          '',
        );
      }
    const report = [`# 構造 → 名前の評価（${stamp}）`, '', ...lines].join('\n');
    writeFileSync(`out/llm-eval/name-${stamp}.md`, report);
    process.stdout.write(`\n${report}\n結果: out/llm-eval/name-${stamp}.md\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

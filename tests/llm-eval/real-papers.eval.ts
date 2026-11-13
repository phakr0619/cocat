// 実際の論文（tests/llm-eval/real-papers.json、BJOC 2025 の 3 本）で、M6 段3 の流れを本物の Gemini で通す
//
//   npm run fetch:real-papers                      # 論文と SI を取ってくる（リポジトリには入れない）
//   (cd server/opsin && mvn -B -q package)         # 手元の OPSIN（系統名 → 構造）
//   AI_CHEM_EVAL_GEMINI_KEY=… LLM_MAX_USD=0.2 npm run eval:llm-real
//
//   LLM_MODEL・LLM_THINKING・LLM_CASES（「bjoc-21-38-s4」など）・RECORD=1（tests/llm-eval/recorded-real/ に書く）
//   REPLAY=1 なら、記録した答えで流し直す（Gemini を呼ばない・料金なし・キーも要らない）。突き合わせや文字集めの直しを確かめるとき
//
// 1 つの図について: ページの画像 → 図の位置（findFigures）→ その範囲の画像 → ①画像 → スキーム → 本文・SI から番号の段落を集める → ②文字 → 事実 → 突き合わせ（OPSIN）
// 正解は持たない（実際の論文なので）。結果を out/llm-eval/ に書き、人が論文と見比べる
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { figureToCrop, findFigures } from '../../src/llm/findFigures';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { addPaperFacts, collectForFigure, indexPdfText } from '../../src/llm/paperFacts';
import { collectedText, linesOf, toItems, type TextLine } from '../../src/llm/pdfText';
import { textToScheme } from '../../src/llm/textToScheme';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { hasOpsinJar, javaOpsin } from '../javaOpsin';
import { PRICES } from './score';
import { replayLlm } from './replay';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? 'gemini-3.8-flash';
const THINKING = (process.env.LLM_THINKING ?? 'low') as ThinkingLevel;
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.2);
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
if (!(MAX_USD > 0)) throw new Error(`LLM_MAX_USD は正の数で（今は ${process.env.LLM_MAX_USD}）`);

const REPLAY = process.env.REPLAY === '1';
const RECORDED = `tests/llm-eval/recorded-real/${MODEL}-${THINKING}.json`;
const DIR = 'tests/llm-eval/real-papers';
const OUT = 'out/llm-eval/real';

/** 確かめる図: 論文・ページ・ページの中で何番目の反応スキームか（上から） */
export const REAL_CASES = [
  { id: 'bjoc-21-38-s2', paper: 'bjoc-21-38', page: 3, nth: 0, caption: 'Scheme 2: Synthesis of chiral tosylate (S)-10' },
  { id: 'bjoc-21-38-s4', paper: 'bjoc-21-38', page: 4, nth: 0, caption: 'Scheme 4: Synthesis of the aggregation pheromone of Tribolium castaneum' },
  { id: 'bjoc-21-47-s3', paper: 'bjoc-21-47', page: 4, nth: 0, caption: 'Scheme 3: Rapid access of the basic skeleton of (±)-simonsol C' },
  { id: 'bjoc-21-47-s4', paper: 'bjoc-21-47', page: 5, nth: 0, caption: 'Scheme 4: Synthetic details to (±)-simonsol C' },
  { id: 'bjoc-21-14-s2', paper: 'bjoc-21-14', page: 5, nth: 0, caption: 'Scheme 2: Streamlined synthesis of the substructure 14' },
];

/** ページの大きさ（pt） */
function pageSizePt(pdf: string, page: number): { width: number; height: number } {
  const info = execFileSync('pdfinfo', ['-f', String(page), '-l', String(page), pdf]).toString();
  const m = /Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/.exec(info)!;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** ページ（の範囲）を PNG にする。長い辺 2048 px・600 dpi まで（アプリの cropToImage と同じ決まり） */
function render(pdf: string, page: number, crop?: { x: number; y: number; width: number; height: number }): Buffer {
  const size = pageSizePt(pdf, page);
  const box = crop ?? { x: 0, y: 0, ...size };
  const dpi = Math.min(600, 2048 / (Math.max(box.width, box.height) / 72));
  const s = dpi / 72;
  const args = ['-f', String(page), '-l', String(page), '-r', dpi.toFixed(2), '-png', '-singlefile'];
  if (crop) args.push('-x', String(Math.round(box.x * s)), '-y', String(Math.round(box.y * s)), '-W', String(Math.round(box.width * s)), '-H', String(Math.round(box.height * s)));
  const tmp = `${OUT}/tmp-render`;
  execFileSync('pdftoppm', [...args, pdf, tmp]);
  return readFileSync(`${tmp}.png`);
}

const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

async function pdfLines(pdf: string, pages?: number[]): Promise<TextLine[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise;
  const out: TextLine[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (pages && !pages.includes(n)) continue;
    const pg = await doc.getPage(n);
    out.push(...linesOf(toItems((await pg.getTextContent()).items), n, pg.getViewport({ scale: 1 }).width));
  }
  return out;
}

const papersReady = REAL_CASES.every((c) => existsSync(`${DIR}/${c.paper}.pdf`) && existsSync(`${DIR}/${c.paper}-S1.pdf`));

describe.skipIf((REPLAY ? !existsSync(RECORDED) : !KEY) || !papersReady || !hasOpsinJar())('実際の論文で、図 → ①・本文と SI → ② → 突き合わせを通す', () => {
  it('5 つの図', async () => {
    await loadRDKit();
    mkdirSync(OUT, { recursive: true });
    const price = PRICES[MODEL];
    let spent = 0;
    const cost = (u?: LlmUsage) => (u && price ? (u.input * price.input + u.output * price.output) / 1e6 : 0);
    const raw: Record<string, unknown[]> = {};
    const gemini = createGemini({ apiKey: KEY, model: MODEL, timeoutMs: GEMINI_TIMEOUT_MS });
    /** 答えを記録する Gemini（RECORD=1 のとき、流し直しに使う） */
    const recorded = REPLAY ? (JSON.parse(readFileSync(RECORDED, 'utf8')) as { raw: Record<string, unknown[]> }).raw : {};
    const recording = (id: string): LlmProvider => REPLAY ? replayLlm(recorded[id] ?? []) : ({
      ...gemini,
      generateJson: async (req) => {
        const a = await gemini.generateJson(req);
        (raw[id] ??= []).push(a.ok ? a.value : { error: a.error });
        return a as never;
      },
    });
    const opsin = async (name: string) => (await javaOpsin([name]))?.[0]?.smiles ?? null;
    const report: string[] = [`# 実際の論文で M6 段3 を通した結果（${MODEL}・${THINKING}${REPLAY ? '・記録した答えで流し直し' : ''}）`, ''];
    const cases = REAL_CASES.filter((c) => !ONLY || ONLY.includes(c.id));
    for (const c of cases) {
      if (spent > MAX_USD) {
        report.push(`止めました: 料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）`);
        break;
      }
      const main = `${DIR}/${c.paper}.pdf`;
      const si = `${DIR}/${c.paper}-S1.pdf`;
      const llm = recording(c.id);
      // 図の位置
      const pagePng = render(main, c.page);
      const ps = pngSize(pagePng);
      const fig = await findFigures(llm, { image: { mimeType: 'image/png', data: pagePng.toString('base64') }, thinking: 'low' });
      spent += cost(fig.usage);
      const schemes = fig.ok ? fig.figures.filter((f) => f.kind === 'reaction-scheme') : [];
      const pick = schemes[c.nth];
      if (!pick) {
        report.push(`## ${c.id}（${c.caption}）`, '', `図が見つかりませんでした（反応スキーム ${schemes.length} 個）`, '');
        continue;
      }
      const size = pageSizePt(main, c.page);
      const crop = figureToCrop(pick, size, 6);
      const cropPng = render(main, c.page, crop);
      writeFileSync(`${OUT}/${c.id}.png`, cropPng);
      const cs = pngSize(cropPng);
      // ①
      const name = `${c.paper}.pdf p.${c.page} (crop)`;
      const one = await textToScheme(llm, {
        text: '',
        existing: [],
        image: { summary: `IMAGE: ${name}（image/png、${cs.width}×${cs.height} px、${Math.round(cropPng.length / 1024)} KB）`, images: [{ mimeType: 'image/png', data: cropPng.toString('base64') }] },
        thinking: THINKING,
      });
      spent += cost(one.usage);
      if (!one.ok) {
        report.push(`## ${c.id}`, '', `①に失敗: ${one.error.kind} ${one.error.message}`, '');
        continue;
      }
      // 本文と SI の文字を集める（本文は実験項があるかもしれないので、全ページを索引にする）
      const mainLines = await pdfLines(main);
      const siLines = await pdfLines(si);
      const collected = collectForFigure(
        one.checked,
        { source: '本文', page: c.page, lines: mainLines.filter((l) => l.page === c.page) },
        [indexPdfText('SI', siLines), indexPdfText('本文', mainLines)],
      );
      // ②と突き合わせ
      const two = await addPaperFacts(llm, { checked: one.checked, collected, opsin, thinking: THINKING });
      spent += cost(two.usage);
      const after = two.ok ? two.checked : one.checked;
      const lab = (ref: string) => after.compounds[ref]?.number ?? after.compounds[ref]?.name ?? ref;
      report.push(
        `## ${c.id}（${c.caption}）`,
        '',
        `- 画像: ${cs.width}×${cs.height} px（ページ ${ps.width}×${ps.height} px から切り出し）`,
        `- 送った文字: ${collected.chars} 文字、${collected.parts.length} まとまり（${collected.parts.map((p) => `${p.why}${p.label ? `:${p.label}` : ''}`).join('、')}）。見つからなかった番号: ${collected.missing.join('、') || 'なし'}`,
        `- ②: ${two.ok ? `補った ${two.notes.textSources.length} 項目、捨てた答え ${two.dropped}` : `失敗 ${two.error.kind}`}`,
        '',
        '| 化合物 | 図から読んだ構造 | 名前の確かめ |',
        '| --- | --- | --- |',
        ...Object.keys(after.compounds).map((ref) => {
          const nc = two.ok ? two.notes.nameChecks.find((n) => n.ref === ref) : undefined;
          return `| ${lab(ref)} | \`${after.compounds[ref].smiles ?? '（不明）'}\` | ${nc ? `${nc.result}（${nc.where}「${nc.name}」${nc.result !== 'match' && nc.smiles ? ` → \`${nc.smiles}\`` : ''}）` : '-'} |`;
        }),
        '',
        '| 段 | 試薬 | 溶媒 | 温度 | 時間 | 収率 | 文字から補った所 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...after.steps.map((s, i) => {
          const src = two.ok ? two.notes.textSources.filter((t) => t.stepIndex === i).map((t) => `${t.field}（${t.where}）`) : [];
          return `| ${s.from.map(lab).join(' + ')} → ${s.to.map(lab).join(' + ')} | ${(s.reagents ?? []).map((r) => r.text + (r.equiv ? ` ${r.equiv} equiv` : '')).join(', ')} | ${s.solvent ?? ''} | ${s.temp ?? ''} | ${s.time ?? ''} | ${s.yield ?? ''} | ${src.join('、')} |`;
        }),
        '',
        '要確認:',
        ...after.issues.map((i) => `- [${i.kind}] ${i.message}`),
        '',
      );
      writeFileSync(`${OUT}/${c.id}-sent.txt`, collectedText(collected));
      process.stdout.write(`${c.id}: 料金の目安 $${spent.toFixed(4)}\n`);
    }
    report.push(`料金の目安（合計）: $${spent.toFixed(4)}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    writeFileSync(`${OUT}/report-${stamp}.md`, report.join('\n'));
    process.stdout.write(`\n${report.join('\n')}\n`);
    if (process.env.RECORD === '1' && !REPLAY) {
      mkdirSync('tests/llm-eval/recorded-real', { recursive: true });
      writeFileSync(`tests/llm-eval/recorded-real/${MODEL}-${THINKING}.json`, JSON.stringify({ model: MODEL, thinking: THINKING, recordedAt: stamp, raw }, null, 2));
    }
    expect(spent).toBeLessThan(MAX_USD * 1.5);
  });
});

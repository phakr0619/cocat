// M6 段3 の評価: 作った SI（tests/llm-eval/si-cases.json）で、②文字 → 事実と突き合わせを確かめる
//
//   AI_CHEM_EVAL_GEMINI_KEY=… LLM_MAX_USD=0.5 RECORD=1 npm run eval:llm-si
//   REPLAY=1 npm run eval:llm-si   … 記録した②の答えで流し直す（Gemini を呼ばない・料金なし）
//   DRY=1 npm run eval:llm-si      … ②を呼ばずに空の答えにする（文字の集め方だけを確かめる）
//
// ①（図 → スキーム）は、段2 の記録（tests/llm-eval/recorded-pdf/）を流し直す（料金なし）。本文は段2 の評価の PDF（tests/llm-eval/pdfs/）、
// SI は件と版ごとに、ここで HTML から PDF にする（Chromium）。版:
//   same      … SI の条件・名前は図と同じ（図に無い温度・時間・収率も書く） → 食い違いを誤って出さない・補えた割合・名前の確かめ
//   conflict  … SI の収率か温度を 1 つ変える（図にその値がある件だけ） → 食い違いを見つけた割合
//   wrong     … SI の系統名を、置換の位置などが違う構造の名前にする → 名前の食い違いを見つけた割合
//   missing   … SI から生成物の段落を消す → 見つからなかった番号を知らせる・誤って補わない
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { createGemini, GEMINI_TIMEOUT_MS } from '../../src/llm/gemini';
import { addPaperFacts, collectForFigure, figureLabels, indexPdfText } from '../../src/llm/paperFacts';
import { figureLabel, linesOf, toItems, type TextLine } from '../../src/llm/pdfText';
import { sameValue } from '../../src/llm/reconcile';
import { inchikeyOf } from '../../src/llm/structureToName';
import { textToScheme, type CheckedPlan } from '../../src/llm/textToScheme';
import type { LlmProvider, LlmUsage, ThinkingLevel } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { hasOpsinJar, javaOpsin } from '../javaOpsin';
import { PDF_CASES, pdfReplayInput } from './pdf-cases';
import { replayLlm } from './replay';
import { PRICES } from './score';
import siCases from './si-cases.json';

const KEY = process.env.AI_CHEM_EVAL_GEMINI_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? 'gemini-3.8-flash';
const THINKING = (process.env.LLM_THINKING ?? 'low') as ThinkingLevel;
const MAX_USD = Number(process.env.LLM_MAX_USD ?? 0.3);
const REPLAY = process.env.REPLAY === '1';
/** DRY=1 なら②を呼ばずに空の答えを返す（文字の集め方と数え方だけを確かめる。料金なし） */
const DRY = process.env.DRY === '1';
const ONLY = process.env.LLM_CASES?.split(',').map((s) => s.trim());
const RECORDED = `tests/llm-eval/recorded-si/${MODEL}-${THINKING}.json`;
const FIGURES = `tests/llm-eval/recorded-pdf/${MODEL}-${THINKING}.json`;
const OUT = 'out/llm-eval/si';

type Version = 'same' | 'conflict' | 'wrong' | 'missing';
const VERSIONS: Version[] = ['same', 'conflict', 'wrong', 'missing'];
type SiCase = (typeof siCases.cases)[number];
type Product = SiCase['products'][number];
type Conflict = { label: string; field: 'yield' | 'temp'; value: number | string; find?: string; replace?: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FILLER =
  'All reactions were carried out under an argon atmosphere in oven-dried glassware unless otherwise noted. Solvents were dried by passing through activated alumina columns. Thin-layer chromatography was performed on silica gel plates and visualized under UV light. NMR spectra were recorded on a 400 MHz spectrometer and chemical shifts are reported relative to the residual solvent signal.';

/** 件と版の SI の HTML。関係ない化合物（S9）の段落も入れる */
function siHtml(c: SiCase, v: Version): string {
  const conflict = c.conflict as Conflict | null;
  const blocks = c.products.flatMap((p: Product) => {
    if (v === 'missing') return [];
    const hit = v === 'conflict' && conflict?.label === p.label ? conflict : null;
    const procedure = hit?.field === 'temp' && hit.find ? p.procedure.replace(hit.find, hit.replace!) : p.procedure;
    const yieldText = String(hit?.field === 'yield' ? hit.value : p.yield);
    return [
      `<p>${esc(v === 'wrong' ? p.wrong : p.name)} (${p.label})</p>`,
      `<p>${esc(procedure)} ${esc(p.result.replace('{yield}', yieldText))}</p>`,
      '<p>¹H NMR (400 MHz, CDCl₃) δ 7.32–7.25 (m, 2H), 3.71 (s, 3H), 1.44 (s, 9H).</p>',
    ];
  });
  return `<html><body style="font: 10.5pt serif; margin: 2cm">
    <p style="font-size: 14pt">Supporting Information</p>
    <p>General information. ${FILLER}</p>
    ${blocks.join('\n')}
    <p>Ethyl 2-oxo-2-(thiophen-2-yl)acetate (S9)</p>
    <p>A solution of thiophene (0.84 g, 10.0 mmol) and ethyl chlorooxoacetate (1.2 mL) in CH2Cl2 (30 mL) was treated with AlCl3 at −10 °C for 10 h to give S9 (0.92 g, 50%) as an orange oil. ${FILLER}</p>
  </body></html>`;
}

async function pdfLines(data: Uint8Array): Promise<TextLine[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const out: TextLine[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    out.push(...linesOf(toItems((await pg.getTextContent()).items), n, pg.getViewport({ scale: 1 }).width));
  }
  return out;
}

/** ①の答えの段のうち、番号 label を生成物にする段の位置 */
const stepOf = (checked: CheckedPlan, label: string) => figureLabels(checked).steps.findIndex((s) => s.to.includes(label));
const refOf = (checked: CheckedPlan, label: string) => Object.keys(checked.compounds).find((r) => figureLabel(checked.compounds[r].number ?? checked.compounds[r].name ?? r) === label);

const casesReady = siCases.cases.every((c) => existsSync(`tests/llm-eval/pdfs/${c.base}-png.pdf`)) && existsSync(FIGURES);

describe.skipIf((REPLAY ? !existsSync(RECORDED) : !KEY && !DRY) || !casesReady || !hasOpsinJar())('作った SI で、②文字 → 事実と突き合わせ', () => {
  it('16 件 × 4 版', async () => {
    await loadRDKit();
    mkdirSync(OUT, { recursive: true });
    const price = PRICES[MODEL];
    const cost = (u?: LlmUsage) => (u && price ? (u.input * price.input + u.output * price.output) / 1e6 : 0);
    let spent = 0;
    const figures = (JSON.parse(readFileSync(FIGURES, 'utf8')) as { raw: Record<string, unknown[]> }).raw;
    const recorded = REPLAY ? (JSON.parse(readFileSync(RECORDED, 'utf8')) as { raw: Record<string, unknown[]> }).raw : {};
    const raw: Record<string, unknown[]> = {};
    const gemini = createGemini({ apiKey: KEY, model: MODEL, timeoutMs: GEMINI_TIMEOUT_MS });
    const llmFor = (key: string): LlmProvider =>
      DRY
        ? replayLlm([{ compounds: [], steps: [] }])
        : REPLAY
        ? replayLlm(recorded[key] ?? [])
        : {
            ...gemini,
            generateJson: async (req) => {
              const a = await gemini.generateJson(req);
              (raw[key] ??= []).push(a.ok ? a.value : { error: a.error });
              return a as never;
            },
          };
    const opsin = async (name: string) => (await javaOpsin([name]))?.[0]?.smiles ?? null;
    // クラウドの環境では、入っている Chromium を使う（playwright.config.ts と同じ）
    const cloudChromium = '/opt/pw-browsers/chromium';
    const browser = await chromium.launch(existsSync(cloudChromium) ? { executablePath: cloudChromium } : {});

    // 数えるもの
    const m = { falseConflicts: 0, fillable: 0, filled: 0, wrongFill: 0, conflictCases: 0, conflictFound: 0, nameCases: 0, nameRight: 0, wrongCases: 0, wrongFound: 0, wrongFilled: 0, missingCases: 0, missingTold: 0, missingFill: 0, errors: 0 };
    const lines: string[] = [];
    const note = (s: string) => lines.push(s);

    for (const c of siCases.cases) {
      if (ONLY && !ONLY.includes(c.base)) continue;
      const pc = PDF_CASES.find((x) => x.id === `${c.base}-png-crop`)!;
      // ①: 段2 の記録を流し直す
      const one = await textToScheme(replayLlm(figures[pc.id] ?? []), { text: pc.text, existing: [], image: pdfReplayInput(pc) });
      if (!one.ok) {
        note(`- ${c.base}: ①の記録を流し直せませんでした（${one.error.kind}）`);
        continue;
      }
      const checked = one.checked;
      const main = new Uint8Array(readFileSync(`tests/llm-eval/pdfs/${c.base}-png.pdf`));
      const mainLines = await pdfLines(main);
      for (const v of VERSIONS) {
        const conflict = c.conflict as Conflict | null;
        if (v === 'conflict') {
          // 図（①）にその値が無ければ、食い違いは見つけようがない
          const si = conflict ? stepOf(checked, conflict.label) : -1;
          if (si < 0 || checked.steps[si][conflict!.field] === undefined || checked.steps[si][conflict!.field] === null || checked.steps[si][conflict!.field] === '') continue;
        }
        if (spent > MAX_USD) {
          note(`- 止めました: 料金の目安が上限（$${MAX_USD}）を超えた（$${spent.toFixed(3)}）`);
          break;
        }
        const key = `${c.base}:${v}`;
        const page = await browser.newPage();
        await page.setContent(siHtml(c, v));
        const siPdf = await page.pdf({ format: 'A4' });
        await page.close();
        writeFileSync(`${OUT}/${c.base}-${v}.pdf`, siPdf);
        const siLines = await pdfLines(new Uint8Array(siPdf));
        const collected = collectForFigure(checked, { source: '本文', page: 1, lines: mainLines.filter((l) => l.page === 1) }, [indexPdfText('SI', siLines), indexPdfText('本文', mainLines)]);
        const two = await addPaperFacts(llmFor(key), { checked, collected, opsin, thinking: THINKING });
        spent += cost(two.usage);
        if (!two.ok) {
          m.errors++;
          note(`- ${key}: ②が失敗（${two.error.kind}: ${two.error.message}）`);
          continue;
        }
        const after = two.checked;
        const conflicts = after.issues.filter((i) => i.kind === 'text');
        const got: string[] = [];
        for (const p of c.products) {
          const si = stepOf(checked, p.label);
          const ref = refOf(checked, p.label);
          if (v === 'same' || v === 'missing') {
            // 補えたか（図に無く、SI にある温度・時間・収率）。missing では補わないのが正しい
            if (si >= 0)
              for (const field of ['temp', 'time', 'yield'] as const) {
                const fig = checked.steps[si][field];
                if (fig !== undefined && fig !== null && fig !== '') continue;
                const val = after.steps[si][field];
                const filled = val !== undefined && val !== null && val !== '';
                if (v === 'missing') {
                  if (filled) {
                    m.missingFill++;
                    got.push(`${p.label} の${field}を補った（${val}）`);
                  }
                  continue;
                }
                m.fillable++;
                if (!filled) got.push(`${p.label} の${field}を補えず`);
                else if (sameValue(field, val as string | number, p[field] as string | number) === false) {
                  m.wrongFill++;
                  got.push(`${p.label} の${field}を間違えて補った（${val}、正しくは ${p[field]}）`);
                } else m.filled++;
              }
            else got.push(`${p.label} の段が①に無い`);
          }
          if (v === 'same' && ref) {
            // 名前の確かめ: 図の構造が正しければ match、違えば mismatch か stereo、無ければ filled
            m.nameCases++;
            const nc = two.notes.nameChecks.find((n) => n.ref === ref);
            const fig = checked.compounds[ref];
            const truth = inchikeyOf(p.smiles);
            const figKey = fig?.known && fig.smiles ? inchikeyOf(fig.smiles) : null;
            const want = !figKey ? 'filled' : figKey === truth ? 'match' : figKey.slice(0, 14) === truth?.slice(0, 14) ? 'stereo' : 'mismatch';
            if (nc?.result === want) m.nameRight++;
            else got.push(`${p.label} の名前の確かめ: ${nc?.result ?? 'なし'}（${want} のはず）`);
          }
          if (v === 'wrong' && ref) {
            m.wrongCases++;
            const nc = two.notes.nameChecks.find((n) => n.ref === ref);
            if (nc?.result === 'mismatch' || nc?.result === 'stereo') m.wrongFound++;
            else if (nc?.result === 'filled') {
              m.wrongFilled++;
              got.push(`${p.label}: 図の構造が無く、間違った名前の構造を入れた（要確認は出る）`);
            } else got.push(`${p.label} の名前の食い違いを見逃した（${nc?.result ?? 'なし'}）`);
          }
        }
        if (v === 'missing') {
          m.missingCases++;
          const told = c.products.every((p) => collected.missing.includes(p.label));
          if (told) m.missingTold++;
          else got.push(`見つからなかった番号の知らせ: ${collected.missing.join(', ') || 'なし'}`);
        }
        if (v === 'conflict') {
          m.conflictCases++;
          const si = stepOf(checked, conflict!.label);
          const ja = conflict!.field === 'yield' ? '収率' : '温度';
          if (conflicts.some((i) => i.stepIndex === si && i.message.includes(ja))) m.conflictFound++;
          else got.push(`${conflict!.label} の${ja}の食い違いを見逃した`);
          const others = conflicts.filter((i) => !(i.stepIndex === si && i.message.includes(ja)));
          m.falseConflicts += others.length;
          others.forEach((i) => got.push(`誤った食い違い: ${i.message}`));
        } else {
          m.falseConflicts += conflicts.length;
          conflicts.forEach((i) => got.push(`誤った食い違い: ${i.message}`));
        }
        note(`- ${key}: 送った ${collected.parts.length} まとまり・${collected.chars} 文字、補った ${two.notes.textSources.length}、捨てた答え ${two.dropped}${got.length ? ` — ${got.join(' / ')}` : ' — 問題なし'}`);
        process.stdout.write(`${key}: $${cost(two.usage).toFixed(4)}\n`);
      }
    }
    await browser.close();

    const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%（${a}/${b}）` : '-');
    const report = [
      `# 作った SI での M6 段3 の評価（${MODEL}・${THINKING}${REPLAY ? '・記録した答えで流し直し' : ''}）`,
      '',
      `- 誤った食い違い（図と同じ値なのに食い違いと出した）: ${m.falseConflicts}`,
      `- 図に無い温度・時間・収率を SI から補えた: ${pct(m.filled, m.fillable)}、間違えて補った: ${m.wrongFill}`,
      `- 食い違いを見つけた: ${pct(m.conflictFound, m.conflictCases)}`,
      `- 名前の確かめ（一致・違い・名前から入れる）が正しかった: ${pct(m.nameRight, m.nameCases)}`,
      `- 名前の食い違いを見つけた: ${pct(m.wrongFound, m.wrongCases)}（図の構造が無く、間違った名前から入れた: ${m.wrongFilled}）`,
      `- 生成物の段落が無いとき、見つからなかった番号を知らせた: ${pct(m.missingTold, m.missingCases)}、それでも補った: ${m.missingFill}`,
      `- ②の失敗: ${m.errors}`,
      `- 料金の目安: $${spent.toFixed(4)}`,
      '',
      ...lines,
    ];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    writeFileSync(`${OUT}/report-${stamp}.md`, report.join('\n'));
    process.stdout.write(`\n${report.join('\n')}\n`);
    if (process.env.RECORD === '1' && !REPLAY && !DRY) {
      mkdirSync('tests/llm-eval/recorded-si', { recursive: true });
      writeFileSync(RECORDED, JSON.stringify({ model: MODEL, thinking: THINKING, recordedAt: stamp, raw }, null, 2));
    }
    expect(spent).toBeLessThan(MAX_USD * 1.5);
  });
});

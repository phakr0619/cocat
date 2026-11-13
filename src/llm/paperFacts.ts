// 論文の図から作った下書き（①の結果）に、本文・SI の文字を添える流れをまとめる。
// 画面（TextToSchemePanel）と評価（tests/llm-eval）の両方が使う
import { collectText, collectedText, figureLabel, joinLines, paragraphsOf, sectionsOf, type Collected, type Section, type TextLine } from './pdfText';
import { reconcile, type NameToSmiles, type ReconcileNotes } from './reconcile';
import { textFacts } from './textFacts';
import type { CheckedPlan } from './textToScheme';
export { figureLabel };
import type { LlmError, LlmProvider, LlmUsage, ThinkingLevel } from './types';

/** 1 本の PDF の文字（全ページの行）から、見出しのまとまりと段落を作ったもの */
export interface PdfTextIndex {
  source: string;
  sections: Section[];
  paragraphs: { page: number; text: string }[];
}

export function indexPdfText(source: string, lines: readonly TextLine[]): PdfTextIndex {
  return { source, sections: sectionsOf(lines, source), paragraphs: paragraphsOf(lines).map((p) => ({ page: p[0].page, text: joinLines(p) })) };
}

/** ①の結果の化合物の番号（①の答えの name）。番号らしくないもの（試薬名など）も、そのまま使う */
export function figureLabels(checked: CheckedPlan): { all: string[]; products: string[]; steps: { from: string[]; to: string[] }[]; unlabeled: number } {
  // 番号も呼び名も無い化合物（番号の無い図）は、文字の中で探しようがないので入れない
  const label = (ref: string) => {
    const c = checked.compounds[ref];
    const l = (c?.number ?? c?.name)?.trim();
    return l ? figureLabel(l) : undefined;
  };
  const has = (x: string | undefined): x is string => !!x;
  const steps = checked.steps.map((s) => ({ from: s.from.map(label).filter(has), to: s.to.map(label).filter(has) }));
  const all = [...new Set(Object.keys(checked.compounds).map(label).filter(has))];
  const products = [...new Set(steps.flatMap((s) => s.to))];
  const unlabeled = Object.keys(checked.compounds).filter((r) => !label(r)).length;
  return { all, products, steps, unlabeled };
}

/** 送る文字を集める（AI は使わない。「送る内容を見る」にも出す） */
export function collectForFigure(checked: CheckedPlan, figurePage: { source: string; page: number; lines: readonly TextLine[] } | undefined, docs: readonly PdfTextIndex[], limit?: number): Collected {
  const f = figureLabels(checked);
  return { ...collectText({ figurePage, docs, products: f.products, others: f.all.filter((x) => !f.products.includes(x)) }, limit), unlabeled: f.unlabeled };
}

export type PaperFactsResult =
  | { ok: true; checked: CheckedPlan; notes: ReconcileNotes; collected: Collected; dropped: number; usage?: LlmUsage }
  | { ok: false; error: LlmError; collected: Collected; usage?: LlmUsage };

/** ②を呼んで突き合わせる。送る文字が無ければ、①の結果をそのまま返す（呼ばない） */
export async function addPaperFacts(
  llm: LlmProvider,
  req: { checked: CheckedPlan; collected: Collected; opsin: NameToSmiles | null; thinking?: ThinkingLevel; signal?: AbortSignal },
): Promise<PaperFactsResult> {
  const { checked, collected } = req;
  if (!collected.parts.length) return { ok: true, checked, notes: { textSources: [], nameChecks: [] }, collected, dropped: 0 };
  const f = figureLabels(checked);
  const r = await textFacts(llm, { figure: { compounds: f.all, steps: f.steps }, text: collectedText(collected), thinking: req.thinking, signal: req.signal });
  if (!r.ok) return { ok: false, error: r.error, collected, usage: r.usage };
  const rec = await reconcile(checked, r.facts, req.opsin);
  return { ok: true, checked: rec.checked, notes: rec.notes, collected, dropped: r.dropped, usage: r.usage };
}

/** 本文と SI の 2 本のうち、どちらが SI か（ファイル名に「SI」「supporting」「supplementary」「ESI」があれば、それ。無ければページの多いほうを本文とみなす）。0 か 1 */
export function guessSiIndex(files: readonly [{ name: string; numPages: number }, { name: string; numPages: number }]): 0 | 1 {
  const si = (n: string) => /(^|[^a-z])(si|esi)([^a-z]|$)|supporting|supplement/i.test(n.replace(/\.pdf$/i, ''));
  const a = si(files[0].name);
  const b = si(files[1].name);
  if (a !== b) return a ? 0 : 1;
  return files[0].numPages > files[1].numPages ? 1 : 0;
}

/** PDF の全ページの文字から索引を作る（ブラウザの中で。ページごとの文字は OpenedPdf が覚えている） */
export async function indexPdf(pdf: { numPages: number; textLines(page: number): Promise<TextLine[]> }, source: string, signal?: AbortSignal): Promise<PdfTextIndex> {
  const lines: TextLine[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (signal?.aborted) break;
    lines.push(...(await pdf.textLines(n).catch(() => [])));
  }
  return indexPdfText(source, lines);
}

/** 送る文字のまとまりを指す印（外したまとまりを覚えるため） */
export const partKey = (p: { source: string; page: number; why: string; label?: string; text: string }) => `${p.source}:${p.page}:${p.why}:${p.label ?? ''}:${p.text.slice(0, 40)}`;

/** 外したまとまりを除く */
export function withoutParts(c: Collected, removed: ReadonlySet<string>): Collected {
  const parts = c.parts.filter((p) => !removed.has(partKey(p)));
  return { ...c, parts, chars: parts.reduce((n, p) => n + p.text.length, 0) };
}

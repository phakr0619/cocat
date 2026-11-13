// 評価の図（画像・PDF）を、このアプリで描くための共通の部品。e2e/make-eval-images.spec.ts と e2e/make-eval-pdfs.spec.ts が使う
// （論文・出版社の図は使わない。正解（cases.json）の構造と条件からスキームを作って描く）
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export type ImageCase = { id: string; base: string; style: string; dpi: number; numbered: boolean; variant: string; extraReagents?: string[] };
export type ExpectStep = { from: string[]; to: string[]; reagents?: string[]; solvent?: string; temp?: string; yield?: number };
export type BaseCase = { id: string; expect: { kind: string; steps?: ExpectStep[] } };
export type EvalPlan = {
  steps: { from: string[]; to: string[]; reagents: { text: string }[]; solvent: string | null; temp: string | null; time: null; yield: number | null }[];
  compounds: { ref: string; smiles: string; name?: string }[];
  questions: never[];
};

/** 画像の件と、その正解の元の件（cases.json） */
export function loadEvalCases(): { cases: ImageCase[]; bases: BaseCase[] } {
  return {
    cases: (JSON.parse(readFileSync('tests/llm-eval/image-cases.json', 'utf8')) as { cases: ImageCase[] }).cases,
    bases: (JSON.parse(readFileSync('tests/llm-eval/cases.json', 'utf8')) as { cases: BaseCase[] }).cases,
  };
}

/** 正解をそのまま LLM の答えの形にする（同じ SMILES は同じ化合物。番号つきなら出てきた順に 1, 2, 3） */
export function buildPlan(c: ImageCase, steps: ExpectStep[]): EvalPlan {
  const refs = new Map<string, string>();
  const ref = (s: string) => {
    if (!refs.has(s)) refs.set(s, String.fromCharCode(65 + refs.size));
    return refs.get(s)!;
  };
  const plan: EvalPlan = {
    steps: steps.map((st, i) => ({
      from: st.from.map(ref),
      to: st.to.map(ref),
      reagents: [...(i === 0 ? (c.extraReagents ?? []) : []), ...(st.reagents ?? [])].map((text) => ({ text })),
      solvent: st.solvent ?? null,
      temp: st.temp ? `${st.temp} °C` : null,
      time: null,
      yield: st.yield ?? null,
    })),
    compounds: [],
    questions: [],
  };
  plan.compounds = [...refs].map(([smiles, r], i) => ({ ref: r, smiles, ...(c.numbered ? { name: String(i + 1) } : {}) }));
  return plan;
}

/** アプリのモジュールを読めるようにする（ページを開き、RDKit が使えるまで待つ） */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
  // ページの中で、Vite が配るアプリのモジュールを読む（文字の変数で渡すのは、tsc がこの道を探さないように）
  await page.waitForFunction(async (p) => ((await import(/* @vite-ignore */ p)) as typeof import('../src/chem/rdkit')).hasRDKit(), '/src/chem/rdkit.ts');
}

/**
 * スキームを描く。png は base64（長辺が maxSide を超えない解像度）、svg は exportSvg の文字列。
 * 同じスキームからは同じ図ができる（png と svg は書き出しの形だけが違う）
 */
export async function drawScheme(
  page: Page,
  a: { plan: EvalPlan; style: string; dpi: number; maxSide: number; format: 'png' | 'svg' },
): Promise<{ data: string; issues: string[] }> {
  return page.evaluate(
    async ({ plan, style, dpi, maxSide, format, src }) => {
      const { emptyDoc } = (await import(/* @vite-ignore */ `${src}/chem/model.ts`)) as typeof import('../src/chem/model');
      const t = (await import(/* @vite-ignore */ `${src}/llm/textToScheme.ts`)) as typeof import('../src/llm/textToScheme');
      const { exportPng, exportSvg } = (await import(/* @vite-ignore */ `${src}/io/convert.ts`)) as typeof import('../src/io/convert');
      const checked = t.checkPlan(plan as never, []);
      const r = t.draftScheme(emptyDoc(), checked, { text: '', model: '', origin: { x: 40, y: 40 }, styleId: style });
      const doc = t.confirmDraft(r.doc, r.schemeId);
      const issues = checked.issues.map((i) => i.message);
      const svg = exportSvg(doc);
      if (format === 'svg') return { data: svg, issues };
      // 長辺が上限を超えない解像度にする
      const m = svg.match(/width="([\d.]+)pt" height="([\d.]+)pt"/)!;
      const long = Math.max(parseFloat(m[1]), parseFloat(m[2]));
      const blob = await exportPng(doc, Math.min(dpi, Math.floor((maxSide * 72) / long)));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const x of bytes) s += String.fromCharCode(x);
      return { data: btoa(s), issues };
    },
    { ...a, src: '/src' },
  );
}

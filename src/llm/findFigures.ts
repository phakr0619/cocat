// PDF のページの画像から、反応スキームの図の位置を Gemini に答えさせる
//
// ページ全体を送ると図が小さくなり、置換の位置を読み違えやすい（段2の評価）。そこで、まずページ全体から図の四角だけを答えさせ、
// その四角で PDF を切り出し直してから、今の「画像から作る」に送る。四角は画面に先に描き、利用者が確かめて直せるようにする

import type { JsonSchema, LlmError, LlmImage, LlmProvider, LlmUsage, ThinkingLevel } from './types';

/** 見つけた図。位置はページに対する割合（0〜1、左上が原点） */
export interface FoundFigure {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 図の見出し（「Scheme 1」など。無ければ空） */
  label: string;
  kind: 'reaction-scheme' | 'structure' | 'other';
}

/** Gemini の位置の答えの決まり（box_2d は [ymin, xmin, ymax, xmax]、0〜1000） */
export const FIGURE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    figures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          box_2d: { type: 'array', items: { type: 'integer' }, description: '[ymin, xmin, ymax, xmax] normalized to 0-1000' },
          label: { type: 'string', description: 'The caption label such as "Scheme 1" or "Figure 2", or empty' },
          kind: { type: 'string', enum: ['reaction-scheme', 'structure', 'other'] },
        },
        required: ['box_2d', 'kind'],
      },
    },
  },
  required: ['figures'],
};

export const FIGURE_SYSTEM_PROMPT = `You locate figures on a page of a chemistry paper.
Return every figure on the page as a bounding box "box_2d" = [ymin, xmin, ymax, xmax], normalized to 0-1000.
- kind "reaction-scheme": chemical structures connected by reaction arrows (with reagents and conditions). "structure": structures without arrows. "other": plots, photos, tables, anything else.
- The box must contain the whole figure: every structure, arrow, compound number and condition text that belongs to it. Do not cut any of it off. Do not include the caption paragraph or the body text.
- "label" is the caption label (e.g. "Scheme 1") if one is printed next to the figure; otherwise empty.
- If there is no figure, return an empty list.`;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 答えの形を確かめて、割合の四角にする。おかしい四角は捨てる。上から順に並べる */
export function parseFigures(value: unknown): FoundFigure[] {
  const list = (value as { figures?: unknown })?.figures;
  if (!Array.isArray(list)) return [];
  const out: FoundFigure[] = [];
  for (const f of list) {
    const b = (f as { box_2d?: unknown })?.box_2d;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const [y0, x0, y1, x1] = (b as number[]).map((v) => clamp01(v / 1000));
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    if (width < 0.01 || height < 0.01) continue;
    const kind = (f as { kind?: unknown }).kind;
    const label = (f as { label?: unknown }).label;
    out.push({ x, y, width, height, label: typeof label === 'string' ? label.trim() : '', kind: kind === 'reaction-scheme' || kind === 'structure' ? kind : 'other' });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 割合の四角を PDF の座標（倍率 1）にし、図を切らないように pad（PDF の単位）だけ広げる */
export function figureToCrop(f: FoundFigure, page: { width: number; height: number }, pad = 6): { x: number; y: number; width: number; height: number } {
  const x0 = Math.max(0, f.x * page.width - pad);
  const y0 = Math.max(0, f.y * page.height - pad);
  const x1 = Math.min(page.width, (f.x + f.width) * page.width + pad);
  const y1 = Math.min(page.height, (f.y + f.height) * page.height + pad);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** ページの画像から図の位置を答えさせる */
export async function findFigures(
  llm: LlmProvider,
  req: { image: LlmImage; thinking?: ThinkingLevel; signal?: AbortSignal },
): Promise<{ ok: true; figures: FoundFigure[]; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage }> {
  const r = await llm.generateJson<unknown>({
    system: FIGURE_SYSTEM_PROMPT,
    user: 'Locate the figures on this page.',
    images: [req.image],
    schema: FIGURE_SCHEMA,
    thinking: req.thinking ?? 'low',
    signal: req.signal,
  });
  if (!r.ok) return r;
  return { ok: true, figures: parseFigures(r.value), usage: r.usage };
}

// 記録した本物の答え（各 *.eval.ts を RECORD=1 で回したもの）を流し直すテストの共通部品
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { LlmProvider, LlmResult } from '../../src/llm/types';
import type { Outcome } from './score';

/** 記録した答えを、順に返す偽の LLM。seen を渡すと、送られた画像を呼ばれた順に入れる */
export function replayLlm(answers: unknown[], seen?: unknown[]): LlmProvider {
  const queue = [...answers];
  return {
    id: 'gemini',
    generateJson: async <T,>(req: { images?: unknown[] }): Promise<LlmResult<T>> => {
      seen?.push(req.images);
      const a = queue.shift() as { error?: { kind: string; message: string } } | undefined;
      return a && typeof a === 'object' && 'error' in a && a.error ? ({ ok: false, error: a.error } as LlmResult<T>) : { ok: true, value: a as T };
    },
    listModels: async () => ({ ok: true, value: [] }),
  };
}

/** 記録のファイル 1 本（outcomes: 記録したときの採点、raw: 件ごとの答えの並び） */
export interface Recorded {
  file: string;
  outcomes: Record<string, Outcome>;
  raw: Record<string, unknown[]>;
}

/** 記録のディレクトリにある JSON をすべて読む */
export function recordedFiles(dir: string): Recorded[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, ...(JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Omit<Recorded, 'file'>) }));
}

/**
 * 記録した件をすべて流し直し、採点が記録と違った件を「件: 記録 → 今」の並びで返す（全部同じなら空）。
 * 件ごとに 1 つのテストにすると数が膨らむので、記録のファイルごとに 1 つのテストにまとめ、違った件は名前で並べる。
 * score が undefined を返した件（評価の件から消えたもの）は飛ばす
 */
export async function changedOutcomes(rec: Recorded, score: (id: string, answers: unknown[]) => Promise<Outcome | undefined>): Promise<string[]> {
  const out: string[] = [];
  for (const id of Object.keys(rec.raw)) {
    const got = await score(id, rec.raw[id]);
    if (got !== undefined && got !== rec.outcomes[id]) out.push(`${id}: 記録 ${rec.outcomes[id]} → 今 ${got}`);
  }
  return out;
}

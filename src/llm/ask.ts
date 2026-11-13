// 決まった形の JSON を返させ、形が崩れていたら理由を付けて1回だけ直させる（言葉からスキームと言葉での編集で共通）
import { addUsage, type JsonSchema, type LlmError, type LlmImage, type LlmProvider, type LlmResult, type LlmUsage, type ThinkingLevel } from './types';

/** usage は、直させた呼び出しも含めた合計（失敗でも、答えが届いた分はある） */
export type AskResult<T> = { ok: true; value: T; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage };

export async function askChecked<T>(
  llm: LlmProvider,
  req: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; thinking?: ThinkingLevel; signal?: AbortSignal },
  check: (raw: unknown) => { value: T } | { error: string },
): Promise<AskResult<T>> {
  const ask = (u: string): Promise<LlmResult<unknown>> => llm.generateJson<unknown>({ system: req.system, user: u, images: req.images, schema: req.schema, thinking: req.thinking, signal: req.signal });
  let r = await ask(req.user);
  let usage = r.usage;
  let shape = r.ok ? check(r.value) : null;
  if ((r.ok && shape && 'error' in shape) || (!r.ok && r.error.kind === 'invalid-output')) {
    const why = shape && 'error' in shape ? shape.error : !r.ok ? r.error.message : '';
    r = await ask(`${req.user}\n\nYour previous answer could not be used (${why}). Return valid JSON that follows the schema.`);
    usage = addUsage(usage, r.usage);
    shape = r.ok ? check(r.value) : null;
  }
  if (!r.ok) return { ok: false, error: r.error, usage };
  if (!shape || 'error' in shape) return { ok: false, error: { kind: 'invalid-output', message: shape && 'error' in shape ? shape.error : 'invalid' }, usage };
  return { ok: true, value: shape.value, usage };
}

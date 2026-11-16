// Amazon Bedrock の実装。ブラウザから Bedrock Runtime の Converse API を直接呼ぶ（利用者の Bedrock の API キーで）
//
// 組み立てと読み取りは bedrockConverse.ts（ブラウザに頼らない）。ここは fetch・時間切れ・やり直しだけ。
// キーはこの送り先にだけ送る。CSP の connect-src で、ほかへは送れないようにしてある（infra/cloudfront.tf）
// 東京のエンドポイントだけを呼ぶ（jp. のモデルの ID は、東京と大阪に振り分けられる）

import { buildConverseBody, classifyBedrockError, parseConverseResponse, type BedrockErrorBody } from './bedrockConverse';
import { PROVIDERS } from './providers';
import type { JsonSchema, LlmImage, LlmProvider, LlmResult, ThinkingLevel } from './types';
import { wait } from './wait';

export const BEDROCK_REGION = 'ap-northeast-1';
export const DEFAULT_BEDROCK_MODEL = PROVIDERS.bedrock.defaultModel;
/** 一覧に無いモデルの ID のときの、答えの長さの上限 */
export const BEDROCK_DEFAULT_MAX_TOKENS = 16000;

export const BEDROCK_TIMEOUT_MS = 180_000;
/** 混んでいるとき（503・ModelNotReady）に待ってからやり直す間（ミリ秒） */
export const BEDROCK_RETRY_DELAYS_MS = [2_000, 6_000];

export function bedrockEndpoint(region = BEDROCK_REGION): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export function createBedrock({
  apiKey,
  model,
  region = BEDROCK_REGION,
  fetch: f = (...a) => fetch(...a),
  timeoutMs = BEDROCK_TIMEOUT_MS,
  retryDelaysMs = BEDROCK_RETRY_DELAYS_MS,
}: {
  apiKey: string;
  model: string;
  region?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}): LlmProvider {
  const maxTokens = PROVIDERS.bedrock.models.find((m) => m.id === model)?.maxTokens ?? BEDROCK_DEFAULT_MAX_TOKENS;
  const url = `${bedrockEndpoint(region)}/model/${encodeURIComponent(model)}/converse`;
  const timeoutText = `${Math.round(timeoutMs / 1000)} 秒たっても答えが無い`;

  /** 1 回だけ送る。待つ上限を過ぎたら止めて timeout にする（利用者の「やめる」とは分ける） */
  async function once(body: string, signal?: AbortSignal): Promise<{ result: LlmResult<unknown>; busy?: boolean }> {
    if (signal?.aborted) return { result: { ok: false, error: { kind: 'aborted', message: 'aborted' } } };
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await f(url, { method: 'POST', body, signal: ctrl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` } });
      } catch (e) {
        if (timedOut) return { result: { ok: false, error: { kind: 'timeout', message: timeoutText } } };
        if ((e as Error)?.name === 'AbortError') return { result: { ok: false, error: { kind: 'aborted', message: 'aborted' } } };
        return { result: { ok: false, error: { kind: 'network', message: String(e) } } };
      }
      const json = (await res.json().catch(() => null)) as unknown;
      if (timedOut) return { result: { ok: false, error: { kind: 'timeout', message: timeoutText } } };
      if (!res.ok) {
        const c = classifyBedrockError(res.status, json as BedrockErrorBody, res.headers.get('x-amzn-errortype'));
        return { result: { ok: false, error: c.error }, busy: c.busy };
      }
      return { result: parseConverseResponse(json) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    id: 'bedrock',

    async generateJson<T>({ system, user, images, schema, signal }: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<LlmResult<T>> {
      const body = JSON.stringify(buildConverseBody({ system, user, images, schema, maxTokens }));
      for (let i = 0; ; i++) {
        const { result, busy } = await once(body, signal);
        if (!busy || i >= retryDelaysMs.length) return result as LlmResult<T>;
        if (!(await wait(retryDelaysMs[i], signal))) return { ok: false, error: { kind: 'aborted', message: 'aborted' } };
      }
    },
  };
}

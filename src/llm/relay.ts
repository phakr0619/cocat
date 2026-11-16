// この組織の AI の中継（server/ai-relay）の呼び出し。同じドメインの /api/ai に POST する。キーは持たない
//
// CloudFront から Lambda へは署名して渡すので、本文の SHA-256 を x-amz-content-sha256 に添える（opsin.ts と同じ）。
// 答えは、空白（接続を保つための）に続く 1 つの JSON（LlmResult）。中継が無いサイトでは index.html が返るので、JSON でなければ「つながらない」とする

import { sha256Hex } from '../chem/opsin';
import { providerInfo } from './providers';
import type { JsonSchema, LlmError, LlmErrorKind, LlmImage, LlmModel, LlmProvider, LlmResult, ThinkingLevel } from './types';

export const RELAY_PATH = '/api/ai';
export const RELAY_TIMEOUT_MS = 180_000;

const KINDS: LlmErrorKind[] = ['auth', 'rate', 'quota', 'network', 'timeout', 'server', 'invalid-output', 'refused', 'aborted', 'model', 'too-large'];

/** 中継が見つかったときの情報 */
export type RelayInfo = { region: string; models: LlmModel[] };

const aborted = (): LlmResult<never> => ({ ok: false, error: { kind: 'aborted', message: 'aborted' } });
const netErr = (message: string): LlmResult<never> => ({ ok: false, error: { kind: 'network', message } });

/** 届いた JSON が LlmResult の形か確かめる */
function asResult(raw: unknown): LlmResult<unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { ok?: unknown; value?: unknown; error?: { kind?: unknown; message?: unknown }; usage?: LlmResult<unknown>['usage'] };
  if (r.ok === true && 'value' in r) return { ok: true, value: r.value, usage: r.usage };
  if (r.ok === false && r.error && KINDS.includes(r.error.kind as LlmErrorKind)) {
    const error: LlmError = { kind: r.error.kind as LlmErrorKind, message: typeof r.error.message === 'string' ? r.error.message : '' };
    return { ok: false, error, usage: r.usage };
  }
  return null;
}

export function createRelay({ model, fetch: f = (...a) => fetch(...a), timeoutMs = RELAY_TIMEOUT_MS }: { model: string; fetch?: typeof fetch; timeoutMs?: number }): LlmProvider {
  const timeoutText = `${Math.round(timeoutMs / 1000)} 秒たっても答えが無い`;
  return {
    id: 'relay',

    async generateJson<T>({ system, user, images, schema, signal }: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<LlmResult<T>> {
      if (signal?.aborted) return aborted();
      const body = JSON.stringify({ model, system, user, ...(images?.length ? { images } : {}), schema });
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let text: string;
        try {
          const res = await f(RELAY_PATH, { method: 'POST', body, signal: ctrl.signal, headers: { 'content-type': 'application/json', 'x-amz-content-sha256': await sha256Hex(body) } });
          text = (await res.text()).trim();
        } catch (e) {
          if (timedOut) return { ok: false, error: { kind: 'timeout', message: timeoutText } };
          if ((e as Error)?.name === 'AbortError') return aborted();
          return netErr(String(e));
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          // 中継が無い・署名が通らないときは、index.html などが返る
          return netErr('中継から JSON でない答えが返りました');
        }
        return (asResult(json) ?? netErr('中継の答えの形が違います')) as LlmResult<T>;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** このサイトに中継があるか。GET /api/ai が { provider, models } の JSON を返せばある。どんな失敗でも「無い」とし、何も表示しない。AI を呼ばないので費用はかからない */
export async function discoverRelay(f: typeof fetch = (...a) => fetch(...a)): Promise<RelayInfo | null> {
  try {
    const res = await f(RELAY_PATH, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const j = JSON.parse((await res.text()).trim()) as { provider?: unknown; region?: unknown; models?: unknown };
    if (typeof j.provider !== 'string' || !Array.isArray(j.models)) return null;
    const ids = j.models.filter((m): m is string => typeof m === 'string' && !!m);
    if (!ids.length) return null;
    const names = new Map(providerInfo('bedrock').models.map((m) => [m.id, m.name]));
    return { region: typeof j.region === 'string' ? j.region : '', models: ids.map((id) => ({ id, name: names.get(id) ?? id })) };
  } catch {
    return null;
  }
}

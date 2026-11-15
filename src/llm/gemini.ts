// Gemini（Google）の実装。ブラウザから Gemini の REST API を直接呼ぶ（利用者のキーで）
//
// 公式の JS の SDK（@google/genai）はブラウザ用だけで約 1.1 MB あるので使わず、
// SDK が送るのと同じ形（v1beta の generateContent・x-goog-api-key のヘッダー）で fetch する。
// Google は新しく作るなら Interactions API を勧めているが、generateContent も引き続き使える（2026-10-24 に公式の資料で確認）。
// Interactions API は既定で会話を Google の側に保存する（store=true）ので、1回で終わる呼び出しには、何も残さない generateContent を使う。
// キーはこの API にだけ送る。CSP の connect-src で、ほかへは送れないようにしてある（infra/cloudfront.tf）

import { PROVIDERS } from './providers';
import { wait } from './wait';
import type { JsonSchema, LlmError, LlmImage, LlmModel, LlmProvider, LlmResult, ThinkingLevel } from './types';

export const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/** 既定のモデル。値は接続の型の一覧（providers.ts）にある。設定画面で、キーで引いたモデルの一覧から選び直せる */
export const DEFAULT_GEMINI_MODEL = PROVIDERS.gemini.defaultModel;

type GeminiError = { error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] } };
type GeminiPart = { text?: string; thought?: boolean };
type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

/** 設定画面で選べるモデル（接続の型の一覧 providers.ts の値の別名） */
export const GEMINI_MODELS = PROVIDERS.gemini.models;

/** 文章を返すモデルか（音声・画像・リアルタイム・埋め込みなどの専用のモデルは除く。一覧は generateContent に対応していても、言葉からスキームには使えない） */
export function isTextModel(id: string): boolean {
  return /^gemini-/.test(id) && !/(tts|image|live|audio|transcribe|translate|embedding|computer-use|robotics|banana|omni|aqa)/.test(id);
}

const REFUSED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY']);

/** HTTP の失敗を、利用者に言える理由に分ける */
export function geminiError(status: number, body: GeminiError | null): LlmError {
  const message = body?.error?.message ?? `HTTP ${status}`;
  const reasons = body?.error?.details?.map((d) => d.reason) ?? [];
  if (status === 401 || status === 403 || reasons.includes('API_KEY_INVALID') || /api key/i.test(message)) return { kind: 'auth', message };
  // 402: 前払いのクレジットが尽きた（請求先の残高が無い）
  if (status === 402) return { kind: 'quota', message };
  if (status === 429) return { kind: /per ?day|billing/i.test(message) ? 'quota' : 'rate', message };
  if (status >= 500) return { kind: 'server', message };
  return { kind: 'invalid-output', message };
}

/** 1 回の呼び出しを待つ上限。low でも 40〜80 秒かかることがある（2026-10-24 に本物で測った）ので、その倍ほどにする */
export const GEMINI_TIMEOUT_MS = 180_000;
/** 503（混んでいる）のときに待ってからやり直す間（ミリ秒）。この数だけやり直す */
export const GEMINI_RETRY_DELAYS_MS = [2_000, 6_000];

export function createGemini({
  apiKey,
  model,
  fetch: f = (...a) => fetch(...a),
  timeoutMs = GEMINI_TIMEOUT_MS,
  retryDelaysMs = GEMINI_RETRY_DELAYS_MS,
}: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}): LlmProvider {
  /** 1 回だけ送る。待つ上限を過ぎたら止めて timeout にする（利用者の「やめる」とは分ける） */
  async function once<R>(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ result: LlmResult<R>; busy?: boolean }> {
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
        res = await f(`${GEMINI_API}/${path}`, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey } });
      } catch (e) {
        if (timedOut) return { result: { ok: false, error: { kind: 'timeout', message: `${Math.round(timeoutMs / 1000)} 秒たっても答えが無い` } } };
        if ((e as Error)?.name === 'AbortError') return { result: { ok: false, error: { kind: 'aborted', message: 'aborted' } } };
        return { result: { ok: false, error: { kind: 'network', message: String(e) } } };
      }
      const body = (await res.json().catch(() => null)) as R | GeminiError | null;
      if (timedOut) return { result: { ok: false, error: { kind: 'timeout', message: `${Math.round(timeoutMs / 1000)} 秒たっても答えが無い` } } };
      if (!res.ok) return { result: { ok: false, error: geminiError(res.status, body as GeminiError | null) }, busy: res.status === 503 };
      return { result: { ok: true, value: body as R } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 503（モデルが混んでいる）は、少し待ってからやり直す。ほかの失敗はそのまま返す */
  async function call<R>(path: string, init: RequestInit, signal?: AbortSignal): Promise<LlmResult<R>> {
    for (let i = 0; ; i++) {
      const { result, busy } = await once<R>(path, init, signal);
      if (!busy || i >= retryDelaysMs.length) return result;
      if (!(await wait(retryDelaysMs[i], signal))) return { ok: false, error: { kind: 'aborted', message: 'aborted' } };
    }
  }

  return {
    id: 'gemini',

    async generateJson<T>({ system, user, images, schema, thinking, signal }: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<LlmResult<T>> {
      const r = await call<GeminiResponse>(
        `models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            // 画像は文章の後に置く（公式の例の順）。REST の generateContent の形（inline_data・mime_type）で送る。
            // Files API は Google の側にファイルが残るので使わない。リクエスト全体で 20 MB まで（2026-10-25 に ai.google.dev の Image understanding で確認）
            contents: [{ role: 'user', parts: [{ text: user }, ...(images ?? []).map((i) => ({ inline_data: { mime_type: i.mimeType, data: i.data } }))] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseJsonSchema: schema,
              // 考える深さ（無ければモデルの既定。Flash・Argon は medium）
              ...(thinking ? { thinkingConfig: { thinkingLevel: thinking.toUpperCase() } } : {}),
            },
          }),
        },
        signal,
      );
      if (!r.ok) return r;
      const res = r.value;
      // 考えた分（thoughtsTokenCount）は candidatesTokenCount に入らないが、出力として請求されるので足す
      const m = res.usageMetadata;
      const usage = m && { input: m.promptTokenCount ?? 0, output: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0), thinking: m.thoughtsTokenCount ?? 0 };
      if (res.promptFeedback?.blockReason) return { ok: false, error: { kind: 'refused', message: res.promptFeedback.blockReason }, usage };
      const c = res.candidates?.[0];
      if (!c) return { ok: false, error: { kind: 'invalid-output', message: '答えが空' }, usage };
      if (c.finishReason && REFUSED.has(c.finishReason)) return { ok: false, error: { kind: 'refused', message: c.finishReason }, usage };
      if (c.finishReason === 'MAX_TOKENS') return { ok: false, error: { kind: 'invalid-output', message: '答えが長すぎて途中で切れた' }, usage };
      // 考えた過程（thought）の部分は除く
      const text = (c.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
      try {
        return { ok: true, value: JSON.parse(text) as T, usage };
      } catch {
        return { ok: false, error: { kind: 'invalid-output', message: `JSON でない: ${text.slice(0, 80)}` }, usage };
      }
    },

    async listModels(signal?: AbortSignal): Promise<LlmResult<LlmModel[]>> {
      const r = await call<{ models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] }>('models?pageSize=1000', { method: 'GET' }, signal);
      if (!r.ok) return r;
      const models = (r.value.models ?? [])
        .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName ?? m.name, methods: m.supportedGenerationMethods ?? [] }))
        .filter((m) => m.methods.includes('generateContent') && isTextModel(m.id))
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, value: models };
    },
  };
}

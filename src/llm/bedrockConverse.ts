// Amazon Bedrock の Converse API の、リクエストの組み立てと応答の読み取り
//
// ブラウザにも fetch にも頼らない（型の import だけ）。ブラウザの呼び出し（bedrock.ts）と、
// あとで足す Node（Lambda）の中継が、同じこの部品を使う

import type { JsonSchema, LlmError, LlmImage, LlmResult, LlmUsage } from './types';

/** 答えを受け取る道具の名前。toolChoice で、この道具を必ず呼ばせる（答えは toolUse.input に入る） */
export const ANSWER_TOOL = 'answer';

/** 画像の形式。Converse が受けるのは png・jpeg・gif・webp */
export function converseImageFormat(mimeType: string): string {
  const sub = mimeType.replace(/^image\//, '').toLowerCase();
  return sub === 'jpg' ? 'jpeg' : sub;
}

/** Converse のリクエストの本文。画像は文章の前に置く（Anthropic の勧める順）。考える設定は付けない（道具の強制と、拡張した思考は同時に使えない） */
export function buildConverseBody({ system, user, images, schema, maxTokens }: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; maxTokens: number }) {
  return {
    system: [{ text: system }],
    messages: [
      {
        role: 'user',
        content: [...(images ?? []).map((i) => ({ image: { format: converseImageFormat(i.mimeType), source: { bytes: i.data } } })), { text: user }],
      },
    ],
    inferenceConfig: { maxTokens },
    toolConfig: {
      tools: [{ toolSpec: { name: ANSWER_TOOL, description: 'Return the answer as the tool input. It must follow the schema.', inputSchema: { json: schema } } }],
      toolChoice: { tool: { name: ANSWER_TOOL } },
    },
  };
}

type ConverseResponse = {
  output?: { message?: { content?: { text?: string; toolUse?: { name?: string; input?: unknown } }[] } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** 応答を読む。答えは toolUse.input */
export function parseConverseResponse(json: unknown): LlmResult<unknown> {
  const res = (json && typeof json === 'object' ? json : {}) as ConverseResponse;
  const u = res.usage;
  const usage: LlmUsage | undefined = u && { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 };
  const fail = (kind: LlmError['kind'], message: string): LlmResult<unknown> => ({ ok: false, error: { kind, message }, usage });
  const stop = res.stopReason;
  if (stop === 'max_tokens') return fail('invalid-output', '答えが長すぎて途中で切れた');
  if (stop === 'guardrail_intervened' || stop === 'content_filtered') return fail('refused', stop);
  if (stop === 'malformed_model_output' || stop === 'malformed_tool_use') return fail('invalid-output', stop);
  const tool = (res.output?.message?.content ?? []).find((c) => c.toolUse);
  if (!tool?.toolUse || tool.toolUse.input === undefined) return fail('invalid-output', '答えが空');
  return { ok: true, value: tool.toolUse.input, usage };
}

export type BedrockErrorBody = { message?: string; Message?: string; __type?: string } | null;

/** 失敗の名前（x-amzn-errortype のヘッダーか、本文の __type）。「com.amazon…#Name」「Name:http://…」のどちらも Name にする */
function errorName(body: BedrockErrorBody, header?: string | null): string {
  const raw = header || body?.__type || '';
  return raw.replace(/^.*#/, '').replace(/:.*$/, '');
}

const MODEL_PROBLEM = /model identifier|inference profile|model ?id|model.*(not found|invalid|not supported|isn't supported|does not exist|doesn't exist)|(invalid|unknown|unsupported).*model/i;
const MODEL_ACCESS = /not available for this account|use case details|model access/i;
const QUOTA_WORDS = /quota|per day|tokens per/i;

/** 失敗を、利用者に言える理由に分ける。混んでいてやり直す価値のあるもの（busy）も返す */
export function classifyBedrockError(status: number, body: BedrockErrorBody, errType?: string | null): { error: LlmError; busy: boolean } {
  const message = body?.message ?? body?.Message ?? `HTTP ${status}`;
  const name = errorName(body, errType);
  const out = (kind: LlmError['kind'], busy = false) => ({ error: { kind, message }, busy });
  if (name === 'ModelNotReadyException') return out('server', true);
  if (name === 'ServiceQuotaExceededException') return out('quota');
  // アカウントでそのモデルを使えない（ユースケースの書式がまだ・アカウントに出していないモデル）。キーの誤りと分ける（2026-11-15 に本物の文で確認）
  if ((name === 'AccessDeniedException' || status === 403) && MODEL_ACCESS.test(message)) return out('model');
  if (name === 'AccessDeniedException' || name === 'UnrecognizedClientException' || status === 401 || status === 403) return out('auth');
  if (name === 'ResourceNotFoundException' || status === 404) return out('model');
  if (name === 'ThrottlingException' || status === 429) return out(QUOTA_WORDS.test(message) ? 'quota' : 'rate');
  if (name === 'ModelTimeoutException' || status === 408) return out('timeout');
  if (name === 'ServiceUnavailableException' || status === 503) return out('server', true);
  if (name === 'ModelErrorException' || name === 'InternalServerException' || status >= 500 || status === 424) return out('server');
  if (status === 402) return out('quota');
  if (name === 'ValidationException' || status === 400) return out(MODEL_PROBLEM.test(message) ? 'model' : 'invalid-output');
  return out('invalid-output');
}

export function bedrockError(status: number, body: BedrockErrorBody, errType?: string | null): LlmError {
  return classifyBedrockError(status, body, errType).error;
}

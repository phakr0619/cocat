import { describe, expect, it, vi } from 'vitest';
import { createBedrock } from '../src/llm/bedrock';
import { bedrockError, buildConverseBody, parseConverseResponse } from '../src/llm/bedrockConverse';
import { PROVIDERS } from '../src/llm/providers';
import { testConnection } from '../src/llm/testConnection';
import { llmErrorText } from '../src/llm/types';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
const ok = (input: unknown = { a: 1 }, extra: object = {}) => ({
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't', name: 'answer', input } }] } },
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 3 },
  ...extra,
});
const MODEL = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';
const URL_ = `https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`;

describe('Bedrock の呼び出し', () => {
  it('Converse に、キーを Bearer で、画像を文章の前に、答えの道具を強制して送る。考える設定は付けない', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => json(200, ok()));
    const b = createBedrock({ apiKey: 'KEY', model: MODEL, fetch: f as typeof fetch });
    const r = await b.generateJson<{ a: number }>({ system: 'sys', user: 'hello', images: [{ mimeType: 'image/png', data: 'AAAA' }, { mimeType: 'image/jpeg', data: 'BBBB' }], schema, thinking: 'high' });
    expect(r).toEqual({ ok: true, value: { a: 1 }, usage: { input: 10, output: 3 } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_);
    expect(url).toContain('jp.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer KEY' });
    expect(String(url)).not.toContain('KEY');
    const body = JSON.parse(String(init!.body));
    expect(body).toEqual({
      system: [{ text: 'sys' }],
      messages: [
        {
          role: 'user',
          content: [{ image: { format: 'png', source: { bytes: 'AAAA' } } }, { image: { format: 'jpeg', source: { bytes: 'BBBB' } } }, { text: 'hello' }],
        },
      ],
      inferenceConfig: { maxTokens: 16000 },
      toolConfig: {
        tools: [{ toolSpec: { name: 'answer', description: 'Return the answer as the tool input. It must follow the schema.', inputSchema: { json: schema } } }],
        toolChoice: { tool: { name: 'answer' } },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/thinking/i);
  });

  it('モデルの ID は URL 用にエンコードし、一覧に無いモデルは既定の長さの上限', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => json(200, ok()));
    await createBedrock({ apiKey: 'K', model: 'arn:aws:bedrock:x/y', fetch: f as typeof fetch }).generateJson({ system: '', user: '', schema });
    expect(f.mock.calls[0][0]).toContain('/model/arn%3Aaws%3Abedrock%3Ax%2Fy/converse');
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).inferenceConfig.maxTokens).toBe(16000);
  });

  it('画像の形式（webp・jpg）を Converse の形式に直す', () => {
    const b = buildConverseBody({ system: '', user: 'u', images: [{ mimeType: 'image/webp', data: 'x' }, { mimeType: 'image/jpg', data: 'y' }], schema, maxTokens: 5 });
    expect(b.messages[0].content.map((c) => ('image' in c ? c.image.format : 'text'))).toEqual(['webp', 'jpeg', 'text']);
  });

  it('応答: toolUse の入力が答え。stopReason ごとに失敗を分け、使用量も付ける', () => {
    expect(parseConverseResponse(ok({ a: 2 }))).toEqual({ ok: true, value: { a: 2 }, usage: { input: 10, output: 3 } });
    // 文章と道具が混ざっていても、道具の入力を取る
    const mixed = { output: { message: { content: [{ text: '考え中' }, { toolUse: { name: 'answer', input: { a: 3 } } }] } }, stopReason: 'tool_use' };
    expect(parseConverseResponse(mixed)).toMatchObject({ ok: true, value: { a: 3 } });
    const u = { usage: { inputTokens: 7, outputTokens: 9 } };
    expect(parseConverseResponse({ ...ok(), stopReason: 'max_tokens', ...u })).toEqual({ ok: false, error: { kind: 'invalid-output', message: '答えが長すぎて途中で切れた' }, usage: { input: 7, output: 9 } });
    expect(parseConverseResponse({ ...ok(), stopReason: 'guardrail_intervened', ...u })).toMatchObject({ ok: false, error: { kind: 'refused' }, usage: { input: 7, output: 9 } });
    expect(parseConverseResponse({ ...ok(), stopReason: 'content_filtered' })).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(parseConverseResponse({ ...ok(), stopReason: 'malformed_model_output' })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    expect(parseConverseResponse({ ...ok(), stopReason: 'malformed_tool_use' })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    expect(parseConverseResponse({ output: { message: { content: [{ text: 'x' }] } }, stopReason: 'end_turn' })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    expect(parseConverseResponse(null)).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
  });

  it('HTTP の失敗を理由に分ける', () => {
    const k = (status: number, message: string, type?: string, header?: string) => bedrockError(status, { message, __type: type }, header).kind;
    expect(k(403, 'denied', 'AccessDeniedException')).toBe('auth');
    expect(k(401, 'x')).toBe('auth');
    // アカウントでそのモデルを使えないときは、キーの誤りでなくモデルの問題（2026-11-15 に本物で返った文）
    expect(k(403, 'anthropic.claude-haiku-5-5 is not available for this account. You can explore other available models on Amazon Bedrock.', 'AccessDeniedException')).toBe('model');
    expect(k(400, 'The provided model identifier is invalid.', 'ValidationException')).toBe('model');
    expect(k(403, 'Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model.', 'AccessDeniedException')).toBe('model');
    expect(k(404, 'not found', 'ResourceNotFoundException')).toBe('model');
    expect(k(400, 'The provided model identifier is invalid.', 'ValidationException')).toBe('model');
    expect(k(400, 'Invalid inference profile', 'ValidationException')).toBe('model');
    expect(k(400, 'Malformed input request: extraneous key', 'ValidationException')).toBe('invalid-output');
    expect(k(429, 'Too many requests, please wait', 'ThrottlingException')).toBe('rate');
    expect(k(429, 'Too many tokens per day', 'ThrottlingException')).toBe('quota');
    expect(k(429, 'Quota exceeded', 'ThrottlingException')).toBe('quota');
    expect(k(400, 'x', 'ServiceQuotaExceededException')).toBe('quota');
    expect(k(402, 'x', 'ServiceQuotaExceededException')).toBe('quota');
    expect(k(429, 'not ready', 'ModelNotReadyException')).toBe('server');
    expect(k(408, 'x', 'ModelTimeoutException')).toBe('timeout');
    expect(k(424, 'x', 'ModelErrorException')).toBe('server');
    expect(k(500, 'x', 'InternalServerException')).toBe('server');
    expect(k(503, 'x', 'ServiceUnavailableException')).toBe('server');
    // 名前はヘッダーの x-amzn-errortype でもよい（「:http://…」が付くことがある）
    expect(k(403, 'x', undefined, 'AccessDeniedException:http://internal.amazon.com/')).toBe('auth');
    expect(k(400, 'x', 'com.amazon.bedrock#ValidationException')).toBe('invalid-output');
    expect(llmErrorText({ kind: 'model', message: '' }, { provider: 'bedrock', paidKey: false })).toBe(PROVIDERS.bedrock.errors.model);
    expect(llmErrorText({ kind: 'auth', message: '' }, { provider: 'bedrock', paidKey: false })).toContain('12 時間');
    expect(llmErrorText({ kind: 'quota', message: '' }, { provider: 'bedrock', paidKey: false })).toBe(PROVIDERS.bedrock.errors.quota);
  });

  it('失敗の応答は、呼び出しの結果の失敗になる（ヘッダーの名前も読む）', async () => {
    const f = vi.fn(() => json(403, { message: 'no' }, { 'x-amzn-errortype': 'AccessDeniedException' }));
    expect(await createBedrock({ apiKey: 'K', model: MODEL, fetch: f as typeof fetch }).generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'auth' } });
  });

  it('503 と ModelNotReady は待ってからやり直す。数を超えたら server。ほかの失敗はやり直さない', async () => {
    const f = vi.fn().mockImplementationOnce(() => json(503, { message: 'busy' })).mockImplementationOnce(() => json(429, { message: 'warming', __type: 'ModelNotReadyException' })).mockImplementationOnce(() => json(200, ok()));
    const g = createBedrock({ apiKey: 'K', model: MODEL, fetch: f as typeof fetch, retryDelaysMs: [1, 1] });
    expect(await g.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: true, value: { a: 1 } });
    expect(f).toHaveBeenCalledTimes(3);

    const always = vi.fn(() => json(503, { message: 'busy' }));
    const g2 = createBedrock({ apiKey: 'K', model: MODEL, fetch: always as typeof fetch, retryDelaysMs: [1, 1] });
    expect(await g2.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'server' } });
    expect(always).toHaveBeenCalledTimes(3);

    for (const status of [500, 429, 403]) {
      const h = vi.fn(() => json(status, { message: 'x' }));
      await createBedrock({ apiKey: 'K', model: MODEL, fetch: h as typeof fetch, retryDelaysMs: [1, 1] }).generateJson({ system: '', user: '', schema });
      expect(h).toHaveBeenCalledTimes(1);
    }
  });

  it('つながらない・やめた・時間切れを分ける', async () => {
    const net = createBedrock({ apiKey: 'K', model: MODEL, fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    expect(await net.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'network' } });
    const abort = createBedrock({ apiKey: 'K', model: MODEL, fetch: (() => Promise.reject(new DOMException('x', 'AbortError'))) as typeof fetch });
    expect(await abort.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    const pre = new AbortController();
    pre.abort();
    const never = vi.fn();
    expect(await createBedrock({ apiKey: 'K', model: MODEL, fetch: never as unknown as typeof fetch }).generateJson({ system: '', user: '', schema, signal: pre.signal })).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(never).not.toHaveBeenCalled();
    // 返事が来ないまま待つ上限を過ぎたら timeout
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))))) as unknown as typeof fetch;
    expect(await createBedrock({ apiKey: 'K', model: MODEL, fetch: hang, timeoutMs: 20 }).generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('やり直しを待つ間に「やめる」を押したら、すぐ aborted で終わる', async () => {
    const f = vi.fn(() => json(503, { message: 'busy' }));
    const ctrl = new AbortController();
    const g = createBedrock({ apiKey: 'K', model: MODEL, fetch: f as typeof fetch, retryDelaysMs: [60_000] });
    const p = g.generateJson({ system: '', user: '', schema, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });

  it('listModels は無い', () => {
    expect(createBedrock({ apiKey: 'K', model: MODEL }).listModels).toBeUndefined();
  });
});

describe('つながるか試す', () => {
  it('一覧を引けない会社は、短い質問を 1 回だけ送る', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => json(200, ok({ ok: true })));
    const r = await testConnection(createBedrock({ apiKey: 'K', model: MODEL, fetch: f as typeof fetch }));
    expect(r).toEqual({ ok: true, modelIds: null });
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).messages[0].content).toEqual([{ text: 'Return {"ok": true}.' }]);
  });
  it('質問の失敗は、理由と一緒に返す', async () => {
    const f = vi.fn(() => json(404, { message: 'x', __type: 'ResourceNotFoundException' }));
    expect(await testConnection(createBedrock({ apiKey: 'K', model: 'nope', fetch: f as typeof fetch }))).toMatchObject({ ok: false, error: { kind: 'model' } });
  });
  it('一覧を引ける会社は、一覧で確かめる（質問は送らない）', async () => {
    const generateJson = vi.fn();
    const r = await testConnection({ id: 'gemini', generateJson, listModels: async () => ({ ok: true, value: [{ id: 'm1', name: 'M1' }] }) });
    expect(r).toEqual({ ok: true, modelIds: ['m1'] });
    expect(generateJson).not.toHaveBeenCalled();
  });
});

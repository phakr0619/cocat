import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGemini, GEMINI_API, geminiError } from '../src/llm/gemini';
import { addUsage, llmErrorText } from '../src/llm/types';

const PAID = { provider: 'gemini', paidKey: true } as const;
const FREE = { provider: 'gemini', paidKey: false } as const;

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };

describe('Gemini の呼び出し', () => {
  it('generateContent に、キーをヘッダーで、応答の形を JSON Schema で渡す', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) =>
      json(200, { candidates: [{ content: { parts: [{ text: '考え中', thought: true }, { text: '{"a":' }, { text: '1}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }),
    );
    const g = createGemini({ apiKey: 'KEY', model: 'gemini-x', fetch: f as typeof fetch });
    const r = await g.generateJson<{ a: number }>({ system: 'sys', user: 'hello', schema });
    expect(r).toEqual({ ok: true, value: { a: 1 }, usage: { input: 10, output: 3, thinking: 0 } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${GEMINI_API}/models/gemini-x:generateContent`);
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY');
    expect(String(url)).not.toContain('KEY');
    expect(JSON.parse(String(init!.body))).toEqual({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
    });
  });

  it('考えた分のトークン（thoughtsTokenCount）は出力に足す。形の崩れた答えにも使用量を付ける（どちらも請求される）', async () => {
    const usageMetadata = { promptTokenCount: 600, candidatesTokenCount: 250, thoughtsTokenCount: 900 };
    const run = (text: string) =>
      createGemini({ apiKey: 'K', model: 'm', fetch: (() => json(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata })) as typeof fetch }).generateJson({ system: '', user: '', schema });
    expect(await run('{"a":1}')).toMatchObject({ ok: true, usage: { input: 600, output: 1150, thinking: 900 } });
    expect(await run('not json')).toMatchObject({ ok: false, error: { kind: 'invalid-output' }, usage: { input: 600, output: 1150, thinking: 900 } });
    expect(addUsage(undefined, { input: 1, output: 2, thinking: 1 }, { input: 3, output: 4 })).toEqual({ input: 4, output: 6, thinking: 1 });
    expect(addUsage(undefined, undefined)).toBeUndefined();
  });

  it('画像は文章の後に inline_data で送る（Files API は使わない）', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => json(200, { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }));
    const g = createGemini({ apiKey: 'K', model: 'm', fetch: f as typeof fetch });
    await g.generateJson({ system: '', user: 'read this', images: [{ mimeType: 'image/png', data: 'iVBOR' }], schema });
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).contents).toEqual([
      { role: 'user', parts: [{ text: 'read this' }, { inline_data: { mime_type: 'image/png', data: 'iVBOR' } }] },
    ]);
  });

  it('考える深さを渡すと thinkingConfig で送る（渡さなければモデルの既定）', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => json(200, { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }));
    const g = createGemini({ apiKey: 'K', model: 'm', fetch: f as typeof fetch });
    await g.generateJson({ system: '', user: '', schema, thinking: 'low' });
    await g.generateJson({ system: '', user: '', schema });
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(JSON.parse(String(f.mock.calls[1][1]!.body)).generationConfig.thinkingConfig).toBeUndefined();
  });

  it('JSON でない・途中で切れた・断られた答えは失敗にする', async () => {
    const run = (body: unknown) => createGemini({ apiKey: 'K', model: 'm', fetch: (() => json(200, body)) as typeof fetch }).generateJson({ system: '', user: '', schema });
    expect(await run({ candidates: [{ content: { parts: [{ text: 'not json' }] }, finishReason: 'STOP' }] })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    expect(await run({ candidates: [{ content: { parts: [{ text: '{"a"' }] }, finishReason: 'MAX_TOKENS' }] })).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    expect(await run({ candidates: [{ finishReason: 'SAFETY' }] })).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(await run({ promptFeedback: { blockReason: 'OTHER' } })).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(await run({})).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
  });

  it('HTTP の失敗を理由に分ける', () => {
    expect(geminiError(400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }).kind).toBe('auth');
    expect(geminiError(403, { error: { message: 'Permission denied' } }).kind).toBe('auth');
    expect(geminiError(429, { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 per minute' } }).kind).toBe('rate');
    expect(geminiError(429, { error: { message: 'Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }).kind).toBe('quota');
    expect(geminiError(402, { error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } }).kind).toBe('quota');
    expect(geminiError(503, { error: { message: 'The model is overloaded.' } }).kind).toBe('server');
    expect(geminiError(400, { error: { message: 'Invalid JSON schema' } }).kind).toBe('invalid-output');
    expect(llmErrorText({ kind: 'auth', message: '' }, PAID)).toContain('キー');
  });

  it('無料のキーなら、時間切れと上限によくあることを添える（有料のキーやほかの失敗には添えない）', () => {
    for (const kind of ['timeout', 'quota'] as const) {
      expect(llmErrorText({ kind, message: '' }, FREE)).toContain('無料のキー');
      expect(llmErrorText({ kind, message: '' }, FREE)).toContain('請求先を付けて');
      expect(llmErrorText({ kind, message: '' }, PAID)).not.toContain('無料のキー');
      expect(llmErrorText({ kind, message: '' }, PAID)).toBe(llmErrorText({ kind, message: '' }, PAID));
    }
    expect(llmErrorText({ kind: 'quota', message: '' }, FREE)).toContain('16〜17 時ごろに戻ります');
    expect(llmErrorText({ kind: 'auth', message: '' }, FREE)).toBe(llmErrorText({ kind: 'auth', message: '' }, PAID));
  });

  it('つながらない・やめたを分ける', async () => {
    const net = createGemini({ apiKey: 'K', model: 'm', fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    expect(await net.listModels()).toMatchObject({ ok: false, error: { kind: 'network' } });
    const abort = createGemini({ apiKey: 'K', model: 'm', fetch: (() => Promise.reject(new DOMException('x', 'AbortError'))) as typeof fetch });
    expect(await abort.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });

  it('503（混んでいる）は、待ってからやり直す。やり直しの数を超えたら server の失敗', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] };
    const busy = { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } };
    const f = vi.fn().mockImplementationOnce(() => json(503, busy)).mockImplementationOnce(() => json(200, ok));
    const g = createGemini({ apiKey: 'K', model: 'm', fetch: f as typeof fetch, retryDelaysMs: [1, 1] });
    expect(await g.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: true, value: { a: 1 } });
    expect(f).toHaveBeenCalledTimes(2);

    const always = vi.fn(() => json(503, busy));
    const g2 = createGemini({ apiKey: 'K', model: 'm', fetch: always as typeof fetch, retryDelaysMs: [1, 1] });
    expect(await g2.generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'server' } });
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('503 のほかの失敗（500・429・キー違い）はやり直さない', async () => {
    for (const status of [500, 429, 401]) {
      const f = vi.fn(() => json(status, { error: { message: 'x' } }));
      await createGemini({ apiKey: 'K', model: 'm', fetch: f as typeof fetch, retryDelaysMs: [1, 1] }).generateJson({ system: '', user: '', schema });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('やり直しを待つ間に「やめる」を押したら、すぐ aborted で終わる', async () => {
    const f = vi.fn(() => json(503, { error: { message: 'overloaded' } }));
    const ctrl = new AbortController();
    const g = createGemini({ apiKey: 'K', model: 'm', fetch: f as typeof fetch, retryDelaysMs: [60_000] });
    const p = g.generateJson({ system: '', user: '', schema, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('待つ上限を過ぎたら止めて timeout にする（「やめる」とは分ける）', async () => {
    // 答えを返さず、止められたら AbortError で終わる fetch
    const hang = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))),
    );
    const g = createGemini({ apiKey: 'K', model: 'm', fetch: hang as unknown as typeof fetch, timeoutMs: 20 });
    const r = await g.generateJson({ system: '', user: '', schema });
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    if (!r.ok) expect(llmErrorText(r.error, PAID)).toContain('時間内');

    const ctrl = new AbortController();
    const g2 = createGemini({ apiKey: 'K', model: 'm', fetch: hang as unknown as typeof fetch, timeoutMs: 60_000 });
    const p = g2.generateJson({ system: '', user: '', schema, signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });

  it('モデルの一覧は、generateContent で使える Gemini だけを返す', async () => {
    const f = (() =>
      json(200, {
        models: [
          { name: 'models/gemini-b-flash', displayName: 'B Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-a-pro', displayName: 'A Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['generateContent'] },
        ],
      })) as typeof fetch;
    const r = await createGemini({ apiKey: 'K', model: 'm', fetch: f }).listModels();
    expect(r).toEqual({ ok: true, value: [{ id: 'gemini-a-pro', name: 'A Pro' }, { id: 'gemini-b-flash', name: 'B Flash' }] });
  });
});

describe('AI の設定', () => {
  let m: Map<string, string>;
  beforeEach(() => {
    m = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    });
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('キーは既定でメモリだけ。覚えるを選んだときだけブラウザに置き、消すとどちらからも消える', async () => {
    const s = await import('../src/llm/settings');
    s.setLlmSettings({ apiKey: ' AIza-1 ' });
    expect(s.getLlmSettings().apiKey).toBe('AIza-1');
    expect([...m.values()].join()).not.toContain('AIza-1');
    s.reloadLlmSettings();
    expect(s.getLlmSettings().apiKey).toBe('');

    expect(s.getLlmSettings().thinking).toBe('low');
    s.setLlmSettings({ apiKey: 'AIza-2', remember: true, model: 'gemini-y', paidKey: true, thinking: 'medium' });
    s.reloadLlmSettings();
    expect(s.getLlmSettings()).toMatchObject({ apiKey: 'AIza-2', remember: true, model: 'gemini-y', paidKey: true, thinking: 'medium' });

    s.forgetLlmKey();
    expect(s.getLlmSettings()).toMatchObject({ apiKey: '', remember: false, model: 'gemini-y' });
    expect([...m.values()].join()).not.toContain('AIza-2');
    expect(s.llmProvider()).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/chem/opsin';
import { createRelay, discoverRelay } from '../src/llm/relay';
import { applyRelay, getLlmSettings, llmProvider, llmReady, providerModels, reloadLlmSettings, setLlmSettings } from '../src/llm/settings';
import { testConnection } from '../src/llm/testConnection';

const res = (text: string, status = 200, type = 'application/json') => Promise.resolve(new Response(text, { status, headers: { 'content-type': type } }));
const schema = { type: 'object' };
const info = { region: 'ap-northeast-1', models: [{ id: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5（速い・安い）' }, { id: 'm2', name: 'm2' }] };

describe('createRelay', () => {
  it('/api/ai に、本文の SHA-256 を添えて POST し、空白に続く JSON を読む', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => res('   \n{"ok":true,"value":{"a":1},"usage":{"input":3,"output":2}}'));
    const r = await createRelay({ model: 'm', fetch: f as typeof fetch }).generateJson({ system: 's', user: 'u', schema, images: [{ mimeType: 'image/png', data: 'AA' }] });
    expect(r).toEqual({ ok: true, value: { a: 1 }, usage: { input: 3, output: 2 } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/ai');
    expect(init!.method).toBe('POST');
    const body = String(init!.body);
    expect(JSON.parse(body)).toEqual({ model: 'm', system: 's', user: 'u', images: [{ mimeType: 'image/png', data: 'AA' }], schema });
    expect(init!.headers).toEqual({ 'content-type': 'application/json', 'x-amz-content-sha256': await sha256Hex(body) });
  });
  it('失敗の JSON はそのまま返す（too-large を含む）', async () => {
    for (const kind of ['rate', 'too-large', 'model']) {
      const r = await createRelay({ model: 'm', fetch: (() => res(` {"ok":false,"error":{"kind":"${kind}","message":"x"}}`, kind === 'too-large' ? 413 : 200)) as typeof fetch }).generateJson({ system: '', user: '', schema });
      expect(r).toEqual({ ok: false, error: { kind, message: 'x' }, usage: undefined });
    }
  });
  it('JSON でない答え（index.html）や形の違う答えは network', async () => {
    for (const text of ['<!doctype html><html></html>', '', '{"hello":1}', '{"ok":false,"error":{"kind":"zzz"}}']) {
      const r = await createRelay({ model: 'm', fetch: (() => res(text, 200, 'text/html')) as typeof fetch }).generateJson({ system: '', user: '', schema });
      expect(r).toMatchObject({ ok: false, error: { kind: 'network' } });
    }
    const r = await createRelay({ model: 'm', fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch }).generateJson({ system: '', user: '', schema });
    expect(r).toMatchObject({ ok: false, error: { kind: 'network' } });
  });
  it('時間切れは timeout、利用者のやめるは aborted', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_, rej) => {
        const stop = () => rej(Object.assign(new Error('a'), { name: 'AbortError' }));
        if (init?.signal?.aborted) stop();
        else init?.signal?.addEventListener('abort', stop);
      })) as typeof fetch;
    expect(await createRelay({ model: 'm', fetch: hang, timeoutMs: 20 }).generateJson({ system: '', user: '', schema })).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    const ctrl = new AbortController();
    const p = createRelay({ model: 'm', fetch: hang, timeoutMs: 5000 }).generateJson({ system: '', user: '', schema, signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });
  it('「つながるか試す」は短い質問を 1 回送る（一覧は引かない）', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => res('{"ok":true,"value":{"ok":true}}'));
    const p = createRelay({ model: 'm', fetch: f as typeof fetch });
    expect(p.listModels).toBeUndefined();
    expect(await testConnection(p)).toEqual({ ok: true, modelIds: null });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('discoverRelay', () => {
  it('provider と models のある JSON なら見つかる。モデルの名前は、知っている ID なら名前を付ける', async () => {
    const f = vi.fn((..._: Parameters<typeof fetch>) => res(JSON.stringify({ provider: 'bedrock', region: 'ap-northeast-1', models: ['jp.anthropic.claude-haiku-4-5-20251001-v1:0', 'x'] })));
    expect(await discoverRelay(f as typeof fetch)).toEqual({ region: 'ap-northeast-1', models: [{ id: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5（速い・安い）' }, { id: 'x', name: 'x' }] });
    expect(f.mock.calls[0][0]).toBe('/api/ai');
    expect(f.mock.calls[0][1]!.method).toBe('GET');
  });
  it('HTML・失敗・ネットワークの失敗・モデルが空は、無いとする', async () => {
    expect(await discoverRelay((() => res('<html></html>', 200, 'text/html')) as typeof fetch)).toBeNull();
    expect(await discoverRelay((() => res('{"provider":"bedrock","models":["a"]}', 500)) as typeof fetch)).toBeNull();
    expect(await discoverRelay((() => res('{"provider":"bedrock","models":[]}')) as typeof fetch)).toBeNull();
    expect(await discoverRelay((() => Promise.reject(new Error('x'))) as typeof fetch)).toBeNull();
  });
});

function fake(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

describe('設定の中継', () => {
  beforeEach(() => {
    (globalThis as { localStorage: Storage }).localStorage = fake();
    reloadLlmSettings();
  });
  it('会社をまだ選んでいない人は、中継が見つかると中継になる。覚えない', () => {
    expect(llmReady()).toBe(false);
    applyRelay(info);
    expect(getLlmSettings()).toMatchObject({ provider: 'relay', model: info.models[0].id, apiKey: '' });
    expect(llmReady()).toBe(true);
    expect(providerModels(getLlmSettings())).toEqual(info.models);
    expect(llmProvider()?.id).toBe('relay');
    // 同意などを保存しても、会社は覚えない（次は中継が無ければ Gemini）
    setLlmSettings({ consented: true });
    expect(JSON.parse(localStorage.getItem('ai-chem-editor:llm') ?? '{}').provider).toBeUndefined();
    reloadLlmSettings();
    expect(getLlmSettings().provider).toBe('gemini');
  });
  it('会社を選んだことのある人は、そのまま。自分のキーに切り替えられる', () => {
    localStorage.setItem('ai-chem-editor:llm', JSON.stringify({ provider: 'gemini' }));
    reloadLlmSettings();
    applyRelay(info);
    expect(getLlmSettings().provider).toBe('gemini');
    expect(llmReady()).toBe(false);
    setLlmSettings({ provider: 'relay' });
    expect(getLlmSettings().provider).toBe('relay');
    setLlmSettings({ provider: 'bedrock' });
    expect(getLlmSettings().provider).toBe('bedrock');
    expect(JSON.parse(localStorage.getItem('ai-chem-editor:llm') ?? '{}').provider).toBe('bedrock');
  });
  it('中継を選んで覚えた人は、次も中継（見つかったとき）。見つからなければ Gemini', () => {
    applyRelay(info);
    setLlmSettings({ provider: 'relay', model: 'm2' });
    reloadLlmSettings();
    expect(getLlmSettings().provider).toBe('gemini');
    applyRelay(info);
    expect(getLlmSettings()).toMatchObject({ provider: 'relay', model: 'm2' });
    reloadLlmSettings();
    applyRelay(null);
    expect(getLlmSettings().provider).toBe('gemini');
  });
  it('会社を自分で選んだあとに中継が見つかっても、替えない', () => {
    setLlmSettings({ provider: 'bedrock' });
    applyRelay(info);
    expect(getLlmSettings().provider).toBe('bedrock');
  });
  it('中継が許さなくなったモデルは、先頭に直す', () => {
    localStorage.setItem('ai-chem-editor:llm', JSON.stringify({ provider: 'relay', models: { relay: 'gone' } }));
    reloadLlmSettings();
    applyRelay(info);
    expect(getLlmSettings().model).toBe(info.models[0].id);
  });
});

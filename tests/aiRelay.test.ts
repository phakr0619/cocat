import { describe, expect, it, vi } from 'vitest';
import { handle, HEARTBEAT_MS, MAX_BODY_BYTES, type ConverseInput, type RelayDeps, type RelayOut } from '../server/ai-relay/src/handler';

const MODEL = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';
const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
const post = (o: Record<string, unknown> = {}) => ({ method: 'POST', body: JSON.stringify({ model: MODEL, system: 's', user: 'u', schema, ...o }) });

/** 出力と時計の偽物。events に、起きた順に残す */
function setup(converse: (i: ConverseInput) => Promise<unknown>) {
  const events: string[] = [];
  let status = 0;
  const out: RelayOut = {
    start: (s) => ((status = s), events.push(`start:${s}`)),
    write: (c) => events.push(`write:${c}`),
    end: () => events.push('end'),
  };
  const logs: string[] = [];
  const deps: RelayDeps = {
    region: 'ap-northeast-1',
    models: [MODEL, 'jp.anthropic.claude-sonnet-4-6'],
    converse: (i) => (events.push('converse'), converse(i)),
    setInterval: (f, ms) => setInterval(f, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    now: () => Date.now(),
    log: (l) => logs.push(l),
  };
  return { events, deps, out, logs, status: () => status };
}
const written = (events: string[]) => events.filter((e) => e.startsWith('write:')).map((e) => e.slice(6));
const finalJson = (events: string[]) => JSON.parse(written(events).join(''));
const ok = { output: { message: { content: [{ toolUse: { name: 'answer', input: { ok: true } } }] } }, stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 3 } };

describe('Bedrock の中継（handler）', () => {
  it('GET は使えるモデルの一覧を返す', async () => {
    const t = setup(async () => ok);
    await handle({ method: 'GET', body: null }, t.out, t.deps);
    expect(t.status()).toBe(200);
    expect(finalJson(t.events)).toEqual({ provider: 'bedrock', region: 'ap-northeast-1', models: t.deps.models });
    expect(t.events).not.toContain('converse');
    expect(t.events.at(-1)).toBe('end');
  });

  it('形が違う本文は、AI を呼ぶ前に 400', async () => {
    for (const body of ['not json', '[]', JSON.stringify({ model: MODEL }), JSON.stringify({ model: MODEL, system: 's', user: 'u', schema, images: [{ mimeType: 'image/png' }] })]) {
      const t = setup(async () => ok);
      await handle({ method: 'POST', body }, t.out, t.deps);
      expect(t.status()).toBe(400);
      expect(finalJson(t.events)).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
      expect(t.events).not.toContain('converse');
    }
  });

  it('許していないモデルは、AI を呼ぶ前に 400（kind は model）', async () => {
    const t = setup(async () => ok);
    await handle(post({ model: 'jp.anthropic.claude-opus-x' }), t.out, t.deps);
    expect(t.status()).toBe(400);
    expect(finalJson(t.events)).toMatchObject({ ok: false, error: { kind: 'model' } });
    expect(t.events).not.toContain('converse');
  });

  it('5 MB を超える本文は、AI を呼ぶ前に 413（kind は too-large）', async () => {
    const t = setup(async () => ok);
    await handle(post({ user: 'x'.repeat(MAX_BODY_BYTES) }), t.out, t.deps);
    expect(t.status()).toBe(413);
    expect(finalJson(t.events)).toMatchObject({ ok: false, error: { kind: 'too-large' } });
    expect(t.events).not.toContain('converse');
  });

  it('POST 以外・GET 以外は 405（403 と 404 は返さない）', async () => {
    const t = setup(async () => ok);
    await handle({ method: 'PUT', body: '' }, t.out, t.deps);
    expect(t.status()).toBe(405);
  });

  it('受け付けたら、Bedrock を呼ぶ前に 200 と空白 1 つを書く。答えは 1 つの JSON', async () => {
    let seen: ConverseInput | undefined;
    const t = setup(async (i) => ((seen = i), ok));
    await handle(post({ images: [{ mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }] }), t.out, t.deps);
    expect(t.events.slice(0, 3)).toEqual(['start:200', 'write: ', 'converse']);
    expect(t.events.at(-1)).toBe('end');
    expect(JSON.parse(written(t.events).join(''))).toEqual({ ok: true, value: { ok: true }, usage: { input: 10, output: 3 } });
    // 画像は Uint8Array で渡し、答えの長さの上限は一覧のモデルの値
    expect(seen?.modelId).toBe(MODEL);
    expect(seen?.inferenceConfig).toEqual({ maxTokens: 16000 });
    const img = (seen?.messages as { content: { image?: { format: string; source: { bytes: Uint8Array } } }[] }[])[0].content[0].image;
    expect(img?.format).toBe('png');
    expect([...(img?.source.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  it('待つあいだ、10 秒ごとに空白を書く。終わったら止める', async () => {
    vi.useFakeTimers();
    try {
      let done!: (v: unknown) => void;
      const t = setup(() => new Promise((r) => (done = r)));
      const p = handle(post(), t.out, t.deps);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3 + 1);
      expect(written(t.events)).toEqual([' ', ' ', ' ', ' ']);
      done(ok);
      await p;
      const n = t.events.length;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
      expect(t.events.length).toBe(n);
      expect(t.events.at(-1)).toBe('end');
      expect(written(t.events).join('').trim()).toContain('"ok":true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Bedrock の失敗は、空白を書いたあとに kind 付きの JSON で返す（ThrottlingException は rate）', async () => {
    const t = setup(async () => {
      throw Object.assign(new Error('Too many requests'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } });
    });
    await handle(post(), t.out, t.deps);
    expect(t.status()).toBe(200);
    expect(t.events.slice(0, 2)).toEqual(['start:200', 'write: ']);
    expect(t.events.at(-1)).toBe('end');
    expect(JSON.parse(written(t.events).join(''))).toEqual({ ok: false, error: { kind: 'rate', message: 'Too many requests' } });
  });

  it('権限の失敗は auth。SDK の例外に status が無ければ server', async () => {
    const a = setup(async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
    });
    await handle(post(), a.out, a.deps);
    expect(a.status()).toBe(200);
    expect(JSON.parse(written(a.events).join('')).error.kind).toBe('auth');
    const b = setup(async () => {
      throw new Error('boom');
    });
    await handle(post(), b.out, b.deps);
    expect(JSON.parse(written(b.events).join('')).error.kind).toBe('server');
  });

  it('max_tokens で切れた答えは invalid-output で、使った量を付ける', async () => {
    const t = setup(async () => ({ stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 16000 } }));
    await handle(post(), t.out, t.deps);
    expect(JSON.parse(written(t.events).join(''))).toMatchObject({ ok: false, error: { kind: 'invalid-output' }, usage: { input: 5, output: 16000 } });
  });

  it('どの道でも、書く前に閉じない。記録に文章と答えを入れない', async () => {
    for (const run of [
      async () => {
        const t = setup(async () => ok);
        await handle(post({ user: 'SECRET-PROMPT' }), t.out, t.deps);
        return t;
      },
      async () => {
        const t = setup(async () => {
          throw new Error('SECRET-PROMPT');
        });
        await handle(post({ user: 'SECRET-PROMPT' }), t.out, t.deps);
        return t;
      },
      async () => {
        const t = setup(async () => ok);
        await handle({ method: 'POST', body: '{' }, t.out, t.deps);
        return t;
      },
    ]) {
      const t = await run();
      const firstWrite = t.events.findIndex((e) => e.startsWith('write:'));
      expect(firstWrite).toBeGreaterThan(-1);
      expect(firstWrite).toBeLessThan(t.events.indexOf('end'));
      expect([200, 400]).toContain(t.status());
      for (const l of t.logs) {
        expect(l).not.toContain('SECRET');
        expect(l).not.toContain('"value"');
      }
    }
  });

  it('記録は、時刻・モデル・成否・トークン数・かかった時間だけ', async () => {
    const t = setup(async () => ok);
    await handle(post(), t.out, t.deps);
    expect(t.logs).toHaveLength(1);
    expect(Object.keys(JSON.parse(t.logs[0])).sort()).toEqual(['input', 'model', 'ms', 'ok', 'output', 't']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** VITE_ANALYTICS を変えて読み込み直す（有効かどうかは読み込んだときに決まる） */
async function load(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_ANALYTICS', enabled ? '1' : '');
  vi.stubEnv('VITE_APP_VERSION', '0.1.0');
  return import('../src/analytics');
}

describe('使い方の統計', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    });
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('公開のビルド（VITE_ANALYTICS=1）でなければ何も送らない', async () => {
    const a = await load(false);
    a.track('open');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('送るのは機能の名前・匿名の番号・版だけで、送り先は自分のサイトの /e', async () => {
    const a = await load(true);
    a.track('export:cdxml');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string, 'https://example.com');
    expect(url.pathname).toBe('/e');
    expect([...url.searchParams.keys()].sort()).toEqual(['n', 's', 'u', 'v']);
    expect(url.searchParams.get('n')).toBe('export:cdxml');
    expect(url.searchParams.get('v')).toBe('0.1.0');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('omit');
  });

  it('名前の形が違うもの（文字や構造が紛れ込んだもの）は送らない', async () => {
    const a = await load(true);
    a.track('CC(=O)Oc1ccccc1C(=O)O');
    a.track('text:アスピリン');
    a.track('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('once は同じタブで1回だけ', async () => {
    const a = await load(true);
    a.track('tool:single', { once: true });
    a.track('tool:single', { once: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('止めると送らず、番号も消す。Global Privacy Control が有効でも送らない', async () => {
    const a = await load(true);
    a.track('open');
    expect(localStorage.getItem('ai-chem-editor:analytics-id')).toBeTruthy();
    a.setOptOut(true);
    expect(localStorage.getItem('ai-chem-editor:analytics-id')).toBeNull();
    a.track('open');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    a.setOptOut(false);
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    a.track('open');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('人数を数える番号は月が変わると作り直す', async () => {
    const a = await load(true);
    const r = () => new Uint32Array([123456, 789]);
    const oct = a.monthlyId(new Date('2026-10-24T00:00:00Z'), r);
    expect(oct.startsWith('202610-')).toBe(true);
    expect(a.monthlyId(new Date('2026-10-31T00:00:00Z'), () => new Uint32Array([1, 2]))).toBe(oct);
    const nov = a.monthlyId(new Date('2026-11-01T00:00:00Z'), () => new Uint32Array([1, 2]));
    expect(nov.startsWith('202611-')).toBe(true);
    expect(nov).not.toBe(oct);
  });
});

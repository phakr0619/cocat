import { beforeEach, describe, expect, it } from 'vitest';
import { getLlmSettings, keyStorageName, reloadLlmSettings, setLlmSettings } from '../src/llm/settings';
import { PROVIDERS } from '../src/llm/providers';

// localStorage の代わり（node の環境でも動くように）
function fake(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('AI の設定の保存', () => {
  beforeEach(() => {
    (globalThis as { localStorage: Storage }).localStorage = fake();
    reloadLlmSettings();
  });

  it('何も無ければ gemini と既定のモデル', () => {
    expect(getLlmSettings()).toMatchObject({ provider: 'gemini', model: PROVIDERS.gemini.defaultModel, apiKey: '', remember: false });
  });
  it('古い版の model を読み、選び直しを保つ', () => {
    localStorage.setItem('ai-chem-editor:llm', JSON.stringify({ model: 'gemini-4-argon', paidKey: true }));
    reloadLlmSettings();
    expect(getLlmSettings()).toMatchObject({ provider: 'gemini', model: 'gemini-4-argon', paidKey: true });
    setLlmSettings({ thinking: 'high' });
    const saved = JSON.parse(localStorage.getItem('ai-chem-editor:llm') ?? '{}');
    expect(saved).toMatchObject({ provider: 'gemini', models: { gemini: 'gemini-4-argon' }, thinking: 'high' });
    reloadLlmSettings();
    expect(getLlmSettings().model).toBe('gemini-4-argon');
  });
  it('models の値を優先し、知らない provider は gemini にする', () => {
    localStorage.setItem('ai-chem-editor:llm', JSON.stringify({ provider: 'nope', model: 'old', models: { gemini: 'new', nope: 'x' } }));
    reloadLlmSettings();
    expect(getLlmSettings()).toMatchObject({ provider: 'gemini', model: 'new' });
  });
  it('壊れた設定でも既定に戻る', () => {
    localStorage.setItem('ai-chem-editor:llm', 'null');
    reloadLlmSettings();
    expect(getLlmSettings().provider).toBe('gemini');
  });
  it('Gemini の覚えたキーは今までの名前のまま', () => {
    expect(keyStorageName('gemini')).toBe('ai-chem-editor:llm-key');
    localStorage.setItem('ai-chem-editor:llm-key', 'OLD');
    reloadLlmSettings();
    expect(getLlmSettings()).toMatchObject({ apiKey: 'OLD', remember: true });
    setLlmSettings({ apiKey: ' NEW ', remember: true });
    expect(localStorage.getItem('ai-chem-editor:llm-key')).toBe('NEW');
    setLlmSettings({ remember: false });
    expect(localStorage.getItem('ai-chem-editor:llm-key')).toBeNull();
  });
});

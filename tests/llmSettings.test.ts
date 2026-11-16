import { beforeEach, describe, expect, it } from 'vitest';
import { forgetLlmKey, getLlmSettings, keyStorageName, llmProvider, reloadLlmSettings, setLlmSettings } from '../src/llm/settings';
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
  it('会社を切り替えると、会社ごとのモデルとキーに替わり、戻ると元の分が残る', () => {
    setLlmSettings({ apiKey: 'GKEY', model: 'gemini-4-argon', remember: true });
    setLlmSettings({ provider: 'bedrock' });
    expect(getLlmSettings()).toMatchObject({ provider: 'bedrock', model: PROVIDERS.bedrock.defaultModel, apiKey: '', remember: false });
    // 覚えていないキーは、メモリにだけ置く
    setLlmSettings({ apiKey: 'BKEY', model: 'jp.anthropic.claude-opus-5-5' });
    expect(localStorage.getItem(keyStorageName('bedrock'))).toBeNull();
    expect(localStorage.getItem('ai-chem-editor:llm-key')).toBe('GKEY');
    setLlmSettings({ provider: 'gemini' });
    expect(getLlmSettings()).toMatchObject({ provider: 'gemini', model: 'gemini-4-argon', apiKey: 'GKEY', remember: true });
    setLlmSettings({ provider: 'bedrock' });
    expect(getLlmSettings()).toMatchObject({ provider: 'bedrock', model: 'jp.anthropic.claude-opus-5-5', apiKey: 'BKEY', remember: false });
    // 覚えると、会社ごとの名前で置く。開き直すとその会社の分を読む
    setLlmSettings({ remember: true });
    expect(localStorage.getItem('ai-chem-editor:llm-key:bedrock')).toBe('BKEY');
    expect(keyStorageName('bedrock')).toBe('ai-chem-editor:llm-key:bedrock');
    reloadLlmSettings();
    expect(getLlmSettings()).toMatchObject({ provider: 'bedrock', model: 'jp.anthropic.claude-opus-5-5', apiKey: 'BKEY', remember: true });
    setLlmSettings({ provider: 'gemini' });
    expect(getLlmSettings()).toMatchObject({ apiKey: 'GKEY', remember: true, model: 'gemini-4-argon' });
  });
  it('キーを消した会社へ戻っても、消したまま', () => {
    setLlmSettings({ provider: 'bedrock', apiKey: 'B', remember: true });
    forgetLlmKey();
    setLlmSettings({ provider: 'gemini' });
    setLlmSettings({ provider: 'bedrock' });
    expect(getLlmSettings()).toMatchObject({ apiKey: '', remember: false });
    expect(localStorage.getItem(keyStorageName('bedrock'))).toBeNull();
  });
  it('llmProvider は会社に合う口を返す。キーが無ければ null', () => {
    expect(llmProvider({ ...getLlmSettings(), provider: 'bedrock', apiKey: '' })).toBeNull();
    expect(llmProvider({ ...getLlmSettings(), provider: 'bedrock', apiKey: 'K' })?.id).toBe('bedrock');
    expect(llmProvider({ ...getLlmSettings(), provider: 'gemini', apiKey: 'K' })?.id).toBe('gemini');
  });
  it('ほかの会社の旧い形の設定は、そのまま読む（provider が bedrock）', () => {
    localStorage.setItem('ai-chem-editor:llm', JSON.stringify({ provider: 'bedrock', models: { bedrock: 'custom-id' } }));
    localStorage.setItem('ai-chem-editor:llm-key:bedrock', 'BK');
    reloadLlmSettings();
    expect(getLlmSettings()).toMatchObject({ provider: 'bedrock', model: 'custom-id', apiKey: 'BK', remember: true });
  });
});

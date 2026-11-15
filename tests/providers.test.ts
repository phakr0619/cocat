import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS } from '../src/llm/gemini';
import { imageFileError, LLM_IMAGE_TYPES, MAX_IMAGE_FILE_BYTES } from '../src/llm/image';
import { isProviderId, PROVIDERS, providerInfo, providerLabel, showFreeKeyNotes } from '../src/llm/providers';
import { llmErrorText, type LlmErrorKind } from '../src/llm/types';

describe('providerInfo: 接続の型の一覧', () => {
  it('gemini は Google（Gemini）', () => {
    const g = providerInfo('gemini');
    expect([g.company, g.product, g.label, g.freeKeyUsedForTraining]).toEqual(['Google', 'Gemini', 'Google（Gemini）', true]);
  });
  it('無料のキーの注意は、有料のキーでなく、その会社が無料のキーの内容を改善に使うときだけ出す', () => {
    expect(showFreeKeyNotes({ provider: 'gemini', paidKey: false })).toBe(true);
    expect(showFreeKeyNotes({ provider: 'gemini', paidKey: true })).toBe(false);
  });
  it('省略すると今の provider（gemini）。知らない provider でも落ちない', () => {
    expect(providerLabel().label).toBe('Google（Gemini）');
    expect(providerInfo('unknown' as 'gemini').label).toBe('Google（Gemini）');
    expect(isProviderId('gemini')).toBe(true);
    expect(isProviderId('unknown')).toBe(false);
    expect(isProviderId('toString')).toBe(false);
  });
  it.each(Object.values(PROVIDERS))('$id: 一覧の中身が揃っている', (p) => {
    expect(PROVIDERS[p.id]).toBe(p);
    expect(p.models.some((m) => m.id === p.defaultModel)).toBe(true);
    expect(new Set(p.models.map((m) => m.id)).size).toBe(p.models.length);
    expect(p.models.find((m) => m.id === p.defaultModel)?.paidOnly).toBeFalsy();
    if (!p.hasPaidKeyOption) expect(p.models.some((m) => m.paidOnly)).toBe(false);
    expect(p.imageTypes.length).toBeGreaterThan(0);
    expect(p.maxImageFileBytes).toBeGreaterThan(0);
    expect(p.keyHelp.url).toMatch(/^https:\/\//);
    expect(p.connectSrc.every((o) => /^https:\/\/[^/]+$/.test(o))).toBe(true);
    for (const k of ['auth', 'quota', 'timeout', 'server', 'refused'] as const) expect(p.errors[k]).not.toBe('');
  });
  it('Gemini の別名と画像の値が一覧と同じ', () => {
    expect(GEMINI_MODELS).toBe(PROVIDERS.gemini.models);
    expect(DEFAULT_GEMINI_MODEL).toBe(PROVIDERS.gemini.defaultModel);
    expect(LLM_IMAGE_TYPES).toBe(PROVIDERS.gemini.imageTypes);
    expect(MAX_IMAGE_FILE_BYTES).toBe(PROVIDERS.gemini.maxImageFileBytes);
    expect(imageFileError({ type: 'image/gif', size: 1 }, 'gemini')).toBe(PROVIDERS.gemini.imageTypeText);
    expect(imageFileError({ type: 'image/png', size: MAX_IMAGE_FILE_BYTES + 1 })).toBe(PROVIDERS.gemini.imageSizeText);
    expect(imageFileError({ type: 'image/png', size: 1 })).toBeNull();
  });
  it('CSP の connect-src（infra/cloudfront.tf）が、一覧の送り先をすべて含む', () => {
    const tf = readFileSync('infra/cloudfront.tf', 'utf8');
    const line = tf.split('\n').find((l) => l.includes('connect-src'));
    expect(line).toBeTruthy();
    for (const p of Object.values(PROVIDERS)) for (const o of p.connectSrc) expect(line).toContain(o);
  });
});

describe('llmErrorText: 会社ごとの文は一覧から引く', () => {
  const gem = { provider: 'gemini', paidKey: true } as const;
  it('auth・quota・timeout・server・refused は一覧の文', () => {
    for (const k of ['auth', 'quota', 'timeout', 'server', 'refused'] as const) expect(llmErrorText({ kind: k, message: '' }, gem)).toBe(PROVIDERS.gemini.errors[k]);
  });
  it('無料のキーなら、quota と timeout に一覧の注意を添える', () => {
    const free = { provider: 'gemini', paidKey: false } as const;
    expect(llmErrorText({ kind: 'quota', message: '' }, free)).toBe(`${PROVIDERS.gemini.errors.quota}。${PROVIDERS.gemini.freeKeyNotes.quota}`);
    expect(llmErrorText({ kind: 'timeout', message: '' }, free)).toBe(`${PROVIDERS.gemini.errors.timeout}。${PROVIDERS.gemini.freeKeyNotes.timeout}`);
  });
  it('会社に依らない文は共通', () => {
    const kinds: LlmErrorKind[] = ['rate', 'network', 'invalid-output', 'aborted'];
    for (const k of kinds) expect(llmErrorText({ kind: k, message: '' }, gem)).not.toMatch(/Gemini|Google/);
  });
});

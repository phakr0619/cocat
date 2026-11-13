import { describe, expect, it } from 'vitest';
import { providerLabel, showFreeKeyNotes } from '../src/llm/providerLabel';

describe('providerLabel: 送り先の名前を設定の provider から返す', () => {
  it('gemini は Google（Gemini）', () => {
    expect(providerLabel('gemini')).toEqual({ company: 'Google', product: 'Gemini', label: 'Google（Gemini）', freeKeyUsedForTraining: true });
  });
  it('無料のキーの注意は、有料のキーでなく、その会社が無料のキーの内容を改善に使うときだけ出す', () => {
    expect(showFreeKeyNotes({ provider: 'gemini', paidKey: false })).toBe(true);
    expect(showFreeKeyNotes({ provider: 'gemini', paidKey: true })).toBe(false);
  });
  it('省略すると今の provider（gemini）。知らない provider でも落ちない', () => {
    expect(providerLabel().label).toBe('Google（Gemini）');
    expect(providerLabel('unknown' as 'gemini').label).toBe('Google（Gemini）');
  });
});

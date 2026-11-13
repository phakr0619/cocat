import { beforeAll, describe, expect, it } from 'vitest';
import { fillWriteUp, writeFacts, writeUp } from '../../src/llm/writeUp';
import type { LlmProvider } from '../../src/llm/types';
import { loadRDKit } from '../rdkit';
import { idealWriteUp, scoreWriteUp, WRITEUP_CASES, writeUpBase, type WriteUpEvalCase } from './writeup-score';

beforeAll(loadRDKit);

const byId = (id: string) => WRITEUP_CASES.find((c) => c.id === id)!;
/** 決まった答えで採点する（writeUp の差し込みと確かめを通す） */
function scoreWith(c: WriteUpEvalCase, raw: { text: string; questions: string[] }) {
  const { doc, schemeId } = writeUpBase(c);
  return scoreWriteUp(c, { ok: true, checked: fillWriteUp(writeFacts(doc, schemeId), raw, c.text) });
}

describe('書く評価の件', () => {
  it('11 件あり、id は重ならず、使うべき印はすべて一覧にある', () => {
    expect(WRITEUP_CASES).toHaveLength(11);
    expect(new Set(WRITEUP_CASES.map((c) => c.id)).size).toBe(11);
    for (const c of WRITEUP_CASES) {
      const { doc, schemeId } = writeUpBase(c);
      const facts = writeFacts(doc, schemeId).facts;
      for (const p of c.expect.placeholders) expect(facts.has(p), `${c.id}: {{${p}}}`).toBe(true);
    }
  });

  it('書く前のスキームの量は、アプリの化学量論表のとおり', () => {
    const f = (id: string) => {
      const { doc, schemeId } = writeUpBase(byId(id));
      return writeFacts(doc, schemeId).facts;
    };
    expect(f('amide-en').get('s1.C1.mmol')?.value).toBe('1.00 mmol');
    expect(f('amide-noscale').get('s1.C1.mg')?.value).toBeNull();
    expect(f('two-step').get('s2.C3.mmol')?.value).toBe('0.80 mmol');
    expect(f('two-step').get('s2.R1.uL')?.value).toBe('612.6 µL');
    expect(f('suzuki-unknown-mw').get('s1.R1.mg')?.value).toBeNull();
    expect(f('suzuki-unknown-mw').get('s1.R2.mg')?.value).toBe('276.4 mg');
    expect(f('deprotect-quant').get('s1.yield')?.value).toBe('quant.');
  });

  it.each(WRITEUP_CASES.map((c) => c.id))('正しい答えの例は「正しい」: %s', (id) => {
    const c = byId(id);
    const s = scoreWith(c, idealWriteUp(c));
    expect(s.notes).toEqual(c.expect.expectIssues || c.expect.allowIssues ? expect.anything() : []);
    expect(s.outcome).toBe('correct');
  });
});

describe('採点', () => {
  it('印が足りないのに確かめが何も言わなければ、黙って間違えた', () => {
    const c = byId('amide-en');
    // 収率と時間を書き忘れた（名前と量はすべてある）
    const s = scoreWith(c, { text: idealWriteUp(c).text.replace(', {{s1.time}}, {{s1.yield}}', ''), questions: [] });
    expect(s.outcome).toBe('silent-wrong');
    expect(s.notes).toEqual(['印が無い: {{s1.time}}', '印が無い: {{s1.yield}}']);
  });

  it('頼んでいない後処理を書いたら、黙って間違えた。書き足す所の中なら構わない', () => {
    const c = byId('amide-en');
    const base = idealWriteUp(c).text;
    expect(scoreWith(c, { text: base.replace('[[work-up]]', 'The residue was purified by column chromatography.'), questions: [] }).outcome).toBe('silent-wrong');
    expect(scoreWith(c, { text: base.replace('[[work-up]]', '[[purification by column chromatography]]'), questions: [] }).outcome).toBe('correct');
  });

  it('自分で数字を書けば要確認で止まった', () => {
    const c = byId('amide-en');
    const s = scoreWith(c, { text: idealWriteUp(c).text.replace('{{s1.time}}', '3 h'), questions: [] });
    expect(s.outcome).toBe('flagged');
  });

  it('量が未入力の件で、量の要確認が出なければ正しくない', () => {
    const c = byId('amide-noscale');
    const s = scoreWith(c, { text: '{{C1}}, {{C2}}, {{s1.R1}} ({{s1.R1.equiv}}), {{s1.R2}} in {{s1.solvent}} gave {{C3}} ({{s1.yield}}).', questions: [] });
    expect(s.notes).toContain('出るべき要確認が無い: missing');
    expect(s.outcome).toBe('silent-wrong');
  });

  it('NMR を頼まれて、作らずに質問で知らせれば正しい。作り話の数字は要確認で止まる', () => {
    const c = byId('nmr-request');
    const ideal = idealWriteUp(c).text.replace('[[NMR data]]', '');
    expect(scoreWith(c, { text: ideal, questions: ['NMR のデータはスキームにありません'] }).outcome).toBe('correct');
    expect(scoreWith(c, { text: `${ideal} 1H NMR (400 MHz, CDCl3) δ 7.26 (s, 1H).`, questions: [] }).outcome).toBe('flagged');
    expect(scoreWith(c, { text: ideal, questions: [] }).outcome).toBe('silent-wrong');
  });

  it('呼び出しの失敗は失敗', async () => {
    const c = byId('amide-en');
    const { doc, schemeId } = writeUpBase(c);
    const llm: LlmProvider = { id: 'gemini', generateJson: async () => ({ ok: false, error: { kind: 'quota', message: 'x' } }), listModels: async () => ({ ok: true, value: [] }) };
    const r = await writeUp(llm, { doc, schemeId, text: c.text, language: c.language });
    expect(scoreWriteUp(c, r).outcome).toBe('error');
  });
});

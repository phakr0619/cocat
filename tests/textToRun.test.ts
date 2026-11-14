import { describe, expect, it } from 'vitest';
import { applyRunDraft, checkRunDraft, checkRunShape, runPrompt, type RawRunDraft } from '../src/llm/textToRun';
import { runBalance } from '../src/process/balance';
import { runBoxes } from '../src/process/layout';
import { RUN_CASES, runDocFor, scoreRun } from './llm-eval/run-score';

const memo = '9:20 EDC·HCl 12.2 g を入れた。内温 2 → 6 °C。\n12:41 1 M HCl 50 g で洗った。有機層 152.0 g、水層 61 g。\n13:30 濃縮して 18.4 g。';
const good: RawRunDraft = {
  operations: [
    { kind: 'reaction', name: '反応' },
    { kind: 'wash', name: '洗浄', outputs: [{ name: '水層', amount: '61 g' }], carry: '152.0 g' },
    { kind: 'concentration', name: '濃縮', carry: '18.4 g' },
  ],
  materials: [{ name: '1 M HCl', role: 'water', amount: '50 g', operation: 2 }],
  events: [
    { operation: 1, time: '9:20', action: 'EDC·HCl を入れた', amount: '12.2 g', temp: '2 → 6 °C' },
    { operation: 2, time: '12:41', action: '1 M HCl で洗った', amount: '50 g' },
    { operation: 3, time: '13:30', action: '濃縮した', note: '18.4 g' },
  ],
};

describe('メモから作った下書きを確かめる', () => {
  it('メモにある数字だけなら、要確認は無い。量は数と単位に読む', () => {
    const d = checkRunDraft(memo, good);
    expect(d.issues).toEqual([]);
    expect(d.operations[1].outputs[0].amount).toEqual({ value: 61, unit: 'g' });
    expect(d.operations[1].carry).toEqual({ value: 152, unit: 'g' });
    expect(d.materials[0]).toMatchObject({ name: '1 M HCl', role: 'water', amount: { value: 50, unit: 'g' }, operation: 2 });
    expect(d.events[0]).toMatchObject({ time: '9:20', temp: '2 → 6 °C', amount: '12.2 g' });
  });

  it('メモに無い数字は要確認にし、量には入れない。読めない量も入れない', () => {
    const bad: RawRunDraft = structuredClone(good);
    bad.operations[1].carry = '150 g';
    bad.operations[2].carry = 'たくさん';
    bad.events[0].temp = '5 °C';
    const d = checkRunDraft(memo, bad);
    expect(d.operations[1].carry).toBeUndefined();
    expect(d.operations[2].carry).toBeUndefined();
    expect(d.events[0].temp).toBeUndefined();
    const text = d.issues.map((i) => i.message).join('\n');
    expect(text).toContain('「150」は、メモに無い数字です');
    expect(text).toContain('量「たくさん」を、数と単位として読めません');
    expect(text).toContain('内温の「5」は、メモに無い数字です');
  });

  it('化学式の添字（NaHCO3・CH2Cl2）は数字として数えない。漢数字と全角の数字はメモの数字として拾う', () => {
    const d = checkRunDraft('飽和 NaHCO3 水 ５０ g で二回洗った', { operations: [{ kind: 'wash', name: '洗浄' }], materials: [{ name: '飽和 NaHCO3 水', role: 'water', amount: '50 g', operation: 1 }], events: [{ operation: 1, action: '飽和 NaHCO3 水で 2 回洗った' }] });
    expect(d.issues).toEqual([]);
  });

  it('操作の番号が合わない・知らない種類は、知らせて直す', () => {
    const d = checkRunDraft(memo, { operations: [{ kind: 'magic', name: '何か' }], events: [{ operation: 5, action: '入れた' }] });
    expect(d.operations[0].kind).toBe('other');
    expect(d.events[0].operation).toBe(1);
    expect(d.issues.map((i) => i.kind).sort()).toEqual(['index', 'kind']);
  });

  it('形が崩れた答えは受け付けない', () => {
    expect('error' in checkRunShape({ operations: [], events: [] })).toBe(true);
    expect('error' in checkRunShape({ operations: [{ kind: 'wash' }], events: [] })).toBe(true);
    expect('value' in checkRunShape(good)).toBe(true);
  });
});

describe('下書きを記録に入れる', () => {
  it('操作と記録を置き換え、仕込みは残して足す。フロー図と収支も変わる', () => {
    const c = RUN_CASES[0];
    const { doc, runId } = runDocFor(c);
    const next = applyRunDraft(doc, runId, checkRunDraft(memo, good));
    const run = next.runs![runId];
    expect(run.operations.map((o) => o.name)).toEqual(['反応', '洗浄', '濃縮']);
    expect(run.materials.length).toBe(c.known.length + 1);
    expect(run.materials.at(-1)).toMatchObject({ name: '1 M HCl', opId: run.operations[1].id });
    expect(run.events.map((e) => e.opId)).toEqual(run.operations.map((o) => o.id));
    expect(runBoxes(next, runId).length).toBe(3);
    expect(runBalance(run).ops[2].carryG).toBeCloseTo(18.4);
    // 同じ下書きをもう一度入れても、仕込みは増えない
    expect(applyRunDraft(next, runId, checkRunDraft(memo, good)).runs![runId].materials.length).toBe(c.known.length + 1);
  });

  it('送る本文には、仕込みの名前・量・役割とメモが入り、ロットは入らない', () => {
    const { doc, runId } = runDocFor(RUN_CASES[0]);
    const withLot = structuredClone(doc);
    withLot.runs![runId].materials[0].lot = 'SECRET-LOT';
    const p = runPrompt(withLot, withLot.runs![runId], 'メモ');
    expect(p).toContain('- Boc-Ala-OH (10 g) [substrate]');
    expect(p).toContain('MEMO:\nメモ');
    expect(p).not.toContain('SECRET-LOT');
  });
});

describe('採点', () => {
  it('期待どおりの下書きは correct、メモに無い量が要確認なしで入っていれば silent-wrong', () => {
    const c = RUN_CASES.find((x) => x.id === 'tfa-short')!;
    const ok = checkRunDraft(c.memo, {
      operations: [{ kind: 'reaction', name: '反応' }, { kind: 'concentration', name: '濃縮', carry: '5.2 g' }],
      materials: [{ name: 'トルエン', role: 'solvent', amount: '20 mL', operation: 2 }],
      events: [{ operation: 1, action: 'TFA を滴下' }, { operation: 1, action: '室温で撹拌' }, { operation: 2, action: 'トルエンで共沸' }],
    });
    expect(scoreRun(c, { ok: true, draft: ok }).outcome).toBe('correct');
    const lied = structuredClone(ok);
    lied.operations[1].carry = { value: 4.8, unit: 'g' };
    expect(scoreRun(c, { ok: true, draft: lied }).outcome).toBe('silent-wrong');
  });
});

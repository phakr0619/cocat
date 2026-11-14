// 実験の記録を使った実験項の評価の採点。本物の API で測る道具（writeup-run.eval.ts）と、記録した答えを採点するテストの両方で使う
import type { Doc } from '../../src/chem/model';
import type { WriteLanguage, WriteUpResult } from '../../src/llm/writeUp';
import { SAMPLES } from '../../src/samples';
import type { CaseScore } from './score';

export interface WriteUpRunCase {
  id: string;
  language: WriteLanguage;
  /** 利用者の指示 */
  text: string;
  /** 文章に入っているべき書き方（どれか 1 つが入っていればよい並びの、並び） */
  include: string[][];
}

export const WRITEUP_RUN_CASES: WriteUpRunCase[] = [
  {
    id: 'run-en',
    language: 'en',
    text: '',
    include: [['10 g'], ['12.2 g'], ['100 mL'], ['11.9 g'], ['86.5%'], ['1 M HCl'], ['NaHCO3'], ['brine', '食塩水'], ['heptane', 'ヘプタン'], ['AcOEt', 'EtOAc', 'ethyl acetate'], ['HPLC']],
  },
  {
    id: 'run-ja',
    language: 'ja',
    text: '',
    include: [['10 g'], ['12.2 g'], ['100 mL'], ['11.9 g'], ['86.5%'], ['1 M HCl'], ['NaHCO3'], ['食塩水', 'brine'], ['ヘプタン', 'heptane'], ['AcOEt', '酢酸エチル', 'EtOAc'], ['HPLC']],
  },
  {
    id: 'run-en-short',
    language: 'en',
    text: '洗浄の回数と pH は書かなくてよい。短く',
    include: [['10 g'], ['12.2 g'], ['11.9 g'], ['86.5%'], ['heptane', 'ヘプタン']],
  },
];

/** 見本の「実験の記録（縮合、10 g）」の文書 */
export function writeUpRunDoc(): { doc: Doc; schemeId: string } {
  const doc = SAMPLES.find((s) => s.id === 'run')!.build();
  return { doc, schemeId: Object.keys(doc.schemes!)[0] };
}

/**
 * correct: 入っているべき書き方がすべて入り、アプリの確かめに何も掛からず、時刻・ロット・書き足す所（[[…]]）が無い
 * flagged: 何かが足りないか違うが、アプリの確かめ（要確認）に掛かっている
 * silent-wrong: 時刻やロットを書いた・量や収率が抜けた・後処理を [[…]] のままにした、のに要確認が無い
 */
export function scoreWriteUpRun(c: WriteUpRunCase, r: WriteUpResult): CaseScore {
  if (!r.ok) return { id: c.id, outcome: 'error', conditions: { hit: 0, total: 0 }, notes: [`${r.error.kind}: ${r.error.message}`] };
  const text = r.checked.text;
  const notes: string[] = [];
  let hit = 0;
  let total = 0;
  const check = (ok: boolean, what: string) => {
    total++;
    if (ok) hit++;
    else notes.push(what);
  };
  for (const any of c.include) check(any.some((s) => text.includes(s)), `「${any.join('」か「')}」が文章に無い`);
  check(!/\b\d{1,2}:\d{2}\b/.test(text), '時刻を書いている');
  check(!text.includes('L-2311'), 'ロットを書いている');
  check(!r.checked.todos.length, `書き足す所が残っている: ${r.checked.todos.join(', ')}`);
  if (r.checked.issues.length) notes.push(`要確認 ${r.checked.issues.length} 件: ${r.checked.issues.map((i) => i.message).join(' / ')}`);
  const flagged = r.checked.issues.length > 0 || r.checked.questions.length > 0;
  return { id: c.id, outcome: hit === total && !flagged ? 'correct' : flagged ? 'flagged' : 'silent-wrong', conditions: { hit, total }, notes };
}

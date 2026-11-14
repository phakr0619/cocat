import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc, type Doc } from '../src/chem/model';
import { checkPlan, confirmDraft, draftScheme, type Plan } from '../src/llm/textToScheme';
import type { LlmProvider } from '../src/llm/types';
import { checkWriteUpShape, fillWriteUp, refillWriteUp, schemeNotebook, schemeStoichTables, writeFacts, writeUp, writeUpPrompt, WRITEUP_SYSTEM_PROMPT } from '../src/llm/writeUp';
import { updateStoich } from '../src/scheme/ops';
import { SAMPLES } from '../src/samples';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

// 縮合 → Boc の除去 の 2 段。1 段目だけ量を入れる
const plan: Plan = {
  compounds: [
    { ref: 'A', name: 'Boc-Ala-OH', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)O' },
    { ref: 'B', name: 'H-Gly-OMe', smiles: 'NCC(=O)OC' },
    { ref: 'C', name: '5', smiles: 'CC(C)(C)OC(=O)N[C@@H](C)C(=O)NCC(=O)OC' },
    { ref: 'D', name: '7', smiles: 'N[C@@H](C)C(=O)NCC(=O)OC' },
  ],
  steps: [
    { from: ['A', 'B'], to: ['C'], reagents: [{ text: 'HATU', equiv: 1.2 }, { text: 'DIPEA', equiv: 3 }], solvent: 'DMF', temp: 'rt', time: '2 h', yield: 85 },
    { from: ['C'], to: ['D'], reagents: [{ text: 'TFA' }], solvent: 'CH2Cl2', temp: '0 °C', time: '1 h', yield: 'quant.' },
  ],
};

function schemeDoc(scaled = true): { doc: Doc; sid: string } {
  const r = draftScheme(emptyDoc(), checkPlan(plan, []), { text: 'x', model: 'm', origin: { x: 0, y: 0 } });
  let doc = confirmDraft(r.doc, r.schemeId);
  if (scaled) doc = updateStoich(doc, r.schemeId, 0, { scale: { value: 189.21, unit: 'mg' } });
  return { doc, sid: r.schemeId };
}

const good = [
  'To a solution of {{C1}} ({{s1.C1.mg}}, {{s1.C1.mmol}}) and {{C2}} ({{s1.C2.mmol}}, {{s1.C2.equiv}}) in {{s1.solvent}} were added {{s1.R1}} ({{s1.R1.mg}}, {{s1.R1.mmol}}, {{s1.R1.equiv}}) and {{s1.R2}} ({{s1.R2.uL}}, {{s1.R2.mmol}}, {{s1.R2.equiv}}).',
  'The mixture was stirred at {{s1.temp}} for {{s1.time}}. [[work-up]] [[purification]] gave {{C3}} ({{s1.C3.mg}}, {{s1.C3.mmol}}, {{s1.yield}}).',
].join(' ');

describe('差し込みの一覧', () => {
  it('アプリの化学量論表と RDKit で、量・分子量・条件を単位つきで出す', () => {
    const { doc, sid } = schemeDoc();
    const f = writeFacts(doc, sid).facts;
    expect(f.get('C1')?.value).toBe('Boc-Ala-OH');
    expect(f.get('C3')?.value).toBe('5');
    expect(f.get('C1.formula')?.value).toBe('C8H15NO4');
    expect(f.get('C1.mw')?.value).toBe('189.21');
    expect(f.get('s1.C1.mmol')?.value).toBe('1.00 mmol');
    expect(f.get('s1.C1.mg')?.value).toBe('189.2 mg');
    expect(f.get('s1.R1')?.value).toBe('HATU');
    expect(f.get('s1.R1.equiv')?.value).toBe('1.2 equiv');
    expect(f.get('s1.R1.mg')?.value).toBe('456.3 mg');
    // DIPEA は辞書に密度があるので体積も出す
    expect(f.get('s1.R2.uL')?.value).toBe('522.6 µL');
    expect(f.get('s1.R1.uL')?.value).toBeNull();
    // 生成物は、理論収量 × 収率
    expect(f.get('s1.C3.mmol')?.value).toBe('0.85 mmol');
    expect(f.get('s1.yield')?.value).toBe('85%');
    expect(f.get('s2.temp')?.value).toBe('0 °C');
    expect(f.get('s2.yield')?.value).toBe('quant.');
    // 2 段目は量が無いので出さず、理由を持つ
    expect(f.get('s2.C3.mmol')?.value).toBeNull();
    expect(f.get('s2.C3.mmol')?.why).toContain('最初の基質の量');
  });

  it('送る本文に、段ごとの印と値を出す。構造の SMILES は送らない', () => {
    const { doc, sid } = schemeDoc();
    const p = writeUpPrompt(writeFacts(doc, sid), '後処理は書かないで', 'en');
    expect(p).toContain('LANGUAGE: English');
    expect(p).toContain('INSTRUCTION: 後処理は書かないで');
    expect(p).toContain('Step 1: Boc-Ala-OH + H-Gly-OMe → 5');
    expect(p).toContain('{{s1.R1.mg}} = 456.3 mg');
    expect(p).toContain('{{C3}} = 5  [product]');
    expect(p).toContain('{{s2.C3.mg}} = (not available)');
    expect(p).not.toContain('[C@@H]');
    expect(WRITEUP_SYSTEM_PROMPT).toContain('Never type numbers yourself');
  });
});

describe('差し込みと確かめ', () => {
  it('よい答えは、値を差し込み、要確認を出さず、書き足す所を一覧にする', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const one = { ...facts, steps: facts.steps.slice(0, 1) };
    const r = fillWriteUp(one, { text: good, questions: [] });
    expect(r.issues).toEqual([]);
    expect(r.text).toContain('Boc-Ala-OH (189.2 mg, 1.00 mmol)');
    expect(r.text).toContain('DIPEA (522.6 µL, 3.00 mmol, 3 equiv)');
    expect(r.text).toContain('gave 5 (221.2 mg, 0.85 mmol, 85%)');
    expect(r.todos).toEqual(['work-up', 'purification']);
  });

  it('印の後ろに重ねた単位は 1 つにする', () => {
    const { doc, sid } = schemeDoc();
    const r = fillWriteUp(writeFacts(doc, sid), { text: '{{C1}} ({{s1.C1.mg}} mg) gave {{C3}} ({{s1.yield}}%).', questions: [] });
    expect(r.text).toContain('(189.2 mg)');
    expect(r.text).toContain('(85%)');
  });

  it('自分で書いた数字・知らない印・値の無い印は要確認。指示の数字・化学式の添字・条件の書き方・段の番号は数えない', () => {
    const { doc, sid } = schemeDoc();
    const t =
      'Step 2. {{C3}} in CH2Cl2 at 0 °C was treated with {{s2.R1}} ({{s2.R1.mmol}}) for 3 h, washed, dried over Na2SO4 and purified (hexane/EtOAc 3:1) to give {{C4}} ({{s2.yield}}). {{s3.R1}}';
    const r = fillWriteUp(writeFacts(doc, sid), { text: t, questions: [] }, 'カラムは hexane/EtOAc 3:1');
    const kinds = r.issues.map((i) => i.kind);
    expect(r.issues.filter((i) => i.kind === 'number').map((i) => i.message)).toEqual([expect.stringContaining('「3」')]);
    expect(kinds).toContain('unknown');
    expect(r.issues.find((i) => i.kind === 'missing')?.message).toContain('2 段目の TFA の mmol: 当量がありません');
    expect(r.text).toContain('TFA ([?])');
    expect(r.text).toContain('{{s3.R1}}');
  });

  it('{{ }} の無い印・全角の数字・数字で書かない量は要確認。書き足す所の中の数字は数えない', () => {
    const { doc, sid } = schemeDoc();
    const r = fillWriteUp(writeFacts(doc, sid), { text: '{{C1}} (s1.C1.mg) was stirred overnight for ２０ h and {C2} was added. [[1H NMR]]', questions: [] });
    const msgs = r.issues.map((i) => i.message).join('\n');
    expect(msgs).toContain('「s1.C1.mg」は {{ }} の無い差し込みの印');
    expect(msgs).toContain('「{C2}」は {{ }} の無い差し込みの印');
    expect(msgs).toContain('「overnight」');
    expect(msgs).toContain('「20」');
    expect(msgs).not.toContain('「1」');
    const ja = fillWriteUp(writeFacts(doc, sid), { text: '{{C1}} を一晩かき混ぜた。', questions: [] });
    expect(ja.issues.map((i) => i.message).join('\n')).toContain('「一晩」');
  });

  it('音声入力の指示の数字（漢数字・全角・「3対1」）は、算用数字で書いても要確認にしない', () => {
    const { doc, sid } = schemeDoc();
    const t = '{{C1}} was purified (hexane/EtOAc 3:1, then 10:1) and washed with 1 M HCl.';
    const ok = (instruction: string) => fillWriteUp(writeFacts(doc, sid), { text: t, questions: [] }, instruction).issues.filter((i) => i.kind === 'number');
    expect(ok('ヘキサク3対1、そのあと10対1。1M塩酸で洗う')).toEqual([]);
    expect(ok('ヘキサク三対一、そのあと十対一。一規定の塩酸で洗う')).toEqual([]);
    expect(ok('ヘキサク３：１、そのあと１０：１。１Ｍ塩酸')).toEqual([]);
    expect(ok('ヘキサク三対一').map((i) => i.message)).toEqual([expect.stringContaining('「10:1」'), expect.stringContaining('「1」')]);
  });

  it('話し言葉の指示を、実験項の言い方に直すよう AI に伝える', () => {
    expect(WRITEUP_SYSTEM_PROMPT).toContain('ヘキサク or ヘキ酢 = hexane/EtOAc');
    expect(WRITEUP_SYSTEM_PROMPT).toContain('重曹水 = saturated aqueous NaHCO3');
  });

  it('日本語の句点と、略の点（equiv.）で文の区切りを間違えない', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const one = { ...facts, steps: facts.steps.slice(0, 1) };
    const ja = fillWriteUp(one, { text: '{{C1}} と {{C2}} を {{s1.solvent}} に溶かした。{{s1.R1.mg}} の {{s1.R1}} と {{s1.R2}} を加え、{{C3}} を得た。', questions: [] });
    expect(ja.issues.filter((i) => i.kind === 'pair')).toEqual([]);
    const en = fillWriteUp(one, { text: '{{C1}}, {{C2}} and {{s1.R1}} (1.2 equiv. by weight, {{s1.R1.mg}}) and {{s1.R2}} in {{s1.solvent}} gave {{C3}}.', questions: [] }, '1.2');
    expect(en.issues.filter((i) => i.kind === 'pair')).toEqual([]);
  });

  it('段の化合物・試薬が出てこなければ要確認。呼び名をそのまま書いたものは出てきたと数える', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const r = fillWriteUp({ ...facts, steps: facts.steps.slice(0, 1) }, { text: 'Boc-Ala-OH and {{C2}} were coupled with HATU in {{s1.solvent}} to give {{C3}}.', questions: [] });
    expect(r.issues.map((i) => i.message)).toEqual(['1 段目の DIPEA が文章にありません']);
  });

  it('量が別の名前の所に書いてあれば、取り違えとして要確認', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const r = fillWriteUp({ ...facts, steps: facts.steps.slice(0, 1) }, {
      text: '{{C1}} ({{s1.C1.mg}}), {{C2}}, {{s1.R1}} ({{s1.R2.mg}}) and {{s1.R2}} ({{s1.R1.mg}}) in {{s1.solvent}} gave {{C3}}.',
      questions: [],
    });
    const pair = r.issues.filter((i) => i.kind === 'pair').map((i) => i.message);
    expect(pair).toHaveLength(2);
    expect(pair[0]).toContain('HATU の所に、1 段目の DIPEA の mg');
  });

  it('名前を並べてから同じ順で量を並べた書き方は通す。順が違えば要確認', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const one = { ...facts, steps: facts.steps.slice(0, 1) };
    const pairs = (text: string) => fillWriteUp(one, { text, questions: [] }).issues.filter((i) => i.kind === 'pair').map((i) => i.message);
    expect(pairs('{{C1}} と {{C2}}（{{s1.C1.mg}} と {{s1.C2.mmol}}）を {{s1.solvent}} に溶かし、{{s1.R1}} と {{s1.R2}} を加えて {{C3}} を得た。')).toEqual([]);
    expect(pairs('{{s1.R1}} and {{s1.R2}} ({{s1.R1.mg}}, {{s1.R1.mmol}} and {{s1.R2.uL}}, {{s1.R2.mmol}}, respectively) were added to {{C1}} and {{C2}} to give {{C3}}.')).toEqual([]);
    expect(pairs('{{s1.R1}} and {{s1.R2}} ({{s1.R2.uL}} and {{s1.R1.mg}}, respectively) were added to {{C1}} and {{C2}} to give {{C3}}.')).toHaveLength(1);
  });

  it('段落が段の数と同じなら、条件の書き方はその段の段落でだけ通す', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const numbers = (text: string) => fillWriteUp(facts, { text, questions: [] }).issues.filter((i) => i.kind === 'number').map((i) => i.message);
    const s1 = '{{C1}} and {{C2}} were stirred with {{s1.R1}} and {{s1.R2}} in DMF at rt for 2 h to give {{C3}}.';
    expect(numbers(`${s1}\n\n{{C3}} was treated with {{s2.R1}} in CH2Cl2 at 0 °C for 1 h to give {{C4}}.`)).toEqual([]);
    // 1 段目の「2 h」を 2 段目に書いた
    expect(numbers(`${s1}\n\n{{C3}} was treated with {{s2.R1}} in CH2Cl2 at 0 °C for 2 h to give {{C4}}.`)).toEqual([expect.stringContaining('2 段目の段落にある「2 h」は、1 段目の時間です')]);
    // 段落が 1 つなら、今までどおりどの段の書き方も通す
    expect(numbers(`${s1} {{C3}} was treated with {{s2.R1}} in CH2Cl2 at 0 °C for 2 h to give {{C4}}.`)).toEqual([]);
  });

  it('量を変えた後に入れ直すと、LLM を呼ばずに新しい値を差し込む', () => {
    const { doc, sid } = schemeDoc();
    const facts = writeFacts(doc, sid);
    const r = fillWriteUp(facts, { text: '{{C1}} ({{s1.C1.mg}}, {{s1.C1.mmol}})', questions: [] });
    const doc2 = updateStoich(doc, sid, 0, { scale: { value: 2, unit: 'mmol' } });
    const r2 = refillWriteUp(doc2, sid, r);
    expect(r2.text).toBe('Boc-Ala-OH (378.4 mg, 2.00 mmol)');
  });

  it('形: text の無い答えは直させる', () => {
    expect(checkWriteUpShape({ questions: [] })).toHaveProperty('error');
    expect(checkWriteUpShape({ text: ' ' })).toHaveProperty('error');
    expect(checkWriteUpShape({ text: 'x', questions: ['q', 3] })).toEqual({ value: { text: 'x', questions: ['q'] } });
  });
});

describe('writeUp', () => {
  it('形が崩れたら 1 回だけ直させ、答えを差し込んで返す', async () => {
    const { doc, sid } = schemeDoc();
    const answers: unknown[] = [{ nope: 1 }, { text: '{{C1}} ({{s1.C1.mg}})', questions: [] }];
    const users: string[] = [];
    const llm: LlmProvider = {
      id: 'gemini',
      generateJson: async <T,>(req: { user: string }) => {
        users.push(req.user);
        return { ok: true, value: answers.shift() as T };
      },
      listModels: async () => ({ ok: true, value: [] }),
    };
    const r = await writeUp(llm, { doc, schemeId: sid, text: '', language: 'ja' });
    expect(r.ok && r.checked.text).toBe('Boc-Ala-OH (189.2 mg)');
    expect(users).toHaveLength(2);
    expect(users[0]).toContain('LANGUAGE: Japanese');
    expect(users[1]).toContain('could not be used');
  });
});

describe('化学量論表（LLM を呼ばない）', () => {
  it('全段の表を Markdown とタブ区切りで出す', () => {
    const { doc, sid } = schemeDoc();
    const t = schemeStoichTables(doc, sid);
    expect(t.markdown).toContain('### 1 段目: Boc-Ala-OH + H-Gly-OMe → 5');
    expect(t.markdown).toContain('| 試薬 | HATU | 380.23 | 1.20 | 1.200 | 456.3 |  |');
    expect(t.markdown).toContain('条件: DMF, rt, 2 h');
    expect(t.markdown).toContain('### 2 段目: 5 → 7');
    expect(t.tsv).toContain('試薬\tHATU\t380.23');
  });
});

describe('ノート用の図（LLM を呼ばない）', () => {
  it('段ごとに、容器に足していくものを基質 → 試薬の順に縦に並べ、最後に生成物を書く', () => {
    const { doc, sid } = schemeDoc();
    const lines = schemeNotebook(doc, sid).split('\n');
    expect(lines.slice(0, 3)).toEqual(['1 段目: Boc-Ala-OH + H-Gly-OMe → 5', '容器（DMF）', '｜']);
    expect(lines).toContain('｜← Boc-Ala-OH  189.2 mg（1.00 mmol, 1 equiv）');
    expect(lines).toContain('｜← HATU  456.3 mg（1.20 mmol, 1.2 equiv）');
    expect(lines).toContain('｜← DIPEA  522.6 µL（3.00 mmol, 3 equiv）');
    expect(lines).toContain('｜  rt, 2 h');
    expect(lines).toContain('5  221.2 mg（0.85 mmol, 85%）');
    const i = lines.indexOf('2 段目: 5 → 7');
    expect(i).toBeGreaterThan(0);
    // 2 段目は TFA の当量が無く、量が出せない所は [?]
    expect(lines.slice(i)).toContain('容器（CH2Cl2）');
    expect(lines.slice(i)).toContain('｜← TFA  [?]（[?], [?]）');
    expect(lines.slice(i)).toContain('｜  0 °C, 1 h');
    expect(lines.slice(i).some((l) => l.startsWith('7  ') && l.endsWith('quant.）'))).toBe(true);
    expect(lines.indexOf('｜← Boc-Ala-OH  189.2 mg（1.00 mmol, 1 equiv）')).toBeLessThan(lines.indexOf('｜← HATU  456.3 mg（1.20 mmol, 1.2 equiv）'));
  });
});

describe('実験の記録を使って書く', () => {
  const runDoc = () => SAMPLES.find((s) => s.id === 'run')!.build();
  const sidOf = (d: ReturnType<typeof runDoc>) => Object.keys(d.schemes!)[0];

  it('記録がある段は、入れた量・得た重さ・収率を記録の値にし、記録にだけある仕込みと記録の行を足す', () => {
    const d = runDoc();
    const f = writeFacts(d, sidOf(d), true);
    const v = (k: string) => f.facts.get(k)?.value;
    expect(v('s1.C1.mg')).toBe('10 g');
    expect(v('s1.R1.mg')).toBe('12.2 g');
    // 得た重さと収率は記録から（スキームの収率 85% ではない）
    expect(v('s1.C3.mg')).toBe('11.9 g');
    expect(v('s1.yield')).toBe('86.5%');
    // 化学量論表に無い仕込み: 溶媒と洗浄液
    const extras = f.steps[0].extras!.map((e) => `${v(e)}=${v(`${e}.amount`)}`);
    expect(extras).toContain('CH2Cl2=100 mL');
    expect(extras).toContain('1 M HCl=50 g');
    expect(extras).toContain('ヘプタン=69 g');
    expect(f.steps[0].record!.length).toBe(10);
    expect(f.steps[0].record![1]).toBe('[反応] EDC·HCl を 4 回に分けて入れる; amount 12.2 g; internal temperature 2 → 6 °C; 発熱あり');
    // 時刻とロットは入れない
    const prompt = writeUpPrompt(f, '', 'en');
    expect(prompt).not.toMatch(/09:12|L-2311/);
    expect(prompt).toContain('RECORD of step 1');
    expect(prompt).toContain('[also charged]');
    // 記録を使わなければ、今までどおり化学量論表の値
    expect(writeFacts(d, sidOf(d)).facts.get('s1.C1.mg')?.value).toBe('10000.0 mg');
    expect(writeFacts(d, sidOf(d)).steps[0].record).toBeUndefined();
  });

  it('記録の行にある数字は書いてよい。記録にも指示にも無い数字は知らせる', () => {
    const d = runDoc();
    const f = writeFacts(d, sidOf(d), true);
    const base = '{{C1}} ({{s1.C1.mg}}, {{s1.C1.mmol}}), {{C2}} ({{s1.C2.mg}}) and {{s1.R2}} ({{s1.R2.mg}}) were dissolved in {{s1.M1}} ({{s1.M1.amount}}). {{s1.R1}} ({{s1.R1.mg}}) was added in 4 portions at 2 → 6 °C. ';
    const ok = fillWriteUp(f, { text: `${base}The mixture was washed with {{s1.M2}} ({{s1.M2.amount}}) to give {{C3}} ({{s1.C3.mg}}, {{s1.yield}}).`, questions: [] });
    expect(ok.issues).toEqual([]);
    expect(ok.text).toContain('CH2Cl2 (100 mL)');
    expect(ok.text).toContain('3 (11.9 g, 86.5%)');
    const bad = fillWriteUp(f, { text: `${base}After stirring for 7 h, {{C3}} ({{s1.C3.mg}}) was obtained.`, questions: [] });
    expect(bad.issues.some((i) => i.kind === 'number' && i.message.includes('「7」'))).toBe(true);
  });

  it('記録があるときだけ、記録の決まりを指示に足して送る', async () => {
    const d = runDoc();
    const seen: string[] = [];
    const llm = { id: 'gemini' as const, generateJson: async (req: { system: string }) => (seen.push(req.system), { ok: true as const, value: { text: '{{C1}} {{C2}} {{s1.R1}} {{s1.R2}} {{C3}}' } }), listModels: async () => ({ ok: true as const, value: [] }) };
    await writeUp(llm as never, { doc: d, schemeId: sidOf(d), text: '', language: 'en', useRuns: true });
    await writeUp(llm as never, { doc: d, schemeId: sidOf(d), text: '', language: 'en' });
    expect(seen[0]).toContain('Some steps have a RECORD');
    expect(seen[1]).not.toContain('Some steps have a RECORD');
  });
});

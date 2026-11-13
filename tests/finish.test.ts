import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyFinish,
  checkFinish,
  checkFinishShape,
  FINISH_SCHEMA,
  finishChanges,
  finishKey,
  finishPrompt,
  finishSchemes,
  finishTargets,
  styleOptionValue,
} from '../src/llm/finish';
import type { LlmProvider } from '../src/llm/types';
import { numberSchemesCompounds } from '../src/scheme/ops';
import { getStyle, STYLE_PRESETS } from '../src/scheme/style';
import { FINISH_CASES, finishBase } from './llm-eval/finish-score';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

// 評価の件と同じ文書: 上のスキーム（lab の書式、2 段）と下のスキーム（acs の書式、1 段）が 7 を共有する
const base = () => finishBase(FINISH_CASES[0]);
const check = (raw: unknown, targets?: string[]) => {
  const b = base();
  const shape = checkFinishShape(raw);
  if ('error' in shape) throw new Error(shape.error);
  return { b, c: checkFinish(b.doc, targets ?? b.schemeIds, shape.value) };
};

describe('範囲', () => {
  it('下書きは入れず、上から下の順に並べる。選んでいるスキームだけにもできる', () => {
    const b = base();
    const [top, bottom] = b.schemeIds;
    expect(b.doc.schemes![top].origin.y).toBeLessThan(b.doc.schemes![bottom].origin.y);
    expect(finishTargets(b.doc, 'all', null)).toEqual([top, bottom]);
    expect(finishTargets(b.doc, 'active', bottom)).toEqual([bottom]);
    expect(finishTargets(b.doc, 'active', null)).toEqual([]);
    const withDraft = { ...b.doc, schemes: { ...b.doc.schemes, [top]: { ...b.doc.schemes![top], draft: { text: '', issues: [], questions: [], model: 'm' } } } };
    expect(finishTargets(withDraft, 'all', null)).toEqual([bottom]);
  });
});

describe('送る内容', () => {
  it('範囲のスキームの段・化合物の番号と呼び名・書式の項目を送り、構造は送らない', () => {
    const b = base();
    const p = finishPrompt(b.doc, b.schemeIds, 'ACS に', { answers: [{ question: 'Q?', answer: 'はい' }], myStyles: [{ ...STYLE_PRESETS[0], id: 'my-lab', name: '研究室の投稿用' }] });
    expect(p).toContain('- scheme 1: style=lab');
    expect(p).toContain('- scheme 2: style=acs');
    expect(p).toContain('reagents=HATU (1.2 equiv) | TEA (3 equiv)');
    expect(p).toContain('temp=室温; time=2 時間');
    expect(p).toContain(`key=${b.ids.D}; number=7;`);
    expect(p).toContain('id=lab; name=研究室のメモ（呼び名・ノート番号つき）; equivFormat=({n} eq.)');
    expect(p).toContain('separator=", "');
    expect(p).toContain('id=my-lab; name=研究室の投稿用');
    expect(p).toContain('A: はい');
    expect(p).not.toMatch(/smiles|C\(=O\)/i);
    // 範囲が 1 つなら、そのスキームだけ
    expect(finishPrompt(b.doc, [b.schemeIds[1]], 'x')).not.toContain('scheme 2');
  });

  it('形には決めた操作と書式の項目だけがある', () => {
    const items = (FINISH_SCHEMA.properties as { ops: { items: { properties: { op: { enum: string[] }; option: { enum: string[] } } } } }).ops.items.properties;
    expect(items.op.enum).toEqual(['set_style', 'set_style_option', 'renumber', 'rename_reagent', 'set_condition']);
    expect(items.option.enum).toContain('equivFormat');
  });
});

describe('形と指す先の確かめ', () => {
  it('操作もできないことも質問も無ければ直させる', () => {
    expect(checkFinishShape({ ops: [] })).toEqual({ error: 'no operations, no cannot and no questions' });
    expect(checkFinishShape({})).toEqual({ error: 'ops must be an array' });
    expect(checkFinishShape({ ops: [], cannot: ['フォント'] })).toEqual({ value: { ops: [], questions: [], cannot: ['フォント'] } });
    // 書くべき項目の書き落とし（本物の Gemini が set_style_option の value を書かなかった）は、形の崩れとして直させる
    expect(checkFinishShape({ ops: [{ op: 'set_style_option', option: 'equivFormat' }] })).toEqual({ error: 'ops[0] (set_style_option) needs value' });
    expect(checkFinishShape({ ops: [{ op: 'renumber' }, { op: 'set_condition', step: 1 }] })).toEqual({ error: 'ops[1] (set_condition) needs field, value' });
  });

  it('無いスキーム・段・試薬・書式と、中身を変える操作は、理由を付けて外す', () => {
    const { c } = check({
      ops: [
        { op: 'rename_reagent', scheme: 3, step: 1, reagent: 'TEA', text: 'Et3N' },
        { op: 'rename_reagent', scheme: 1, step: 3, reagent: 'TEA', text: 'Et3N' },
        { op: 'rename_reagent', scheme: 1, step: 1, reagent: 'DIPEA', text: 'Et3N' },
        { op: 'rename_reagent', step: 1, reagent: 'TEA', text: 'Et3N' },
        { op: 'set_style', style: 'rsc' },
        { op: 'replace_reagent', step: 2, reagent: 'TFA', text: 'HCl' },
        { op: 'set_condition', scheme: 1, step: 1, field: 'yield', value: '90' },
        { op: 'set_condition', scheme: 1, step: 1, field: 'time', value: '' },
        { op: 'set_style_option', option: 'font', value: 'Arial' },
        { op: 'set_style_option', option: 'equivFormat', value: 'equiv' },
        { op: 'set_style_option', option: 'stepMarks', value: 'greek' },
        { op: 'set_style_option', option: 'boldNumber', value: 'yes' },
        { op: 'draw' },
      ],
    });
    expect(c.ops).toEqual([]);
    expect(c.rejected).toEqual([
      'rename_reagent: スキーム 3がありません（範囲のスキームは 2 つ）',
      'rename_reagent: スキーム 1 に 3 段目がありません（2 段）',
      'rename_reagent: スキーム 1 の 1 段目に試薬「DIPEA」がありません',
      'rename_reagent: スキームの指定がありません（範囲のスキームは 2 つ）',
      'set_style: 書式「rsc」がありません',
      'replace_reagent: 仕上げでは、試薬の足し・外し・入れ替え、収率、構造、呼び名は変えません。直すときは「直す」を使ってください',
      'set_condition: 仕上げでは収率は変えません（収率の書き方は書式で直します）',
      'set_condition: スキーム 1 の 1 段目の時間を消す指示は、仕上げでは使えません',
      'set_style_option: 書式の項目「font」は直せません',
      'set_style_option: 当量の書き方: {n} を含む短い書き方にしてください（「equiv」）',
      'set_style_option: 段の記号: alpha・roman・number のどれかにしてください（「greek」）',
      'set_style_option: 番号の太字: true か false にしてください（「yes」）',
      '知らない操作「draw」は使えません',
    ]);
  });

  it('範囲が 1 つなら、スキームの番号は無くてよい。書き方を直した試薬を続けて直せる', () => {
    const b = base();
    const shape = checkFinishShape({
      ops: [
        { op: 'rename_reagent', step: 1, reagent: 'TEA (3 equiv)', text: 'NEt3' },
        { op: 'rename_reagent', step: 1, reagent: 'NEt3', text: 'Et3N' },
      ],
    });
    if ('error' in shape) throw new Error(shape.error);
    const c = checkFinish(b.doc, [b.schemeIds[0]], shape.value);
    expect(c.rejected).toEqual([]);
    expect(c.ops).toHaveLength(2);
  });

  it('書式の項目の値は、決めた形だけを受け付ける', () => {
    expect(styleOptionValue('equivFormat', '({n} equiv)')).toEqual({ value: '({n} equiv)' });
    expect(styleOptionValue('yieldFormat', '{y}%')).toEqual({ value: '{y}%' });
    expect(styleOptionValue('showNickname', false)).toEqual({ value: false });
    expect(styleOptionValue('boldNumber', 'true')).toEqual({ value: true });
    expect(styleOptionValue('separator', '; ')).toEqual({ value: '; ' });
    expect('error' in styleOptionValue('separator', '')).toBe(true);
    expect('error' in styleOptionValue('yieldPosition', 'above')).toBe(true);
  });

  it('選んだスキームだけの番号の振り直しで、範囲の外にも出てくる化合物があれば要確認', () => {
    const { b, c } = check({ ops: [{ op: 'renumber', start: 1 }] }, undefined);
    expect(c.warnings).toEqual([]);
    const shape = checkFinishShape({ ops: [{ op: 'renumber' }] });
    if ('error' in shape) throw new Error(shape.error);
    expect(checkFinish(b.doc, [b.schemeIds[0]], shape.value).warnings).toEqual(['範囲の外の 1 つのスキームにも出てくる化合物があり、そちらの番号も変わります']);
  });

  it('範囲の外の化合物と新しい番号が重なれば要確認。もとが空の条件に書き足すのも要確認', () => {
    const b = base();
    const shape = checkFinishShape({ ops: [{ op: 'renumber', start: 4 }] });
    if ('error' in shape) throw new Error(shape.error);
    // 下だけを 4 から: D・E・F が 4, 5, 6。上だけの C（5）と重なる
    expect(checkFinish(b.doc, [b.schemeIds[1]], shape.value).warnings).toContain('範囲の外の化合物と番号が重なります（5）。番号を確かめてください');
    const doc = { ...b.doc, schemes: { ...b.doc.schemes, [b.schemeIds[0]]: { ...b.doc.schemes![b.schemeIds[0]], steps: b.doc.schemes![b.schemeIds[0]].steps.map((st, i) => (i === 1 ? { ...st, time: undefined } : st)) } } };
    const s2 = checkFinishShape({ ops: [{ op: 'set_condition', scheme: 1, step: 2, field: 'time', value: '1 h' }] });
    if ('error' in s2) throw new Error(s2.error);
    expect(checkFinish(doc, b.schemeIds, s2.value).warnings).toEqual(['スキーム 1 の 2 段目の時間はもとは空でした。書き足した「1 h」を確かめてください']);
  });
});

describe('当てる', () => {
  it('書き方の直しと番号の振り直しを、元の文書を変えずに当てる。当量は残る', () => {
    const { b, c } = check({
      ops: [
        { op: 'rename_reagent', scheme: 1, step: 1, reagent: 'TEA', text: 'Et3N' },
        { op: 'set_condition', scheme: 1, step: 1, field: 'temp', value: 'rt' },
        { op: 'set_condition', scheme: 2, step: 1, field: 'time', value: '16 h' },
        { op: 'renumber', start: 1, prefix: 'S' },
      ],
    });
    const before = JSON.stringify(b.doc);
    const after = applyFinish(b.doc, b.schemeIds, c.ops);
    expect(JSON.stringify(b.doc)).toBe(before);
    const [s1, s2] = b.schemeIds.map((id) => after.schemes![id]);
    expect(s1.steps[0].reagents).toEqual([{ text: 'HATU', equiv: 1.2 }, { text: 'Et3N', equiv: 3 }]);
    expect(s1.steps[0].temp).toBe('rt');
    expect(s2.steps[0].time).toBe('16 h');
    expect(['A', 'B', 'C', 'D', 'E', 'F'].map((r) => after.compounds![b.ids[r]].number)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('書式を選ぶと範囲のすべてのスキームに当て、項目を直すときは元の書式ごとに写しを作って共有する', () => {
    const b = base();
    const { c } = check({ ops: [{ op: 'set_style', style: 'footnote' }] });
    const a1 = applyFinish(b.doc, b.schemeIds, c.ops);
    expect(b.schemeIds.map((id) => a1.schemes![id].styleId)).toEqual(['footnote', 'footnote']);
    expect(a1.styles ?? {}).toEqual({});

    // 項目だけ: 今の書式（lab と acs）の写しを、それぞれ 1 つ作る。プリセットは変えない
    const { c: c2 } = check({ ops: [{ op: 'set_style_option', option: 'equivFormat', value: '({n} equiv)' }] });
    const a2 = applyFinish(b.doc, b.schemeIds, c2.ops);
    const [x1, x2] = b.schemeIds.map((id) => getStyle(a2.schemes![id].styleId, a2.styles));
    expect([x1.id, x2.id]).toEqual(['finish-1', 'finish-2']);
    expect([x1.name, x2.name]).toEqual(['研究室のメモ（仕上げ）', 'ACS（仕上げ）']);
    expect([x1.equivFormat, x2.equivFormat]).toEqual(['({n} equiv)', '({n} equiv)']);
    expect(x1.showNickname).toBe(true);
    expect(getStyle('acs').equivFormat).toBe('{n} equiv');

    // 書式と項目: 同じ元からの写しを 1 つだけ作って共有する。元の書式と同じ値の項目では写しを作らない
    const { c: c3 } = check({ ops: [{ op: 'set_style', style: 'acs' }, { op: 'set_style_option', option: 'stepMarks', value: 'roman' }, { op: 'set_style_option', option: 'equivFormat', value: '{n} equiv' }] });
    const a3 = applyFinish(b.doc, b.schemeIds, c3.ops);
    expect(b.schemeIds.map((id) => a3.schemes![id].styleId)).toEqual(['finish-1', 'finish-1']);
    expect(Object.keys(a3.styles!)).toEqual(['finish-1']);
    const { c: c4 } = check({ ops: [{ op: 'set_style', style: 'acs' }, { op: 'set_style_option', option: 'equivFormat', value: '{n} equiv' }] });
    const a4 = applyFinish(b.doc, b.schemeIds, c4.ops);
    expect(b.schemeIds.map((id) => a4.schemes![id].styleId)).toEqual(['acs', 'acs']);
  });

  it('自分のテンプレートを選んだら、文書に入れて使う', () => {
    const b = base();
    const mine = { ...STYLE_PRESETS[1], id: 'my-journal', name: '投稿用' };
    const shape = checkFinishShape({ ops: [{ op: 'set_style', style: 'my-journal' }] });
    if ('error' in shape) throw new Error(shape.error);
    const c = checkFinish(b.doc, b.schemeIds, shape.value, { myStyles: [mine] });
    expect(c.rejected).toEqual([]);
    const after = applyFinish(b.doc, b.schemeIds, c.ops, [mine]);
    expect(after.styles!['my-journal'].name).toBe('投稿用');
    expect(b.schemeIds.map((id) => after.schemes![id].styleId)).toEqual(['my-journal', 'my-journal']);
  });

  it('numberSchemesCompounds: 共有する化合物は 1 つの番号で、使うスキームをすべて描き直す', () => {
    const b = base();
    const after = numberSchemesCompounds(b.doc, [b.schemeIds[1]], 10);
    expect(['D', 'E', 'F'].map((r) => after.compounds![b.ids[r]].number)).toEqual(['10', '11', '12']);
    expect(after.compounds![b.ids.C].number).toBe('5');
    // 上のスキームの図にも、7 でなく 10 が描かれる
    const labels = (doc: typeof after) => Object.values(doc.texts ?? {}).filter((t) => t.ref?.startsWith(b.schemeIds[0])).map((t) => t.text);
    expect(labels(b.doc).join(' ')).toContain('7');
    expect(labels(after).join(' ')).toContain('10');
    expect(numberSchemesCompounds(b.doc, [])).toBe(b.doc);
  });
});

describe('差の一覧', () => {
  it('スキームごとに書式の名前と項目・段の差を出し、番号は文書全体で 1 行', () => {
    const { b, c } = check({
      ops: [
        { op: 'set_style', style: 'acs' },
        { op: 'set_style_option', option: 'stepMarks', value: 'roman' },
        { op: 'set_condition', scheme: 1, step: 2, field: 'temp', value: 'rt' },
        { op: 'renumber', start: 1 },
      ],
    });
    const after = applyFinish(b.doc, b.schemeIds, c.ops);
    const g = finishChanges(b.doc, after, b.schemeIds);
    expect(g.map((x) => x.title)).toEqual(['スキーム 1', 'スキーム 2', '文書全体']);
    expect(g[0].changes).toContain('書式: 研究室のメモ（呼び名・ノート番号つき） → ACS（仕上げ）');
    expect(g[0].changes).toContain('当量の書き方: ({n} eq.) → {n} equiv');
    expect(g[0].changes).toContain('段の記号: a, b, c → i, ii, iii');
    expect(g[0].changes).toContain('呼び名を出す: する → しない');
    expect(g[0].changes).toContain('2 段目の温度: 室温 → rt');
    expect(g[1].changes).toEqual(['書式: ACS（条件を矢印の上下） → ACS（仕上げ）', '段の記号: a, b, c → i, ii, iii']);
    expect(g[2].changes).toEqual(['化合物番号: （なし） → 1, （なし） → 2, 5 → 3, 7 → 4, （なし） → 5, 12 → 6']);
    expect(finishChanges(b.doc, b.doc, b.schemeIds)).toEqual([]);
  });

  it('作った後にスキーム・化合物・書式が変われば、鍵が変わる', () => {
    const b = base();
    const k = finishKey(b.doc, b.schemeIds);
    const after = applyFinish(b.doc, b.schemeIds, [{ op: 'renumber', start: 1, prefix: '' }]);
    expect(finishKey(after, b.schemeIds)).not.toBe(k);
    expect(finishKey(b.doc, b.schemeIds)).toBe(k);
  });
});

describe('まとめて', () => {
  it('形が崩れていれば 1 回だけ直させ、確かめた操作とできないことを返す', async () => {
    const b = base();
    const generateJson = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { ops: [] } })
      .mockResolvedValueOnce({ ok: true, value: { ops: [{ op: 'set_style', style: 'acs' }], cannot: ['フォントは直せません'] }, usage: { input: 10, output: 5 } });
    const llm = { id: 'gemini', generateJson, listModels: vi.fn() } as unknown as LlmProvider;
    const r = await finishSchemes(llm, { doc: b.doc, schemeIds: b.schemeIds, text: 'ACS に。フォントは Arial' });
    expect(r.ok && r.checked).toEqual({ ops: [{ op: 'set_style', styleId: 'acs' }], rejected: [], warnings: [], cannot: ['フォントは直せません'], questions: [] });
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(generateJson.mock.calls[1][0].user).toContain('could not be used (no operations, no cannot and no questions)');
  });
});

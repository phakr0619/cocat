// PDF の文字の行・段落分けと、化合物番号の段落探し
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  collectText,
  collectedText,
  headingOf,
  isNumberLabel,
  joinLines,
  linesOf,
  mentions,
  normalizeLabel,
  paragraphsOf,
  procedureRefs,
  sameLabel,
  sectionsOf,
  stereoLabel,
  toItems,
  type PdfTextItem,
  type TextLine,
} from '../src/llm/pdfText';

/** 文字の項目を作る（幅は 1 文字 0.5×大きさで見積もる） */
const item = (str: string, x: number, y: number, h = 10): PdfTextItem => ({ str, x, y, h, w: str.length * h * 0.5 });
const line = (text: string, y: number, page = 1, size = 10): TextLine => ({ page, y, x: 50, size, text });

describe('行', () => {
  it('上付き（文献番号・¹H）は「^」を付け、化合物番号にくっつけない。下付きはそのまま', () => {
    const items = [item('To a solution of 15', 50, 700), item('3', 147, 704, 6), item(' (22 mg) in CH', 152, 700), item('2', 222, 697, 6), item('Cl', 226, 700), item('2', 236, 697, 6)];
    const [l] = linesOf(items, 1, 600);
    expect(l.text).toBe('To a solution of 15^3 (22 mg) in CH2Cl2');
  });

  it('2 段組みは、左の段を読み終えてから右の段を読む。ページの真ん中をまたぐ空きで行を分ける', () => {
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(item(`left line ${i} text text`, 50, 700 - i * 12));
      items.push(item(`right line ${i} text text`, 310, 700 - i * 12));
    }
    const lines = linesOf(items, 1, 600);
    expect(lines.map((l) => l.text).slice(0, 2)).toEqual(['left line 0 text text', 'left line 1 text text']);
    expect(lines[10].text).toBe('right line 0 text text');
    expect(toItems([{ str: 'a', transform: [10, 0, 0, 10, 5, 6], width: 3, height: 10 }, { foo: 1 }])).toEqual([{ str: 'a', x: 5, y: 6, w: 3, h: 10 }]);
  });

  it('段落は行の間で分け、行末のハイフンは英小文字どうしのときだけ取る', () => {
    const lines = [line('The product was carbox-', 700), line('ylated to give (S)-2-methyl-', 688), line('pent-4-en-1-ol and 4-', 676), line('5 more.', 664), line('Next paragraph.', 630)];
    const pars = paragraphsOf(lines);
    expect(pars).toHaveLength(2);
    // 「methyl-」＋「pent-4-en」は 2-methylpent-4-en-1-ol（系統名にハイフンは無い）。数字の前のハイフンは残す
    expect(joinLines(pars[0])).toBe('The product was carboxylated to give (S)-2-methylpent-4-en-1-ol and 4-5 more.');
  });
});

describe('見出し', () => {
  it.each([
    ['(R)-Hex-5-en-2-ol ((R)-4) (CAS 17397-29-4) [1,2]', '4', '(R)-4', '(R)-Hex-5-en-2-ol'],
    ['Diethyl (S)-2-(hex-5-en-2-yl)malonate ((S)-6) (new compound) [4,5]', '6', '(S)-6', 'Diethyl (S)-2-(hex-5-en-2-yl)malonate'],
    ['(4R,8R)-4,8-Dimethyldecanal ((4R,8R)-1) (CAS 85880-35-9) [10]', '1', '(4R,8R)-1', '(4R,8R)-4,8-Dimethyldecanal'],
    ['tert-Butyl 4-oxopiperidine-1-carboxylate (3a).', '3a', '3a', 'tert-Butyl 4-oxopiperidine-1-carboxylate'],
    ['Synthesis of compound 17: To a solution of 11 (3.0 g) in DCM', '17', '17', ''],
    ['Compound S2', 'S2', 'S2', ''],
    ['Compound 12: To a vial', '12', '12', ''],
  ])('%s → %s', (text, label, full, name) => {
    expect(headingOf(text)).toEqual({ kind: 'compound', label, fullLabel: full, name });
  });

  it('手順の見出しと、見出しでないもの', () => {
    expect(headingOf('General procedure A for the coupling')).toMatchObject({ kind: 'procedure', label: 'A' });
    expect(headingOf('General Procedure (GP-2): To a vial')).toMatchObject({ kind: 'procedure', label: '2' });
    expect(headingOf('General methods and materials All the reactions')).toBeNull();
    expect(headingOf('Figure S25. Difference NOE spectrum of 14 (H18)')).toBeNull();
    expect(headingOf('The mixture was stirred to afford the ester (5)')).toBeNull();
    expect(headingOf('Compound 9 was also mentioned here.')).toBeNull();
    expect(headingOf('4. 1H and 13C NMR spectra of the products Figure S1: 1H NMR Spectrum of (R)-hex-5-en-2-ol ((R)-4)')).toBeNull();
    expect(procedureRefs('Prepared according to general procedure B. Also GP-3 and General Method (C).').sort()).toEqual(['3', 'B', 'C']);
  });

  it('番号のならしと、立体の前置きのある番号の比べ方（(R)-4 と (S)-4 は別の化合物）', () => {
    expect(normalizeLabel('(4R,8R)-1')).toBe('1');
    expect(normalizeLabel('compound 4’')).toBe("4'");
    expect(stereoLabel('((R)-4)')).toBe('(R)-4');
    expect(stereoLabel('(±)-12')).toBe('(±)-12');
    expect(sameLabel('(R)-4', { label: '4', fullLabel: '(R)-4' })).toBe(true);
    expect(sameLabel('(S)-4', { label: '4', fullLabel: '(R)-4' })).toBe(false);
    expect(sameLabel('4', { label: '4', fullLabel: '(R)-4' })).toBe(true);
    expect(mentions('treated with 4 (1.2 equiv)', '4')).toBe(true);
    expect(mentions('4.83 g of 14 and 24', '4')).toBe(false);
    expect(mentions('of 15^3 (22 mg)', '3')).toBe(false);
  });
});

describe('送る文字を集める', () => {
  const si = [
    line('General procedure A', 700),
    line('To a solution of the amine in DCM was added HATU.', 688),
    line('(S)-2-Aminopropanoic acid ((S)-2)', 650),
    line('Prepared following general procedure A in 85% yield.', 638),
    line('Methyl ester (3)', 600),
    line('To a solution of 2 in MeOH was added SOCl2 (92%).', 588),
    line('Compound 9 was also mentioned here.', 550),
  ];

  it('番号の無い図: 呼び名が見出しの名前と同じなら、その段落を集める。番号らしいかを見分ける', () => {
    expect(['3', '4a', 'S12', "15'", '(R)-4', '(4R,8R)-1'].every(isNumberLabel)).toBe(true);
    expect(['Boc-Ala-OH', 'PhCHO', 'MeMgBr', 'saframycin A'].some(isNumberLabel)).toBe(false);
    const sections = sectionsOf(si, 'SI');
    const paragraphs = paragraphsOf(si).map((p) => ({ page: p[0].page, text: joinLines(p) }));
    const c = collectText({ docs: [{ source: 'SI', sections, paragraphs }], products: ['methyl ester'], others: [] });
    expect(c.parts.map((p) => `${p.why}:${p.label}`)).toEqual(['compound:3']);
    expect(c.missing).toEqual([]);
  });

  it('図の番号の段落と、それが触れている手順の段落を集める。見出しが無い番号は、出てくる段落を使う。見出しの無い生成物は、見つからない番号として返す（基質は返さない）', () => {
    const sections = sectionsOf(si, 'SI');
    expect(sections.map((s) => `${s.kind}:${s.fullLabel}`)).toEqual(['procedure:A', 'compound:(S)-2', 'compound:3']);
    const paragraphs = paragraphsOf(si).map((p) => ({ page: p[0].page, text: joinLines(p) }));
    const c = collectText({ figurePage: { source: '本文', page: 3, lines: [line('Scheme 1: synthesis of 3.', 700)] }, docs: [{ source: 'SI', sections, paragraphs }], products: ['3'], others: ['(S)-2', '9', '42'] });
    expect(c.parts.map((p) => `${p.why}:${p.label ?? ''}`)).toEqual(['figure-page:', 'compound:3', 'compound:(S)-2', 'procedure:A', 'mention:9']);
    expect(c.missing).toEqual([]);
    // 生成物 9 は、触れている段落はあっても、手順の見出しが無いので知らせる
    expect(collectText({ docs: [{ source: 'SI', sections, paragraphs }], products: ['3', '9', '42'], others: [] }).missing).toEqual(['9', '42']);
    const text = collectedText(c);
    expect(text).toContain('[本文 p.3 — page with the figure]');
    expect(text).toContain('[SI p.1 — compound 3]');
    expect(text).toContain('[SI p.1 — general procedure A]');
  });

  it('上限を超えたら、図のページ → 生成物 → ほかの化合物 → 手順 → 説明の段落の順に残す', () => {
    const sections = sectionsOf(si, 'SI');
    const len3 = sections.find((s) => s.label === '3')!.text.length;
    const c = collectText({ docs: [{ source: 'SI', sections, paragraphs: [] }], products: ['3'], others: ['2'] }, len3 + 5);
    expect(c.parts.map((p) => p.label)).toEqual(['3']);
    expect(c.dropped.map((p) => p.label)).toEqual(['(S)-2', 'A']);
  });
});

// 実際の論文（npm run fetch:real-papers で取ってくる。リポジトリには入れない）
const DIR = 'tests/llm-eval/real-papers';
const has = (id: string) => existsSync(`${DIR}/${id}-S1.pdf`);

async function siSections(id: string) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`${DIR}/${id}-S1.pdf`)), verbosity: 0 }).promise;
  const lines: TextLine[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    lines.push(...linesOf(toItems((await pg.getTextContent()).items), n, pg.getViewport({ scale: 1 }).width));
  }
  return sectionsOf(lines, 'SI');
}

describe.skipIf(!has('bjoc-21-38'))('実際の論文の SI', () => {
  it('BJOC 2025, 21, 38: 「系統名 ((R)-4)」の見出しを 20 個、立体ごとに別の化合物として見つける', async () => {
    const s = (await siSections('bjoc-21-38')).filter((x) => x.kind === 'compound');
    expect(s).toHaveLength(20);
    expect(s.map((x) => x.fullLabel)).toEqual(expect.arrayContaining(['(R)-4', '(S)-4', '(S)-6', '(5R,9R)-12', '(4R,8R)-1', '(4S,8S)-1']));
    expect(s.find((x) => x.fullLabel === '(R)-4')!.name).toBe('(R)-Hex-5-en-2-ol');
    expect(s.find((x) => x.fullLabel === '(4R,8R)-1')!.name).toBe('(4R,8R)-4,8-Dimethyldecanal');
    expect(s.find((x) => x.fullLabel === '(4R,8R)-1')!.text).toContain('NaIO4');
  }, 60000);

  it('BJOC 2025, 21, 47: 「Synthesis of compound 17:」の見出しを 7 個見つける', async () => {
    const s = await siSections('bjoc-21-47');
    expect(s.map((x) => x.fullLabel)).toEqual(['17', '18', '16', '19', '20', '14', '15']);
    expect(s[0].text).toMatch(/MOMCl.*89%/s);
  }, 60000);

  it('BJOC 2025, 21, 14: 「Compound S2」の見出しを見つけ、文献番号の上付きを化合物番号にくっつけない', async () => {
    const s = await siSections('bjoc-21-14');
    expect(s.map((x) => x.fullLabel)).toEqual(['S2', 'S3', '8', '10', '16', '11', '18', '14']);
    expect(s[0].text).toContain('15^3');
  }, 60000);
});

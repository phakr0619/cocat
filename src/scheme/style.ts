// スキームの書式テンプレート。同じデータから、雑誌や研究室ごとの見た目を作る
import type { Reagent, Step } from './model';

export type ConditionField = 'reagents' | 'solvent' | 'temp' | 'time';

export interface SchemeStyle {
  id: string;
  name: string;
  /** 条件を矢印の上下に書くか、段の記号だけ矢印に書いて下に脚注でまとめるか */
  conditions: 'on-arrow' | 'footnote';
  above: ConditionField[];
  below: ConditionField[];
  /** 当量の書き方。{n} が数になる（「{n} equiv」「({n} eq.)」） */
  equivFormat: string;
  /** 収率の書き方。{y} が数になる（「{y}%」「({y}%)」） */
  yieldFormat: string;
  /** 収率を置く場所: 矢印の下 / 生成物の番号の横 / 書かない */
  yieldPosition: 'below-arrow' | 'after-label' | 'none';
  /** ノート番号を矢印の下に書くか */
  showNotebook: boolean;
  /** 番号が無い化合物は呼び名を出すか */
  showNickname: boolean;
  /** 化合物番号を太字にするか */
  boldNumber: boolean;
  /** 段の記号（脚注の形のとき）: a, b, c / i, ii, iii / 1, 2, 3 */
  stepMarks: 'alpha' | 'roman' | 'number';
  /** 1行の幅の上限（pt）。超えたら次の行へ折り返す */
  maxRowWidth: number;
  /** 行の折り返し位置: 矢印の後・化合物（＋でつないだまとまり）の後。どちらか 1 つは true。無ければ化合物の後だけ */
  wrapAt?: { arrow: boolean; compound: boolean };
  /** 矢印の最小の長さ（pt） */
  minArrow: number;
  /** 矢印の上下の文字の1行の幅の上限（pt）。超えたら区切りで折り返す */
  maxConditionWidth: number;
  /** 区切り */
  separator: string;
}

export const STYLE_PRESETS: SchemeStyle[] = [
  {
    id: 'acs',
    name: 'ACS（条件を矢印の上下）',
    conditions: 'on-arrow',
    above: ['reagents'],
    below: ['solvent', 'temp', 'time'],
    equivFormat: '{n} equiv',
    yieldFormat: '{y}%',
    yieldPosition: 'below-arrow',
    showNotebook: false,
    showNickname: false,
    boldNumber: true,
    stepMarks: 'alpha',
    maxRowWidth: 500,
    minArrow: 43.2,
    maxConditionWidth: 120,
    separator: ', ',
  },
  {
    id: 'footnote',
    name: '脚注（Reagents and conditions）',
    conditions: 'footnote',
    above: [],
    below: [],
    equivFormat: '{n} equiv',
    yieldFormat: '{y}%',
    yieldPosition: 'below-arrow',
    showNotebook: false,
    showNickname: false,
    boldNumber: true,
    stepMarks: 'alpha',
    maxRowWidth: 500,
    minArrow: 36,
    maxConditionWidth: 120,
    separator: ', ',
  },
  {
    id: 'lab',
    name: '研究室のメモ（呼び名・ノート番号つき）',
    conditions: 'on-arrow',
    above: ['reagents'],
    below: ['solvent', 'temp', 'time'],
    equivFormat: '({n} eq.)',
    yieldFormat: '({y}%)',
    yieldPosition: 'after-label',
    showNotebook: true,
    showNickname: true,
    boldNumber: true,
    stepMarks: 'alpha',
    maxRowWidth: 640,
    minArrow: 43.2,
    maxConditionWidth: 140,
    separator: ', ',
  },
];

/** 書式を探す。文書の書式（利用者が直したもの）を先に見る */
export function getStyle(id: string, docStyles?: Record<string, SchemeStyle>): SchemeStyle {
  return docStyles?.[id] ?? STYLE_PRESETS.find((s) => s.id === id) ?? STYLE_PRESETS[0];
}

/** 行の折り返し位置（古い書式は、化合物の後だけ） */
export function wrapAtOf(style: Pick<SchemeStyle, 'wrapAt'>): { arrow: boolean; compound: boolean } {
  const w = style.wrapAt;
  return w && (w.arrow || w.compound) ? { arrow: !!w.arrow, compound: !!w.compound } : { arrow: false, compound: true };
}

/** 足りない項目をプリセットで補う（古い・手で書いた書式でも描けるように） */
export function normalizeStyle(s: Partial<SchemeStyle> & { id: string; name: string }): SchemeStyle {
  return { ...STYLE_PRESETS[0], ...s };
}

// ---------------------------------------------------------------- 自分のテンプレート（ブラウザに保存）

const MY_STYLES_KEY = 'ai-chem-editor:styles';

export function loadMyStyles(): SchemeStyle[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MY_STYLES_KEY) ?? '[]') as SchemeStyle[];
    return Array.isArray(raw) ? raw.filter((x) => x && x.id && x.name).map(normalizeStyle) : [];
  } catch {
    return [];
  }
}

export function saveMyStyle(style: SchemeStyle): SchemeStyle[] {
  const list = loadMyStyles().filter((s) => s.id !== style.id);
  list.push(style);
  try {
    localStorage.setItem(MY_STYLES_KEY, JSON.stringify(list));
  } catch {
    // 保存できない環境では、文書の中の書式だけが残る
  }
  return list;
}

export function deleteMyStyle(id: string): SchemeStyle[] {
  const list = loadMyStyles().filter((s) => s.id !== id);
  try {
    localStorage.setItem(MY_STYLES_KEY, JSON.stringify(list));
  } catch {
    // 同上
  }
  return list;
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export function reagentText(r: Reagent, style: SchemeStyle): string {
  if (r.equiv === undefined || r.equiv === null || Number.isNaN(r.equiv)) return r.text;
  return `${r.text} ${style.equivFormat.replace('{n}', num(r.equiv))}`;
}

export function yieldText(y: Step['yield'], style: SchemeStyle): string {
  if (y === undefined || y === null || y === '') return '';
  // 「quant.」のような文字の収率には % を付けない
  if (typeof y === 'string' && !/^\d/.test(y.trim())) return style.yieldFormat.replace('{y}%', y.trim()).replace('{y}', y.trim());
  return style.yieldFormat.replace('{y}', typeof y === 'number' ? num(y) : y.trim().replace(/%$/, ''));
}

function field(step: Step, f: ConditionField, style: SchemeStyle): string[] {
  switch (f) {
    case 'reagents':
      return step.reagents.filter((r) => r.text.trim()).map((r) => reagentText(r, style));
    case 'solvent':
      return step.solvent ? [step.solvent] : [];
    case 'temp':
      return step.temp ? [step.temp] : [];
    case 'time':
      return step.time ? [step.time] : [];
  }
}

/** 矢印の上・下に書く文字。measure で測って、幅の上限を超えたら区切りで折り返す */
export function arrowTexts(step: Step, style: SchemeStyle, measure: (t: string) => number = (t) => t.length * 5): { above: string[]; below: string[] } {
  const wrap = (parts: string[]) => {
    const lines: string[] = [];
    for (const p of parts) {
      const cur = lines.at(-1);
      if (cur !== undefined && measure(cur + style.separator + p) <= style.maxConditionWidth) lines[lines.length - 1] = cur + style.separator + p;
      else lines.push(p);
    }
    return lines;
  };
  const above = wrap(style.above.flatMap((f) => field(step, f, style)));
  const below = wrap(style.below.flatMap((f) => field(step, f, style)));
  if (style.yieldPosition === 'below-arrow') {
    const y = yieldText(step.yield, style);
    if (y) below.push(y);
  }
  if (style.showNotebook && step.notebook) below.push(step.notebook);
  return { above, below };
}

export function stepMark(i: number, style: SchemeStyle): string {
  if (style.stepMarks === 'number') return String(i + 1);
  if (style.stepMarks === 'roman') return ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'][i] ?? String(i + 1);
  return String.fromCharCode(97 + (i % 26));
}

/** 脚注の1段ぶん（「(a) TFA, CH2Cl2, rt, 2 h, 95%」） */
export function footnoteText(step: Step, i: number, style: SchemeStyle): string {
  const parts = (['reagents', 'solvent', 'temp', 'time'] as ConditionField[]).flatMap((f) => field(step, f, style));
  const y = style.yieldPosition !== 'none' ? yieldText(step.yield, style) : '';
  if (y) parts.push(y);
  // 「0 °C」を折り返しで分けない
  return `(${stepMark(i, style)}) ${parts.join(style.separator)}`.replace(/ °C/g, '\u00a0°C');
}

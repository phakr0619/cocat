// 検討表のデータ: 行が試行（entry）、列が条件と結果。
import type { Structure } from '../scheme/model';

/**
 * 列の種類。書き出しと、反応式への写し方・描き方が変わる
 * - entry: 行の番号（自動で 1, 2, 3…）
 * - reagent: 試薬（「TFA (10 equiv)」。化学式の書き方で描く）
 * - solvent / temp / time / yield: 反応の条件と結果（行から反応式を作るときに写す）
 * - structure: 置換基。「*」つきの SMILES なら構造を描き、それ以外は化学式の書き方の文字
 * - text / number / workup / purification / ratio / note: そのまま描く
 */
export type ColumnKind =
  | 'entry' | 'reagent' | 'solvent' | 'temp' | 'time' | 'yield' | 'ratio' | 'workup' | 'purification' | 'structure' | 'number' | 'text' | 'note';

export interface Column {
  id: string;
  kind: ColumnKind;
  /** 見出し（「yield」「R1」） */
  label: string;
  /** 単位（「%」「°C」「h」）。見出しは「yield (%)」になり、数だけの値を反応式へ写すときに付ける */
  unit?: string;
  /** 見出しに付ける注の記号（「a」なら表の下の注 a を指す） */
  mark?: string;
}

export interface Row {
  id: string;
  cells: Record<string, string>;
}

export interface StudyTable {
  id: string;
  /** 「Table 1」の後に続ける題（「Optimization of the Deprotection」） */
  title?: string;
  /** 表の番号（「1」）。空なら「Table」だけ */
  number?: string;
  columns: Column[];
  rows: Row[];
  /** 表の下の注（「Isolated yield.」）。a, b, c… の記号を付けて並べる */
  notes: string[];
  /** 表の上に描く共通の反応式（スキームの id）。条件検討型で使う */
  schemeId?: string;
  /** 表の上に描く母核（R1・R2 を持つ構造）。SAR 型で使う */
  core?: Structure;
  /** 表の左上（pt）。反応式があるときは、反応式の置き場所に合わせて動く */
  origin: { x: number; y: number };
}

export interface TableTemplate {
  id: 'conditions' | 'sar';
  name: string;
  columns: Omit<Column, 'id'>[];
  notes: string[];
  rows: number;
}

/** 表のひな形（条件検討型と SAR 型） */
export const TABLE_TEMPLATES: TableTemplate[] = [
  {
    id: 'conditions',
    name: '条件検討',
    columns: [
      { kind: 'entry', label: 'entry' },
      { kind: 'reagent', label: 'reagent', unit: 'equiv' },
      { kind: 'solvent', label: 'solvent' },
      { kind: 'temp', label: 'temp', unit: '°C' },
      { kind: 'time', label: 'time', unit: 'h' },
      { kind: 'workup', label: 'workup' },
      { kind: 'purification', label: 'purification' },
      { kind: 'yield', label: 'yield', unit: '%', mark: 'a' },
    ],
    notes: ['Isolated yield.'],
    rows: 3,
  },
  {
    id: 'sar',
    name: 'SAR',
    columns: [
      { kind: 'entry', label: 'entry' },
      { kind: 'text', label: 'compd' },
      { kind: 'structure', label: 'R1' },
      { kind: 'structure', label: 'R2' },
      { kind: 'number', label: 'IC50', unit: 'nM' },
    ],
    notes: [],
    rows: 3,
  },
];

export const COLUMN_KINDS: { kind: ColumnKind; name: string; label: string; unit?: string }[] = [
  { kind: 'reagent', name: '試薬（当量）', label: 'reagent', unit: 'equiv' },
  { kind: 'solvent', name: '溶媒', label: 'solvent' },
  { kind: 'temp', name: '温度', label: 'temp', unit: '°C' },
  { kind: 'time', name: '時間', label: 'time', unit: 'h' },
  { kind: 'workup', name: '後処理', label: 'workup' },
  { kind: 'purification', name: '精製', label: 'purification' },
  { kind: 'yield', name: '収率', label: 'yield', unit: '%' },
  { kind: 'ratio', name: '比', label: 'dr' },
  { kind: 'structure', name: '置換基（構造）', label: 'R' },
  { kind: 'number', name: '数', label: 'value' },
  { kind: 'text', name: '文字', label: 'text' },
  { kind: 'note', name: 'メモ', label: 'note' },
  { kind: 'entry', name: '行の番号', label: 'entry' },
];

// q には上付きの文字が無いので、そのまま
const SUP: Record<string, string> = Object.fromEntries([...'abcdefghijklmnoprstuvwxyz'].map((ch, i) => [ch, [...'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ'][i]]));
/** 注の記号を上付きの文字にする（a → ᵃ） */
export const supMark = (m: string): string => [...m].map((ch) => SUP[ch] ?? ch).join('');

/** 見出し: 「yield (%)ᵃ」 */
export const headerText = (c: Column): string => `${c.label}${c.unit ? ` (${c.unit})` : ''}${c.mark ? supMark(c.mark) : ''}`;

/**
 * セルの終わりの注の記号（「85^b」「rt^a,c」）を分ける。記号は表の下の注 a, b, c… を指す。
 * 記号の無いセルは、そのまま
 */
export function splitCellMarks(v: string): { text: string; marks: string[] } {
  const m = v.match(/^(.*?)\s*\^\s*([a-z](?:\s*,\s*[a-z])*)\s*$/s);
  return m ? { text: m[1], marks: m[2].split(',').map((x) => x.trim()) } : { text: v, marks: [] };
}

/** セルの表示（entry は行の番号）。注の記号は上付きにする（「85^b」→「85ᵇ」） */
export function cellText(t: StudyTable, rowIndex: number, c: Column): string {
  const { text, marks } = splitCellMarks(t.rows[rowIndex]?.cells[c.id] ?? '');
  const sup = marks.length ? marks.map(supMark).join(',') : '';
  if (c.kind === 'entry') return (text.trim() || String(rowIndex + 1)) + sup;
  return text + sup;
}

/** 化学式の書き方（英字の後の数字を下付き）で描く列。後処理・精製も「aq. NaHCO3」「SiO2」があるので含める */
export const isFormulaColumn = (c: Column): boolean => ['reagent', 'solvent', 'structure', 'workup', 'purification'].includes(c.kind);

/** 注の記号（a, b, c…） */
export const noteMark = (i: number): string => String.fromCharCode(97 + (i % 26));

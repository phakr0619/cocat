// 実験の記録のデータ。スキームの 1 段を、ある日に、ある量で行った 1 回ぶんを表す。
// 仕込み・操作の流れ・重さ・操作ごとの記録を持ち、フロー図と物質収支はこのデータから描く（docs/process-record.md）

export type MassUnit = 'mg' | 'g' | 'kg';
export type VolUnit = 'µL' | 'mL' | 'L';
export type AmountUnit = MassUnit | VolUnit;
export const MASS_UNITS: MassUnit[] = ['mg', 'g', 'kg'];
export const VOL_UNITS: VolUnit[] = ['µL', 'mL', 'L'];

export interface Amount {
  value: number;
  unit: AmountUnit;
}

/** substrate: 基質 / reagent: 試薬 / solvent: 溶媒 / water: 水と水溶液（洗浄液など） / other: 種晶・ろ過助剤など */
export type MaterialRole = 'substrate' | 'reagent' | 'solvent' | 'water' | 'other';

/** 仕込みの 1 行 */
export interface Material {
  id: string;
  name: string;
  role: MaterialRole;
  /** スキームの化合物なら、その id（名前と分子量を化合物から引く） */
  compoundId?: string;
  mw?: number;
  equiv?: number;
  /** 入れた量。体積で入れたときは、密度があれば重さに直す */
  amount?: Amount;
  /** 密度（g/mL） */
  density?: number;
  /** 含量（wt%）。無ければ 100 として扱う */
  assay?: number;
  lot?: string;
  /** 入れる操作。無ければ最初の操作 */
  opId?: string;
}

export type OpKind =
  | 'charge' | 'reaction' | 'addition' | 'heatcool' | 'quench' | 'separation' | 'wash' | 'extraction'
  | 'concentration' | 'swap' | 'crystallization' | 'filtration' | 'drying' | 'column' | 'other';

/** 操作の種類と、はじめの名前 */
export const OP_KINDS: { kind: OpKind; name: string }[] = [
  { kind: 'charge', name: '仕込み' },
  { kind: 'reaction', name: '反応' },
  { kind: 'addition', name: '滴下' },
  { kind: 'heatcool', name: '加熱・冷却' },
  { kind: 'quench', name: 'クエンチ' },
  { kind: 'separation', name: '分液' },
  { kind: 'wash', name: '洗浄' },
  { kind: 'extraction', name: '抽出' },
  { kind: 'concentration', name: '濃縮' },
  { kind: 'swap', name: '溶媒置換' },
  { kind: 'crystallization', name: '晶析' },
  { kind: 'filtration', name: 'ろ過' },
  { kind: 'drying', name: '乾燥' },
  { kind: 'column', name: 'カラム' },
  { kind: 'other', name: 'その他' },
];

/** 操作から外へ出る物（水層・母液・留出など） */
export interface Output {
  id: string;
  name: string;
  amount?: Amount;
  density?: number;
  /** この中の生成物の含量（wt%）。入れると「生成物の行方」に出る */
  productAssay?: number;
}

export interface Operation {
  id: string;
  kind: OpKind;
  name: string;
  outputs: Output[];
  /** 次の操作へ進む物の重さ（測った値）。最後の操作では、得た生成物の重さ。無ければ差から出す */
  carry?: Amount;
}

/** 操作ごとの記録の 1 行 */
export interface RunEvent {
  id: string;
  opId: string;
  /** 時刻（「10:32」）か経過時間（「+30 min」）。文字のまま持つ */
  time?: string;
  /** したこと */
  action: string;
  amount?: string;
  /** 内温 */
  temp?: string;
  /** 測定・観察 */
  note?: string;
}

export type FlowDirection = 'horizontal' | 'vertical';

export interface ProcessRun {
  id: string;
  /** どのスキームのどの段か（スキームが無くても作れる） */
  schemeId?: string;
  stepId?: string;
  title?: string;
  notebook?: string;
  /** 行った日（YYYY-MM-DD） */
  date?: string;
  materials: Material[];
  operations: Operation[];
  events: RunEvent[];
  /** 得た生成物。重さは最後の操作の carry */
  product: { name: string; compoundId?: string; mw?: number; assay?: number };
  flow: {
    /** horizontal: 左から右へ進め、入れる物を上、出る物を下に描く / vertical: 上から下へ進め、入れる物を左、出る物を右に描く */
    direction: FlowDirection;
    /** 矢印に重さを添える */
    showMass: boolean;
    /** 外へ出る物に、その中の生成物の重さを添え、得た生成物に含量を添える（含量を入れた物だけ） */
    showProduct?: boolean;
    /** 操作から次の操作へ進む矢印の太さを、進む物の重さに合わせる */
    widthByMass?: boolean;
  };
  /** フロー図の左上（pt） */
  origin: { x: number; y: number };
}

const G_PER: Record<MassUnit, number> = { mg: 0.001, g: 1, kg: 1000 };
const ML_PER: Record<VolUnit, number> = { 'µL': 0.001, mL: 1, L: 1000 };

export const isMassUnit = (u: AmountUnit): u is MassUnit => u in G_PER;

/** 量を g にする。体積は密度が要る。出せなければ undefined */
export function toGrams(a: Amount | undefined, density?: number): number | undefined {
  if (!a || !isFinite(a.value)) return undefined;
  if (isMassUnit(a.unit)) return a.value * G_PER[a.unit];
  return density && density > 0 ? a.value * ML_PER[a.unit] * density : undefined;
}

/** g の値を、読みやすい単位の文字にする（1 g より小さければ mg、1000 g 以上は kg） */
export function formatGrams(g: number | undefined): string {
  if (g === undefined || !isFinite(g)) return '';
  const a = Math.abs(g);
  if (a >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  if (a < 1 && a > 0) return `${(g * 1000).toFixed(a < 0.01 ? 1 : 0)} mg`;
  return `${g.toFixed(1)} g`;
}

/** 入れた量の文字（入れたとおりの単位で） */
export function formatAmount(a: Amount | undefined): string {
  if (!a || !isFinite(a.value)) return '';
  return `${a.value} ${a.unit}`;
}

/** 「10 g」「2.5 kg」「100 mL」のような文字を量にする。単位が無い・読めないときは null */
export function parseAmount(text: string): Amount | null {
  const m = text.trim().replace(/μ/g, 'µ').match(/^(-?\d+(?:\.\d+)?)\s*(mg|g|kg|µL|uL|mL|ml|L|l)$/);
  if (!m) return null;
  const unit = ({ uL: 'µL', ml: 'mL', l: 'L' } as Record<string, AmountUnit>)[m[2]] ?? (m[2] as AmountUnit);
  return { value: parseFloat(m[1]), unit };
}

// 反応スキームのデータ。化合物と反応（段）を持ち物として持ち、図は自動レイアウトで作る
import { rectOfPoints } from '../chem/geometry';
import type { Atom, Bond, Doc, Group } from '../chem/model';
import { emptyDoc, fragments } from '../chem/model';
import type { SchemeStyle } from './style';

/** 化合物の構造。座標は構造の中心を原点にした pt */
export interface Structure {
  atoms: Record<string, Atom>;
  bonds: Record<string, Bond>;
  groups: Record<string, Group>;
}

export interface Compound {
  id: string;
  structure: Structure;
  /** 化合物番号（任意の文字列: 「12」「3a」「ABC-123-01」）。無くてよい */
  number?: string;
  /** 呼び名（「◯◯中間体」「アミン✕✕」） */
  nickname?: string;
  note?: string;
}

export interface Reagent {
  /** 試薬の書き方（「TFA」「Pd(PPh3)4」）。化学式の書き方で描く */
  text: string;
  equiv?: number;
  /** 化学量論表で使う分子量と密度（g/mL）。無ければ試薬の辞書から探す */
  mw?: number;
  density?: number;
}

export interface Step {
  id: string;
  /** この段の基質（化合物 id）。2段目以降は、前の段の生成物を含める */
  from: string[];
  to: string[];
  reagents: Reagent[];
  solvent?: string;
  temp?: string;
  time?: string;
  /** 収率（%）。「quant.」などの文字でもよい */
  yield?: number | string;
  notebook?: string;
  /** 化学量論表の基準: 最初の基質の量 */
  scale?: { value: number; unit: 'mg' | 'mmol' };
  /** 2つ目以降の基質の当量（化合物 id → 当量） */
  substrateEquiv?: Record<string, number>;
}

export interface Scheme {
  id: string;
  title?: string;
  steps: Step[];
  styleId: string;
  /** 図の左上（pt） */
  origin: { x: number; y: number };
  /** 言葉から作った下書き（確定するまで付く。src/llm/textToScheme.ts） */
  draft?: SchemeDraft;
  /** 固定の版（反映させない図）。固定したときの化合物と書式の写しで描き、化合物や書式を直しても変わらない */
  pinned?: SchemePin;
}

export interface SchemePin {
  /** 固定した日時（ISO） */
  at: string;
  /** このスキームに出てくる化合物の写し */
  compounds: Record<string, Compound>;
  style: SchemeStyle;
}

/** スキームを描くのに使う化合物（固定していれば、その写し） */
export function schemeCompounds(doc: Doc, scheme: Scheme): Record<string, Compound> {
  return scheme.pinned ? { ...(doc.compounds ?? {}), ...scheme.pinned.compounds } : (doc.compounds ?? {});
}

export interface DraftIssue {
  /** structure: 構造が読めない / missing: 構造が分からない / elements: 元素のつじつま / stereo: 名前の (R)/(S) と構造が合わない / step: 段の形 / confidence: LLM が自信なし */
  /** text: 図と本文・SI の条件・収率が食い違う、name: 系統名の構造と図の構造が食い違う（M6 段3） */
  kind: 'structure' | 'missing' | 'elements' | 'stereo' | 'step' | 'confidence' | 'skeleton' | 'text' | 'name';
  message: string;
  /** 指している化合物（このスキームの化合物 id） */
  compoundId?: string;
  stepIndex?: number;
}

/** 段の項目のうち、本文・SI から補えるもの */
export type TextField = 'reagents' | 'solvent' | 'temp' | 'time' | 'yield';

export interface SchemeDraft {
  /** 送った文章（聞き返しに答えて送り直すときに使う） */
  text: string;
  issues: DraftIssue[];
  /** LLM が決められなかったこと */
  questions: string[];
  model: string;
  /** 画像から作ったとき、その画像のファイル名（画像そのものは文書に残さない） */
  image?: string;
  /** 本文・SI の文字から補った条件・収率と、その出所（M6 段3）。where は「SI p.12」 */
  textSources?: { stepIndex: number; field: TextField; where: string }[];
  /** 本文・SI の系統名を OPSIN で構造にして、図の構造と比べた結果（M6 段3）。smiles は名前の構造 */
  nameChecks?: { compoundId: string; name: string; result: 'match' | 'stereo' | 'mismatch' | 'filled' | 'unread' | 'replaced'; where: string; smiles?: string }[];
  /** PDF の中の画像として貼られた図から作ったとき、その図の解像度（dpi。小さい数だけ残す。画像そのものは残さない）。低いときの警告を、ページを開き直した後も出すため */
  imageDpi?: number;
}

/** 文書の原子の一部を、化合物の構造（中心が原点）として取り出す */
export function structureFrom(doc: Doc, atomIds: string[]): Structure {
  const ids = new Set(atomIds);
  const pts = atomIds.map((id) => doc.atoms[id]);
  const r = rectOfPoints(pts) ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
  const cx = (r.x1 + r.x2) / 2;
  const cy = (r.y1 + r.y2) / 2;
  const atoms: Record<string, Atom> = {};
  for (const id of atomIds) {
    const { ref: _ref, ...a } = doc.atoms[id];
    void _ref;
    atoms[id] = { ...a, x: a.x - cx, y: a.y - cy };
  }
  const bonds: Record<string, Bond> = {};
  for (const b of Object.values(doc.bonds)) if (ids.has(b.a1) && ids.has(b.a2)) bonds[b.id] = { ...b };
  const groups: Record<string, Group> = {};
  for (const g of Object.values(doc.groups)) if (g.atomIds.every((x) => ids.has(x))) groups[g.id] = { ...g, atomIds: [...g.atomIds] };
  // 離れた部分を持つ化合物（塩など）は、全体を 1 つのまとまり（unit 'u'）にする。置くときに文書の中で一意な値へ振り直す
  const multi = fragments({ ...emptyDoc(), atoms, bonds }).length > 1;
  for (const a of Object.values(atoms)) {
    if (multi) a.unit = 'u';
    else delete a.unit;
  }
  return { atoms, bonds, groups };
}

/** 図に出す化合物の名前（番号があれば番号、無ければ呼び名） */
export function compoundLabel(c: Compound | undefined, showNickname: boolean): { text: string; isNumber: boolean } | null {
  if (!c) return null;
  if (c.number?.trim()) return { text: c.number.trim(), isNumber: true };
  if (showNickname && c.nickname?.trim()) return { text: c.nickname.trim(), isNumber: false };
  return null;
}

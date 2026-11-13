// 原子ラベルの入力（「NH2」「OMe」「Boc」「N+」など）を解釈する
import { abbrSource, findAbbr, resolveAbbr } from './abbreviations';
import { isElement } from './elements';
import type { SaltHalide } from './model';

export type LabelInput =
  | {
      kind: 'element';
      element: string;
      charge: number;
      isotope?: number;
      /** 塩の書き方（「NH2Cl」「NH·HCl」）。hCount は書いた水素の数（書いていなければ無い）。docs/salt-design.md */
      salt?: { x: SaltHalide; style: 'ion' | 'dot'; hCount?: number };
    }
  | { kind: 'abbr'; abbr: string }
  | null;

const hNum = (h: string | undefined) => (h === undefined ? undefined : h === 'H' ? 1 : parseInt(h.slice(1), 10));

/**
 * 塩の書き方を読む。窒素・リンの原子だけ（アミン・ホスフィンの塩）
 * - ion: 「NH2Cl」「NH3Br」「NH2+Cl-」、左向きの「ClH3N」
 * - dot: 「NH·HCl」「NH.HCl」「N·HBr」「HCl·HN」
 */
function parseSaltLabel(text: string): LabelInput {
  const dot = text.match(/^(?:H(Cl|Br|I)\s*[·.•・]\s*(H\d*)?(N|P)|(H\d*)?(N|P)(H\d*)?\s*[·.•・]\s*H(Cl|Br|I))$/);
  if (dot) {
    const x = (dot[1] ?? dot[7]) as SaltHalide;
    const h = dot[2] ?? dot[4] ?? dot[6];
    return { kind: 'element', element: dot[3] ?? dot[5], charge: 0, salt: { x, style: 'dot', ...(h ? { hCount: hNum(h) } : {}) } };
  }
  const ion = text.match(/^(?:(H\d*)?(N|P)(H\d*)?\+?(Cl|Br|I)[-−]?|(Cl|Br|I)[-−]?(H\d*)(N|P)\+?)$/);
  if (ion) {
    const x = (ion[4] ?? ion[5]) as SaltHalide;
    const h = ion[1] ?? ion[3] ?? ion[6];
    return { kind: 'element', element: ion[2] ?? ion[7], charge: 0, salt: { x, style: 'ion', ...(h ? { hCount: hNum(h) } : {}) } };
  }
  return null;
}

/** 置換基の記号（R・R1・R'・Ar・X）。元素の決まっていない原子として、略号と同じく持つ */
export const isRGroup = (s: string): boolean => /^(R\d*'{0,2}|Ar\d*|X\d*)$/.test(s);

export function parseLabel(raw: string): LabelInput {
  let text = raw.trim();
  if (!text) return null;
  if (isRGroup(text)) return { kind: 'abbr', abbr: text };
  const salt = parseSaltLabel(text);
  if (salt) return salt;
  let charge = 0;
  const m = text.match(/^(.*?)(\d?)([+\-−])$/);
  if (m && m[1]) {
    // 「NH2+」「NH3+」の数は水素の数で、電荷は 1 価。電荷の数として読むのは元素のすぐあと（Fe3+・O2−）だけ
    if (m[2] && /H$/.test(m[1])) m[1] += m[2], (m[2] = '');
    const n = m[2] ? parseInt(m[2], 10) : 1;
    charge = m[3] === '+' ? n : -n;
    text = m[1];
  }
  // 同位体: 「13C」「2H」「D」（重水素）
  if (text === 'D') return { kind: 'element', element: 'H', charge, isotope: 2 };
  const iso = text.match(/^(\d{1,3})([A-Z][a-z]?)$/);
  if (iso && isElement(iso[2])) return { kind: 'element', element: iso[2], charge, isotope: parseInt(iso[1], 10) };
  const ab = findAbbr(text);
  if (ab && !isElement(text)) return { kind: 'abbr', abbr: ab };
  // 利用者の辞書の略号（略号の辞書の画面で足したもの）
  if (abbrSource(text) === 'user') return { kind: 'abbr', abbr: text };
  // 水素の付いた書き方（NH2, OH, H2N, HO, SH）は元素だけを取り出す。水素は自動で付く
  const hm = text.match(/^(?:H\d*)?([A-Z][a-z]?)(?:H\d*)?$/);
  if (hm && isElement(hm[1])) return { kind: 'element', element: hm[1], charge };
  const cap = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  if (isElement(cap)) return { kind: 'element', element: cap, charge };
  // 最後に、ラベルの書き方（NHFmoc・CH2OH・CO2tBu・BF3K・左向きの HOH2C）を読む。docs/abbreviation-labels.md
  if (!charge) {
    const cond = resolveAbbr(text);
    if (cond) return { kind: 'abbr', abbr: cond };
  }
  return null;
}

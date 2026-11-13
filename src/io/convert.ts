// 入出力のまとめ: 形式の判定、反応 SMILES の配置、SVG・PNG・MOL の書き出し
import { groupIonsOnImport } from '../chem/salt';
import { rectOfPoints, type Rect } from '../chem/geometry';
import type { Doc } from '../chem/model';
import { getRDKit } from '../chem/rdkit';
import { addPlus, addArrow } from '../chem/schemeOps';
import { BOND_LEN } from '../chem/style';
import { insertDoc, selectionBBox } from '../chem/transform';
import { layout, primsToSvg, f } from '../render/layout';
import { cdxmlToCdx } from './cdx';
import { readCdxml, writeCdxml, type LabelReport } from './cdxml';
import { addParsedMol, parseMolfile } from './molfile';
import { addSmiles, documentSmiles, expandedMolfile, withGroupsFrom } from './smiles';

export type Format = 'smiles' | 'mol' | 'cdxml';

export function detectFormat(text: string, filename?: string): Format {
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext === 'cdxml') return 'cdxml';
  if (ext === 'mol' || ext === 'sdf') return 'mol';
  if (ext === 'smi' || ext === 'smiles') return 'smiles';
  const t = text.trimStart();
  if (t.startsWith('<') && /<CDXML/i.test(text)) return 'cdxml';
  if (/V2000|V3000|M {2}END/.test(text)) return 'mol';
  return 'smiles';
}

/** 既存の物の右に置く位置 */
function freeSpot(doc: Doc): { x: number; y: number } {
  const ids = [...Object.keys(doc.atoms), ...Object.keys(doc.arrows), ...Object.keys(doc.texts), ...Object.keys(doc.pluses)];
  const box = selectionBBox(doc, ids);
  if (!box) return { x: 120, y: 100 };
  return { x: box.x2 + BOND_LEN * 4, y: (box.y1 + box.y2) / 2 };
}

export function importText(doc: Doc, text: string, filename?: string, report?: LabelReport): { doc: Doc; ids: Set<string> } {
  const fmt = detectFormat(text, filename);
  if (fmt === 'cdxml') {
    const part = readCdxml(text, report);
    const at = Object.keys(doc.atoms).length ? freeSpot(doc) : null;
    const box = selectionBBox(part, [...Object.keys(part.atoms), ...Object.keys(part.arrows), ...Object.keys(part.texts), ...Object.keys(part.pluses)]);
    const off = at && box ? { x: at.x - box.x1, y: at.y - (box.y1 + box.y2) / 2 } : { x: 0, y: 0 };
    return insertDoc(doc, part, off);
  }
  if (fmt === 'mol') {
    let mb = text;
    // V3000 は RDKit で V2000 に直して読む。rac・rel の組（COLLECTION）は RDKit の JSON から写す
    let json = '';
    if (/V3000/.test(text)) {
      const m = getRDKit().get_mol(text, JSON.stringify({ removeHs: false }));
      if (!m) throw new Error('MOL を読めません');
      try {
        mb = m.get_v2Kmolblock();
        json = m.get_json();
      } finally {
        m.delete();
      }
    }
    const before = new Set(Object.keys(doc.atoms));
    const parsed = addParsedMol(doc, parseMolfile(mb), freeSpot(doc));
    const r = json ? withGroupsFrom(json, parsed) : parsed;
    const ids = newIds(r.doc, before);
    return { doc: groupIonsOnImport(r.doc, ids), ids };
  }
  // CXSMILES（「C[C@H](N)[C@H](C)O |&1:1,3|」）は、空白のあとの |…| までを 1 つとして読む
  const cx = text.trim().match(/^(\S+)(\s+\|[^|]*\|)?/);
  const s = cx ? cx[1] + (cx[2] ?? '') : '';
  if (s.includes('>')) return importReactionSmiles(doc, cx![1]);
  const before = new Set(Object.keys(doc.atoms));
  const r = addSmiles(doc, s, freeSpot(doc));
  const ids = newIds(r.doc, before);
  // 塩の SMILES（C[NH3+].[Cl-]）は、1 つの化合物（まとまり）として読む
  return { doc: groupIonsOnImport(r.doc, ids), ids };
}

function newIds(doc: Doc, before: Set<string>): Set<string> {
  return new Set(Object.keys(doc.atoms).filter((id) => !before.has(id)));
}

/** 反応 SMILES（A.B>C>D）を、反応物 ＋ 反応物 → 生成物 の一列に並べる */
function importReactionSmiles(doc: Doc, smi: string): { doc: Doc; ids: Set<string> } {
  const [reac, agents, prod] = smi.split('>');
  let d = doc;
  const start = freeSpot(doc);
  let x = start.x;
  const y = start.y;
  const gap = BOND_LEN * 1.5;
  const placeGroup = (part: string, plus: boolean) => {
    const mols = part.split('.').filter(Boolean);
    mols.forEach((m, i) => {
      const before = new Set(Object.keys(d.atoms));
      d = addSmiles(d, m, { x: 0, y: 0 }).doc;
      const ids = newIds(d, before);
      const box = rectOfPoints([...ids].map((id) => d.atoms[id]))!;
      d = shift(d, ids, { x: x - box.x1, y: y - (box.y1 + box.y2) / 2 });
      x += box.x2 - box.x1 + gap;
      if (plus && i < mols.length - 1) {
        d = addPlus(d, { x: x, y });
        x += gap;
      }
    });
  };
  placeGroup(reac ?? '', true);
  const arrowLen = BOND_LEN * 4;
  const tail = { x, y };
  d = addArrow(d, tail, { x: x + arrowLen, y }, 'normal');
  if (agents) {
    // 試薬は矢印の上に置く
    const mols = agents.split('.').filter(Boolean);
    let ax = x;
    for (const m of mols) {
      const before = new Set(Object.keys(d.atoms));
      d = addSmiles(d, m, { x: 0, y: 0 }).doc;
      const ids = newIds(d, before);
      const box = rectOfPoints([...ids].map((id) => d.atoms[id]))!;
      d = shift(d, ids, { x: ax - box.x1, y: y - BOND_LEN * 0.8 - box.y2 });
      ax += box.x2 - box.x1 + gap;
    }
    if (ax - gap > x + arrowLen) {
      const r = Object.values(d.arrows).at(-1)!;
      d = { ...d, arrows: { ...d.arrows, [r.id]: { ...r, x2: ax - gap + BOND_LEN } } };
      x = ax - gap + BOND_LEN;
    } else x += arrowLen;
  } else x += arrowLen;
  x += gap;
  placeGroup(prod ?? '', true);
  return { doc: d, ids: new Set() };
}

function shift(doc: Doc, ids: Set<string>, delta: { x: number; y: number }): Doc {
  const d = structuredClone(doc);
  for (const id of ids) {
    d.atoms[id].x += delta.x;
    d.atoms[id].y += delta.y;
  }
  return d;
}

// ---------------------------------------------------------------- 書き出し

export function exportSmiles(doc: Doc): string {
  const r = documentSmiles(doc);
  if (r.smiles === null) throw new Error(r.error);
  return r.smiles + '\n';
}

export function exportMol(doc: Doc): string {
  // 略号の展開・ラベルの塩の対イオン・rac・rel の組（あれば V3000）は expandedMolfile が入れる
  return expandedMolfile(doc).molblock;
}

export function exportCdxml(doc: Doc): string {
  return writeCdxml(doc);
}

/** ChemDraw のバイナリの形式（.cdx） */
export function exportCdx(doc: Doc): Uint8Array {
  return cdxmlToCdx(writeCdxml(doc));
}

const MARGIN = 10;

export function exportSvg(doc: Doc): string {
  const lay = layout(doc);
  const box: Rect = lay.bbox ?? { x1: 0, y1: 0, x2: 1, y2: 1 };
  return svgOfArea({ x1: box.x1 - MARGIN, y1: box.y1 - MARGIN, x2: box.x2 + MARGIN, y2: box.y2 + MARGIN }, primsToSvg(lay.prims));
}

/** 決めた範囲（pt）だけを切り出した SVG。body は primsToSvg の結果（ページごとに同じものを使い回す） */
export function svgOfArea(area: Rect, body: string): string {
  const w = area.x2 - area.x1;
  const h = area.y2 - area.y1;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}pt" height="${f(h)}pt" viewBox="${f(area.x1)} ${f(area.y1)} ${f(w)} ${f(h)}">`,
    `<rect x="${f(area.x1)}" y="${f(area.y1)}" width="${f(w)}" height="${f(h)}" fill="#fff"/>`,
    body,
    '</svg>',
    '',
  ].join('\n');
}

/** PNG（既定 300 dpi）。ブラウザでだけ使える */
export async function exportPng(doc: Doc, dpi = 300): Promise<Blob> {
  const svg = exportSvg(doc);
  const m = svg.match(/width="([\d.]+)pt" height="([\d.]+)pt"/)!;
  const k = dpi / 72;
  const w = Math.ceil(parseFloat(m[1]) * k);
  const h = Math.ceil(parseFloat(m[2]) * k);
  const url = URL.createObjectURL(new Blob([svg.replace(/(width|height)="([\d.]+)pt"/g, (_s, a, v) => `${a}="${parseFloat(v) * k}"`)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('SVG を画像にできません'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG を作れません'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 読み込みでラベルを補った・読めなかったことの知らせ（無ければ空） */
export function labelReportText(r: LabelReport): string {
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 6).join('、') + (new Set(xs).size > 6 ? ' ほか' : '');
  const parts: string[] = [];
  if (r.repaired.length) parts.push(`構造の抜けていたラベル ${r.repaired.length} 個を、ラベルから補いました（${uniq(r.repaired)}）`);
  if (r.unreadable.length) parts.push(`${r.unreadable.length} 個のラベルは構造が分かりません（${uniq(r.unreadable)}。赤い枠。略号の辞書に足すと読めます）`);
  return parts.join('。');
}

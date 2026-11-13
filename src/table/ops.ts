// 検討表の編集の操作。どれもデータを変えてから renderTable で描き直す
import type { Doc } from '../chem/model';
import { edit, newId } from '../chem/model';
import { rectOfPoints } from '../chem/geometry';
import { BOND_LEN } from '../chem/style';
import type { Compound, Scheme, Step, Structure } from '../scheme/model';
import { schemeCompounds, structureFrom } from '../scheme/model';
import { parseReagents } from '../scheme/ops';
import { renderScheme } from '../scheme/layout';
import { clearTable, renderTable, tableBounds } from './layout';
import { layout } from '../render/layout';
import { makeXlsx, type XlsxRow } from '../io/xlsx';
import { cellText, COLUMN_KINDS, splitCellMarks, headerText, noteMark, supMark, TABLE_TEMPLATES, type Column, type ColumnKind, type StudyTable, type TableTemplate } from './model';

/**
 * 表を作る。schemeId を渡すと、そのスキームを共通の反応式として表の上に描く。
 * coreAtomIds を渡すと（SAR 型）、その分子を母核として表の上に描く（キャンバスの分子は母核に置き換わる）。
 * どちらも無ければ origin に置く
 */
export function createTable(
  doc: Doc,
  templateId: TableTemplate['id'],
  opt: { schemeId?: string; coreAtomIds?: string[]; origin?: { x: number; y: number } } = {},
): { doc: Doc; tableId: string } {
  const tpl = TABLE_TEMPLATES.find((t) => t.id === templateId) ?? TABLE_TEMPLATES[0];
  let tableId = '';
  const out = edit(doc, (d) => {
    d.tables ??= {};
    tableId = newId(d, 'm');
    const columns: Column[] = tpl.columns.map((c) => ({ ...c, id: newId(d, 'k') }));
    const rows = Array.from({ length: tpl.rows }, () => ({ id: newId(d, 'k'), cells: {} }));
    const number = String(Object.keys(d.tables).length + 1);
    let core: Structure | undefined;
    let origin = opt.origin ?? belowDrawing(d);
    if (opt.coreAtomIds?.length) {
      const r = rectOfPoints(opt.coreAtomIds.map((id) => d.atoms[id]))!;
      core = structureFrom(d, opt.coreAtomIds);
      const set = new Set(opt.coreAtomIds);
      for (const id of set) delete d.atoms[id];
      for (const b of Object.values(d.bonds)) if (set.has(b.a1) || set.has(b.a2)) delete d.bonds[b.id];
      for (const g of Object.values(d.groups)) if (g.atomIds.some((x) => set.has(x))) delete d.groups[g.id];
      origin = { x: r.x1, y: r.y1 - 30 };
    }
    d.tables[tableId] = {
      id: tableId,
      number,
      title: tpl.id === 'sar' ? 'Structure–activity relationship' : 'Optimization of the reaction conditions',
      columns,
      rows,
      notes: [...tpl.notes],
      ...(opt.schemeId ? { schemeId: opt.schemeId } : {}),
      ...(core ? { core } : {}),
      origin,
    };
    if (opt.schemeId && d.schemes?.[opt.schemeId]) {
      // 題の行の分だけ、反応式を下げる
      const s = d.schemes[opt.schemeId];
      d.tables[tableId].origin = { x: s.origin.x, y: s.origin.y };
      s.origin = { x: s.origin.x, y: s.origin.y + 16.5 };
    }
  });
  return { doc: renderTable(opt.schemeId ? renderScheme(out, opt.schemeId) : out, tableId), tableId };
}

// ---------------------------------------------------------------- 表を持ち運ぶ（プロジェクトに入れる）

/** 表と、表の上の反応式（スキームとその化合物）をまとめたもの。プロジェクトに入れ、ほかの図に置き直せる */
export interface TablePackage {
  table: StudyTable;
  scheme?: Scheme;
  compounds?: Record<string, Compound>;
}

/** 文書の表を、反応式ごと取り出す（固定した反応式は、固定した形で取り出す） */
export function packTable(doc: Doc, tableId: string): TablePackage | null {
  const t = doc.tables?.[tableId];
  if (!t) return null;
  const s = t.schemeId ? doc.schemes?.[t.schemeId] : undefined;
  if (!s) return { table: structuredClone({ ...t, schemeId: undefined }) };
  const all = schemeCompounds(doc, s);
  const ids = [...new Set(s.steps.flatMap((st) => [...st.from, ...st.to]))].filter((c) => all[c]);
  const scheme = structuredClone(s);
  delete scheme.pinned;
  delete scheme.draft;
  return { table: structuredClone(t), scheme, compounds: Object.fromEntries(ids.map((c) => [c, structuredClone(all[c])])) };
}

/**
 * 取り出した表を、文書の今の図の下に置く。化合物・スキーム・表は新しい id にする（同じ文書に何度置いてもよい）。
 * 化合物は置いた先で新しい化合物になる（元の図とは共有しない）
 */
export function placeTable(doc: Doc, pkg: TablePackage): { doc: Doc; tableId: string } {
  let tableId = '';
  let schemeId: string | undefined;
  const out = edit(doc, (d) => {
    d.tables ??= {};
    const at = belowDrawing(d);
    tableId = newId(d, 'm');
    const t: StudyTable = { ...structuredClone(pkg.table), id: tableId, origin: at, number: String(Object.keys(d.tables).length + 1) };
    delete t.schemeId;
    if (pkg.scheme) {
      d.compounds ??= {};
      d.schemes ??= {};
      const map = new Map<string, string>();
      for (const [old, c] of Object.entries(pkg.compounds ?? {})) {
        const id = newId(d, 'c');
        map.set(old, id);
        d.compounds[id] = { ...structuredClone(c), id };
      }
      const re = (ids: string[]) => ids.map((x) => map.get(x) ?? x).filter((x) => d.compounds![x]);
      schemeId = newId(d, 's');
      d.schemes[schemeId] = {
        ...structuredClone(pkg.scheme),
        id: schemeId,
        steps: pkg.scheme.steps.map((st) => ({ ...structuredClone(st), id: newId(d, 'x'), from: re(st.from), to: re(st.to) })),
        // 題の行の分だけ、反応式を下げる（createTable と同じ）
        origin: { x: at.x, y: at.y + 16.5 },
      };
      t.schemeId = schemeId;
    }
    d.tables[tableId] = t;
  });
  return { doc: renderTable(schemeId ? renderScheme(out, schemeId) : out, tableId), tableId };
}

/** 今の図の下（何も無ければ左上）。反応式も母核も無い表を、既存の物と重ならない所に置く */
export function belowDrawing(doc: Doc): { x: number; y: number } {
  const box = layout(doc).bbox;
  return box ? { x: box.x1, y: box.y2 + 30 } : { x: 40, y: 40 };
}

function change(doc: Doc, tableId: string, fn: (t: StudyTable, d: Doc) => void): Doc {
  return renderTable(
    edit(doc, (d) => fn(d.tables![tableId], d)),
    tableId,
  );
}

export const setTableInfo = (doc: Doc, tableId: string, patch: Partial<Pick<StudyTable, 'title' | 'number'>>) =>
  change(doc, tableId, (t) => Object.assign(t, patch));

export const setCell = (doc: Doc, tableId: string, rowId: string, colId: string, value: string) =>
  change(doc, tableId, (t) => {
    const r = t.rows.find((x) => x.id === rowId);
    if (!r) return;
    if (value.trim()) r.cells[colId] = value.trim();
    else delete r.cells[colId];
  });

export const addRow = (doc: Doc, tableId: string, copyFrom?: string) =>
  change(doc, tableId, (t, d) => {
    const src = t.rows.find((r) => r.id === copyFrom);
    const entry = t.columns.find((c) => c.kind === 'entry');
    const cells = src ? { ...src.cells } : {};
    // 複製しても、行の番号は振り直す
    if (entry) delete cells[entry.id];
    const row = { id: newId(d, 'k'), cells };
    const at = src ? t.rows.indexOf(src) + 1 : t.rows.length;
    t.rows.splice(at, 0, row);
  });

export const removeRow = (doc: Doc, tableId: string, rowId: string) => change(doc, tableId, (t) => (t.rows = t.rows.filter((r) => r.id !== rowId)));

export const moveRow = (doc: Doc, tableId: string, rowId: string, delta: -1 | 1) =>
  change(doc, tableId, (t) => {
    const i = t.rows.findIndex((r) => r.id === rowId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= t.rows.length) return;
    [t.rows[i], t.rows[j]] = [t.rows[j], t.rows[i]];
  });

/** 行を index の位置へ動かす（ドラッグでの並べ替え） */
export const moveRowTo = (doc: Doc, tableId: string, rowId: string, index: number) =>
  change(doc, tableId, (t) => {
    const i = t.rows.findIndex((r) => r.id === rowId);
    if (i < 0 || index < 0 || index >= t.rows.length || i === index) return;
    const [row] = t.rows.splice(i, 1);
    t.rows.splice(index, 0, row);
  });

export const addColumn = (doc: Doc, tableId: string, kind: ColumnKind, beforeColId?: string) =>
  change(doc, tableId, (t, d) => {
    const k = COLUMN_KINDS.find((x) => x.kind === kind)!;
    // 置換基の列は R1, R2… と番号を続ける
    const label = kind === 'structure' ? `R${t.columns.filter((c) => c.kind === 'structure').length + 1}` : k.label;
    const col: Column = { id: newId(d, 'k'), kind, label, ...(k.unit ? { unit: k.unit } : {}) };
    const at = beforeColId ? t.columns.findIndex((c) => c.id === beforeColId) : -1;
    if (at >= 0) t.columns.splice(at, 0, col);
    else t.columns.push(col);
  });

export const updateColumn = (doc: Doc, tableId: string, colId: string, patch: Partial<Pick<Column, 'label' | 'unit' | 'mark'>>) =>
  change(doc, tableId, (t) => {
    const c = t.columns.find((x) => x.id === colId);
    if (!c) return;
    for (const [k, v] of Object.entries(patch) as [keyof typeof patch, string | undefined][]) {
      if (v === undefined || !v.trim()) delete c[k];
      else c[k] = v.trim();
    }
    if (!c.label) c.label = '';
  });

export const removeColumn = (doc: Doc, tableId: string, colId: string) =>
  change(doc, tableId, (t) => {
    t.columns = t.columns.filter((c) => c.id !== colId);
    for (const r of t.rows) delete r.cells[colId];
  });

export const moveColumn = (doc: Doc, tableId: string, colId: string, delta: -1 | 1) =>
  change(doc, tableId, (t) => {
    const i = t.columns.findIndex((c) => c.id === colId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= t.columns.length) return;
    [t.columns[i], t.columns[j]] = [t.columns[j], t.columns[i]];
  });

export const setNotes = (doc: Doc, tableId: string, notes: string[]) => change(doc, tableId, (t) => (t.notes = notes.map((n) => n.trim()).filter(Boolean)));

/** 表を消す（データも図も）。反応式のスキームは残す */
export function removeTable(doc: Doc, tableId: string): Doc {
  return edit(doc, (d) => {
    clearTable(d, tableId);
    delete d.tables![tableId];
  });
}

/** 表をやめて、ただの図（文字と線）に戻す */
export function dissolveTable(doc: Doc, tableId: string): Doc {
  return edit(doc, (d) => {
    const prefix = `${tableId}:`;
    for (const a of Object.values(d.atoms)) if (a.ref?.startsWith(prefix)) delete a.ref;
    for (const rec of [d.arrows, d.texts] as Record<string, { ref?: string }>[]) {
      for (const o of Object.values(rec)) if (o.ref === tableId) delete o.ref;
    }
    delete d.tables![tableId];
  });
}

// ---------------------------------------------------------------- Excel との行き来

/** タブ区切り（Excel・スプレッドシートからの貼り付け）か CSV を、行と列に分ける */
export function parseGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  const tab = lines.some((l) => l.includes('\t'));
  return lines.map((l) => (tab ? l.split('\t') : splitCsv(l)).map((c) => c.trim()));
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s()（）ᵃᵇᶜᵈᵉᶠᵍʰ]/g, '');

/**
 * 貼り付けた表を行として足す。
 * - 1行目が見出し（列の見出しと同じ）なら、見出しで列を合わせる
 * - そうでなければ左から順に入れる。列の数が 1 つ少なければ、行の番号の列を飛ばす
 * 戻り値の added は足した行の数
 */
export function pasteRows(doc: Doc, tableId: string, text: string): { doc: Doc; added: number } {
  const grid = parseGrid(text);
  const t = doc.tables?.[tableId];
  if (!t || !grid.length) return { doc, added: 0 };
  let map: (Column | undefined)[];
  const heads = t.columns.map((c) => [norm(headerText(c)), norm(c.label)]);
  const first = grid[0].map(norm);
  const headerHits = first.filter((h) => heads.some((x) => x.includes(h))).length;
  let rows = grid;
  if (headerHits >= Math.max(1, Math.ceil(first.length / 2))) {
    map = first.map((h) => t.columns[heads.findIndex((x) => x.includes(h))]);
    rows = grid.slice(1);
  } else {
    const width = Math.max(...grid.map((r) => r.length));
    const cols = width === t.columns.length - 1 && t.columns[0]?.kind === 'entry' ? t.columns.slice(1) : t.columns;
    map = cols;
  }
  // 空の行（作ったばかりの表の行）があれば、そこから埋める
  const out = change(doc, tableId, (tb, d) => {
    let i = tb.rows.findIndex((_, k) => tb.rows.slice(k).every((x) => !Object.keys(x.cells).length));
    if (i < 0) i = tb.rows.length;
    for (const cells of rows) {
      const row = tb.rows[i] ?? { id: newId(d, 'k'), cells: {} };
      if (!tb.rows[i]) tb.rows.push(row);
      cells.forEach((v, ci) => {
        const c = map[ci];
        if (c && v) row.cells[c.id] = v;
      });
      i++;
    }
  });
  return { doc: out, added: rows.length };
}

/** 表をタブ区切りにする（Excel に貼れる形）。見出しつき */
export function tableTsv(t: StudyTable): string {
  const lines = [t.columns.map(headerText).join('\t')];
  t.rows.forEach((_, ri) => lines.push(t.columns.map((c) => cellText(t, ri, c).replace(/[\t\n]/g, ' ')).join('\t')));
  return lines.join('\n') + '\n';
}

/** 表を CSV にする（Excel で文字化けしないよう、呼ぶ側で BOM を付ける） */
export function tableCsv(t: StudyTable): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [t.columns.map((c) => q(headerText(c))).join(',')];
  t.rows.forEach((_, ri) => lines.push(t.columns.map((c) => q(cellText(t, ri, c))).join(',')));
  return lines.join('\r\n') + '\r\n';
}

/**
 * 表を Excel の .xlsx にする。題（太字の「Table 1.」と題）・見出し（太字）・行・注の順に、論文の Table と同じ並びで書く。
 * 数だけのセルは数として書く（Excel で並べ替え・計算できる）
 */
export function tableXlsx(t: StudyTable, now = new Date()): Uint8Array {
  const rows: XlsxRow[] = [];
  const head = `Table${t.number?.trim() ? ` ${t.number.trim()}` : ''}.`;
  rows.push([{ text: t.title?.trim() ? `${head} ${t.title.trim()}` : head, bold: true }], []);
  rows.push(t.columns.map((c) => ({ text: headerText(c), bold: true })));
  t.rows.forEach((_, ri) => rows.push(t.columns.map((c) => {
    const v = cellText(t, ri, c);
    return /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
  })));
  // 列の幅は、見出しと行から決める（題と注は横へはみ出してよい）
  const widths = t.columns.map((_, ci) => Math.min(40, Math.max(8, ...rows.slice(2).map((r) => String((typeof r[ci] === 'object' ? (r[ci] as { text: string }).text : r[ci]) ?? '').length + 2))));
  const notes = t.notes.map((n, i) => [n.trim(), i] as const).filter(([n]) => n);
  if (notes.length) rows.push([], ...notes.map(([n, i]) => [`${supMark(noteMark(i))}${n}`]));
  return makeXlsx(rows, { sheetName: head.replace(/\.$/, ''), widths }, now);
}

// ---------------------------------------------------------------- 行から反応式へ

/** 数だけの値に単位を付ける（「0」「°C」→「0 °C」、「12」「h」→「12 h」） */
function withUnit(v: string, unit?: string): string {
  return unit && /^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()} ${unit}` : v.trim();
}

/** 行の値を、スキームの段の条件にする */
export function rowConditions(t: StudyTable, rowId: string): Partial<Pick<Step, 'reagents' | 'solvent' | 'temp' | 'time' | 'yield'>> {
  const row = t.rows.find((r) => r.id === rowId);
  if (!row) return {};
  const out: Partial<Pick<Step, 'reagents' | 'solvent' | 'temp' | 'time' | 'yield'>> = {};
  const reagents: Step['reagents'] = [];
  for (const c of t.columns) {
    // セルの注の記号（「85^b」）は、反応式には写さない
    const v = splitCellMarks(row.cells[c.id] ?? '').text.trim();
    if (!v) continue;
    if (c.kind === 'reagent') {
      for (const item of v.split(/,\s*(?![^()]*\))/)) {
        // 列の単位が equiv なら、「TFA (10)」の括弧の数も当量として読む
        const m = c.unit === 'equiv' ? item.match(/^(.*?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)$/) : null;
        if (m && m[1]) reagents.push({ text: m[1].trim(), equiv: parseFloat(m[2]) });
        else reagents.push(...parseReagents(item));
      }
    } else if (c.kind === 'solvent') out.solvent = v;
    else if (c.kind === 'temp') out.temp = c.unit === '°C' && /^(rt|r\.t\.|reflux)$/i.test(v) ? v : withUnit(v, c.unit);
    else if (c.kind === 'time') out.time = withUnit(v, c.unit);
    else if (c.kind === 'yield') {
      const n = v.replace(/%$/, '').trim();
      out.yield = /^\d+(\.\d+)?$/.test(n) ? parseFloat(n) : v;
    }
  }
  if (reagents.length) out.reagents = reagents;
  return out;
}

/**
 * 行の条件で、表の反応式を複製した新しいスキームを作る（「この条件で反応を登録」）。
 * 化合物は同じものを使う（番号・呼び名・構造を共有）。表の下に置く
 */
export function schemeFromRow(doc: Doc, tableId: string, rowId: string): { doc: Doc; schemeId: string } | null {
  const t = doc.tables?.[tableId];
  const src = t?.schemeId ? doc.schemes?.[t.schemeId] : undefined;
  if (!t || !src || !src.steps.length) return null;
  const box = tableBounds(doc, tableId);
  let schemeId = '';
  const out = edit(doc, (d) => {
    schemeId = newId(d, 's');
    const cond = rowConditions(t, rowId);
    const steps = src.steps.map((st, i) => ({
      ...structuredClone(st),
      id: newId(d, 'x'),
      // 条件は表の反応式の段（1段目）に入れる。表の反応式の固定の条件は置き換える
      ...(i === 0 ? { reagents: [], solvent: undefined, temp: undefined, time: undefined, yield: undefined, ...cond } : {}),
    }));
    for (const st of steps) for (const k of Object.keys(st) as (keyof typeof st)[]) if (st[k] === undefined) delete st[k];
    d.schemes![schemeId] = {
      id: schemeId,
      title: `${t.number ? `Table ${t.number}` : 'Table'}, entry ${t.rows.findIndex((r) => r.id === rowId) + 1}`,
      steps,
      styleId: src.styleId,
      origin: { x: box?.x1 ?? src.origin.x, y: (box?.y2 ?? src.origin.y) + BOND_LEN * 2 },
    };
  });
  return { doc: renderScheme(out, schemeId), schemeId };
}

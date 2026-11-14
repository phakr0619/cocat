// 実験の記録から作る物: Excel に貼れる表、CSV、1 枚にまとめたページ（印刷・PDF）、検討表の 1 行
import type { Doc } from '../chem/model';
import { edit, newId } from '../chem/model';
import { extract } from '../chem/transform';
import { exportSvg } from '../io/convert';
import { renderTable } from '../table/layout';
import { belowDrawing, createTable } from '../table/ops';
import { baseMaterial, formatPct, runBalance, type RunBalance } from './balance';
import { renderRun } from './layout';
import { formatAmount, formatGrams, toGrams, type Material, type ProcessRun } from './model';
import { materialName, runLabel } from './ops';

const ROLE: Record<Material['role'], string> = { substrate: '基質', reagent: '試薬', solvent: '溶媒', water: '水・水溶液', other: 'その他' };
const num = (v: number | undefined, d: number) => (v === undefined || !isFinite(v) ? '' : v.toFixed(d));

/** 仕込みの 1 行の、計算した値（mmol と、基質 1 g あたりの溶媒量） */
export function materialDerived(run: ProcessRun, m: Material): { mmol?: number; volPerG?: number; grams?: number } {
  const g = toGrams(m.amount, m.density);
  const base = baseMaterial(run);
  const baseG = toGrams(base?.amount, base?.density);
  const mL = m.amount && !['mg', 'g', 'kg'].includes(m.amount.unit) ? m.amount.value * ({ 'µL': 0.001, mL: 1, L: 1000 } as Record<string, number>)[m.amount.unit] : g !== undefined && m.density ? g / m.density : undefined;
  return {
    grams: g,
    mmol: g !== undefined && m.mw ? ((g * (m.assay ?? 100)) / 100 / m.mw) * 1000 : undefined,
    volPerG: m.role === 'solvent' && mL !== undefined && baseG ? mL / baseG : undefined,
  };
}

/** 表の中身（見出しと行）。画面・TSV・ページで同じ物を使う */
export function runTables(doc: Doc, run: ProcessRun, bal: RunBalance = runBalance(run)) {
  const opName = (id: string | undefined) => run.operations.find((o) => o.id === id)?.name ?? run.operations[0]?.name ?? '';
  const materials = {
    head: ['役割', '名前', '分子量', '当量', '量', 'mmol', '溶媒量 (mL/g)', '含量 (wt%)', 'ロット', '入れる操作'],
    rows: run.materials.map((m) => {
      const d = materialDerived(run, m);
      return [ROLE[m.role], materialName(doc, m), num(m.mw, 2), m.equiv === undefined ? '' : String(m.equiv), formatAmount(m.amount), num(d.mmol, 2), num(d.volPerG, 1), m.assay === undefined ? '' : String(m.assay), m.lot ?? '', opName(m.opId)];
    }),
  };
  const events = {
    head: ['時刻', '操作', 'したこと', '量', '内温', '測定・観察'],
    rows: run.events.map((e) => [e.time ?? '', opName(e.opId), e.action, e.amount ?? '', e.temp ?? '', e.note ?? '']),
  };
  const balance = {
    head: ['操作', '入った重さ', '外へ出た物', '次へ進む物', '収支'],
    rows: run.operations.map((op, i) => {
      const b = bal.ops[i];
      const outs = op.outputs.map((o) => `${o.name || '出た物'} ${o.amount ? formatAmount(o.amount) : formatGrams(b.derivedOutputId === o.id ? b.derivedOutputG : undefined)}`.trim()).join('、');
      return [op.name, formatGrams(b.inG), outs, `${formatGrams(b.carryG)}${b.carryDerived ? '（差から）' : ''}`, b.closure !== undefined ? formatPct(b.closure) : b.why ?? (b.carryDerived || b.derivedOutputId ? '差から計算' : '')];
    }),
  };
  const results: [string, string][] = [
    ['収量', formatGrams(bal.productG)],
    ['収率', formatPct(bal.yieldPct)],
    ['含量', run.product.assay === undefined ? '' : `${run.product.assay} wt%`],
    ['含量で補正した収率', formatPct(bal.assayYieldPct)],
    ['PMI', num(bal.pmi, 1)],
    ['PMI の内訳', bal.pmiParts ? `溶媒 ${bal.pmiParts.solvent.toFixed(1)}、水・水溶液 ${bal.pmiParts.water.toFixed(1)}、そのほか ${bal.pmiParts.other.toFixed(1)}` : ''],
    ['全体の収支', formatPct(bal.closure)],
  ];
  return { materials, events, balance, results: results.filter(([, v]) => v) };
}

/** Excel に貼れるタブ区切り（仕込み・操作と記録・収支・結果を、空の行で分けて並べる） */
export function runTsv(doc: Doc, run: ProcessRun): string {
  const t = runTables(doc, run);
  const block = (title: string, head: string[], rows: string[][]) => [title, head.join('\t'), ...rows.map((r) => r.map((c) => c.replace(/[\t\n]/g, ' ')).join('\t'))].join('\n');
  return [
    [runLabel(run), run.date ?? ''].filter(Boolean).join('\t'),
    block('仕込み', t.materials.head, t.materials.rows),
    block('操作と記録', t.events.head, t.events.rows),
    block('収支', t.balance.head, t.balance.rows),
    block('結果', ['項目', '値'], t.results),
  ].join('\n\n');
}

/** 操作と記録の CSV */
export function runEventsCsv(doc: Doc, run: ProcessRun): string {
  const t = runTables(doc, run).events;
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [t.head, ...t.rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 文書の一部（ref が合う物）だけの SVG。物が無ければ空の文字 */
function partSvg(doc: Doc, pick: (ref: string | undefined) => boolean): string {
  const ids = new Set<string>();
  for (const a of Object.values(doc.atoms)) if (pick(a.ref?.split(':')[0])) ids.add(a.id);
  for (const b of Object.values(doc.bonds)) if (ids.has(b.a1) && ids.has(b.a2)) ids.add(b.id);
  for (const rec of [doc.arrows, doc.texts, doc.pluses, doc.shapes ?? {}]) for (const x of Object.values(rec)) if (pick(x.ref)) ids.add(x.id);
  if (!ids.size) return '';
  try {
    return exportSvg(extract(doc, ids));
  } catch {
    return '';
  }
}

/**
 * 実験の記録を 1 枚にまとめたページ（A4 の縦）の HTML。反応式・仕込みの表・フロー図・操作と記録・結果を並べる。
 * フロー図は、紙の幅に収まるように縦に並べる書式で描く
 */
export function runReportHtml(doc: Doc, runId: string): string {
  const run = doc.runs?.[runId];
  if (!run) return '';
  const bal = runBalance(run);
  const t = runTables(doc, run, bal);
  const scheme = run.schemeId ? partSvg(doc, (ref) => ref === run.schemeId) : '';
  const vertical = renderRun(
    edit(doc, (d) => {
      d.runs![runId].flow.direction = 'vertical';
    }),
    runId,
  );
  const flow = partSvg(vertical, (ref) => ref === runId);
  const table = (head: string[], rows: string[][], cls = '') =>
    `<table class="${cls}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const fate = bal.fate.length ? `<h2>生成物の行方</h2>${table(['行き先', '理論収量に対する割合'], [...bal.fate.map((f) => [f.name, formatPct(f.pct)]), ['分からない分', formatPct(bal.fateUnknown)]], 'narrow')}` : '';
  const warn = bal.warnings.length ? `<h2>確かめてほしい所</h2><ul>${bal.warnings.map((w) => `<li>${esc(w.text)}</li>`).join('')}</ul>` : '';
  const title = [runLabel(run), run.date ?? ''].filter(Boolean).join('　');
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size: A4 portrait; margin: 15mm; }
html, body { margin: 0; background: #fff; color: #000; font: 9.5pt/1.45 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; }
h1 { font-size: 14pt; margin: 0 0 6pt; }
h2 { font-size: 10.5pt; margin: 12pt 0 4pt; border-bottom: 0.6pt solid #000; padding-bottom: 2pt; }
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; }
table.narrow { width: auto; min-width: 45%; }
th, td { text-align: left; padding: 2pt 5pt; border-bottom: 0.4pt solid #999; vertical-align: top; }
th { border-bottom: 0.8pt solid #000; font-weight: 600; white-space: nowrap; }
.fig { margin: 4pt 0; }
.fig svg { max-width: 100%; height: auto; display: block; }
ul { margin: 0; padding-left: 14pt; }
section { break-inside: avoid; }
</style></head>
<body data-report="run">
<h1>${esc(title)}</h1>
${scheme ? `<section><h2>反応式</h2><div class="fig" data-part="scheme">${scheme}</div></section>` : ''}
<section><h2>仕込み</h2>${table(t.materials.head, t.materials.rows)}</section>
<section><h2>操作の流れと重さ</h2><div class="fig" data-part="flow">${flow}</div></section>
<section><h2>結果</h2>${table(['項目', '値'], t.results, 'narrow')}</section>
${fate ? `<section>${fate}</section>` : ''}
<section><h2>収支</h2>${table(t.balance.head, t.balance.rows)}</section>
<h2>操作と記録</h2>${table(t.events.head, t.events.rows)}
${warn ? `<section>${warn}</section>` : ''}
</body></html>`;
}

const RUN_COLUMNS: { kind: 'entry' | 'text' | 'number' | 'yield'; label: string; unit?: string }[] = [
  { kind: 'entry', label: 'entry' },
  { kind: 'text', label: 'notebook' },
  { kind: 'text', label: 'scale' },
  { kind: 'number', label: 'product', unit: 'g' },
  { kind: 'yield', label: 'yield', unit: '%' },
  { kind: 'number', label: 'assay', unit: 'wt%' },
  { kind: 'number', label: 'PMI' },
];

/**
 * 記録の 1 回ぶんを、検討表の 1 行にする。回ごとの量・収率・含量・PMI を並べて比べるための表で、
 * 無ければ作り、あれば行を足す（同じ記録の行があれば、その行を書き直す）
 */
export function runToTableRow(doc: Doc, runId: string): { doc: Doc; tableId: string } | null {
  const run = doc.runs?.[runId];
  if (!run) return null;
  const bal = runBalance(run);
  let tableId = Object.values(doc.tables ?? {}).find((t) => t.runIds)?.id ?? '';
  let d = doc;
  if (!tableId) {
    const made = createTable(doc, 'conditions', { origin: belowDrawing(doc) });
    tableId = made.tableId;
    d = edit(made.doc, (x) => {
      const t = x.tables![tableId];
      t.title = 'Summary of the runs';
      t.columns = RUN_COLUMNS.map((c) => ({ ...c, id: newId(x, 'k') }));
      t.rows = [];
      t.notes = [];
      t.runIds = {};
    });
  }
  const base = baseMaterial(run);
  const values = [run.notebook ?? runLabel(run), formatAmount(base?.amount), num(bal.productG, 1), num(bal.yieldPct, 1), run.product.assay === undefined ? '' : String(run.product.assay), num(bal.pmi, 1)];
  d = edit(d, (x) => {
    const t = x.tables![tableId];
    t.runIds ??= {};
    let row = t.rows.find((r) => r.id === t.runIds![runId]);
    if (!row) {
      row = { id: newId(x, 'k'), cells: {} };
      t.rows.push(row);
      t.runIds[runId] = row.id;
    }
    // 列を並べ替えたり消したりしていても、見出しが同じ列に入れる
    RUN_COLUMNS.slice(1).forEach((c, i) => {
      const col = t.columns.find((k) => k.label === c.label);
      if (col) row!.cells[col.id] = values[i];
    });
  });
  return { doc: renderTable(d, tableId), tableId };
}

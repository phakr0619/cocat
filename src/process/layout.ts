// 実験の記録のフロー図の自動の配置。操作を箱にして並べ、入れる物・外へ出る物・次へ進む物を矢印と文字で描く。
// 置いた物には ref（記録の id）を付け、描き直すときはそれを消して置き直す（スキーム・検討表と同じ作り）
import type { Doc } from '../chem/model';
import { edit, newId } from '../chem/model';
import { ACS, applyDrawStyle } from '../chem/style';
import { textWidth } from '../render/text';
import { formatPct, runBalance, type RunBalance } from './balance';
import { formatAmount, formatGrams, toGrams, type Operation, type ProcessRun } from './model';

const lineH = () => ACS.captionSize * 1.25;
const capH = () => ACS.captionSize * 0.72;
const width = (s: string, bold = false) => textWidth(s, ACS.captionSize) * (bold ? 1.08 : 1);
const GREY = '#757575';
/** 名前と量の間。SVG は続けた空白を 1 つにまとめるので、切れない空白を 2 つ使う */
const SEP = '\u00a0\u00a0';
const BOX_H = 22;

/** 文書から、この記録が置いた物を消す */
export function clearRun(d: Doc, runId: string) {
  for (const r of Object.values(d.arrows)) if (r.ref === runId) delete d.arrows[r.id];
  for (const t of Object.values(d.texts)) if (t.ref === runId) delete d.texts[t.id];
  for (const s of Object.values(d.shapes ?? {})) if (s.ref === runId) delete d.shapes![s.id];
}

/** フロー図の箱を、操作の順に並べる（箱を選んだとき、どの操作かを引くのに使う） */
export function runBoxes(doc: Doc, runId: string) {
  return Object.values(doc.shapes ?? {}).filter((s) => s.ref === runId);
}

/** id の物が、どの記録のどの操作の物か。箱なら操作も分かる */
export function runTargetOf(doc: Doc, id: string): { runId: string; opId?: string } | null {
  const ref = doc.shapes?.[id]?.ref ?? doc.arrows[id]?.ref ?? doc.texts[id]?.ref;
  const run = ref ? doc.runs?.[ref] : undefined;
  if (!run) return null;
  const i = doc.shapes?.[id] ? runBoxes(doc, run.id).findIndex((s) => s.id === id) : -1;
  return { runId: run.id, ...(i >= 0 && run.operations[i] ? { opId: run.operations[i].id } : {}) };
}

interface OpText {
  op: Operation;
  ins: string[];
  outs: { text: string; bold?: boolean }[];
  carry: string;
  closure: string;
}

/** 図に出す文字を、操作ごとにまとめる */
function opTexts(doc: Doc, run: ProcessRun, bal: RunBalance): OpText[] {
  const first = run.operations[0]?.id;
  const nameOf = (m: ProcessRun['materials'][number]) => {
    const c = m.compoundId ? doc.compounds?.[m.compoundId] : undefined;
    return c?.number?.trim() || c?.nickname?.trim() || m.name || '（名前なし）';
  };
  const mass = run.flow.showMass;
  return run.operations.map((op, i) => {
    const b = bal.ops[i];
    const last = i === run.operations.length - 1;
    const ins = run.materials
      .filter((m) => (m.opId && run.operations.some((o) => o.id === m.opId) ? m.opId : first) === op.id)
      .map((m) => [nameOf(m), mass ? formatAmount(m.amount) : ''].filter(Boolean).join(SEP));
    const outs: OpText['outs'] = op.outputs.map((o) => {
      const g = toGrams(o.amount, o.density) ?? (b.derivedOutputId === o.id ? b.derivedOutputG : undefined);
      return { text: [o.name || '出た物', mass ? (o.amount ? formatAmount(o.amount) : formatGrams(g)) : ''].filter(Boolean).join(SEP) };
    });
    const carryText = mass ? (op.carry ? formatAmount(op.carry) : formatGrams(b.carryG)) : '';
    if (last) {
      const c = run.product.compoundId ? doc.compounds?.[run.product.compoundId] : undefined;
      const name = c?.number?.trim() || c?.nickname?.trim() || run.product.name || '生成物';
      outs.unshift({ text: [name, carryText].filter(Boolean).join(SEP), bold: true });
    }
    const closure = !mass ? '' : b.closure !== undefined ? `収支 ${formatPct(b.closure)}` : b.carryDerived || b.derivedOutputId ? '差から計算' : '';
    return { op, ins, outs, carry: last ? '' : carryText, closure };
  });
}

/** 図の上の 2 行: 題と、結果のまとめ */
function headLines(run: ProcessRun, bal: RunBalance): string[] {
  const title = [run.title?.trim() || (run.notebook?.trim() ? `実験 ${run.notebook.trim()}` : '実験の記録'), run.title?.trim() && run.notebook?.trim() ? run.notebook.trim() : '', run.date ?? ''].filter(Boolean).join(SEP);
  const parts: string[] = [];
  const base = run.materials.find((m) => m.role === 'substrate');
  if (base?.amount) parts.push(`仕込み ${formatAmount(base.amount)}`);
  if (bal.productG !== undefined && bal.productG > 0) parts.push(`収量 ${formatGrams(bal.productG)}${bal.yieldPct !== undefined ? `（${formatPct(bal.yieldPct)}）` : ''}`);
  if (bal.assayYieldPct !== undefined) parts.push(`含量で補正した収率 ${formatPct(bal.assayYieldPct)}`);
  if (bal.pmi !== undefined) parts.push(`PMI ${bal.pmi.toFixed(1)}`);
  return [title, parts.join(SEP)];
}

/** 記録のフロー図を描き直した文書を返す */
export function renderRun(doc: Doc, runId: string): Doc {
  const run = doc.runs?.[runId];
  if (!run) return doc;
  const restore = applyDrawStyle(doc.drawStyle);
  try {
    const bal = runBalance(run);
    const ops = opTexts(doc, run, bal);
    const head = headLines(run, bal);
    return edit(doc, (d) => {
      clearRun(d, runId);
      d.shapes ??= {};
      const text = (x: number, y: number, s: string, opt: { bold?: boolean; color?: string } = {}) => {
        if (!s) return;
        const id = newId(d, 't');
        d.texts[id] = { id, x, y, text: s, ref: runId, ...(opt.bold ? { bold: true } : {}), ...(opt.color ? { color: opt.color } : {}) };
      };
      const arrow = (x1: number, y1: number, x2: number, y2: number, kind: 'normal' | 'line' = 'normal') => {
        const id = newId(d, 'r');
        d.arrows[id] = { id, x1, y1, x2, y2, kind, ref: runId };
      };
      const box = (x: number, y: number, w: number, h: number) => {
        const id = newId(d, 'h');
        d.shapes![id] = { id, kind: 'rect', x1: x, y1: y, x2: x + w, y2: y + h, ref: runId };
      };
      const { x: x0, y: y0 } = run.origin;
      text(x0, y0 + capH(), head[0], { bold: true });
      text(x0, y0 + capH() + lineH(), head[1]);
      const top = y0 + lineH() * 2 + 10;
      const LH = lineH();
      if (run.flow.direction === 'horizontal') {
        // 左から右へ。入れる物は箱の上、外へ出る物は箱の下
        const maxIn = Math.max(0, ...ops.map((o) => o.ins.length));
        const maxOut = Math.max(0, ...ops.map((o) => o.outs.length));
        const boxTop = top + maxIn * LH + (maxIn ? 14 : 0);
        const mid = boxTop + BOX_H / 2;
        let x = x0;
        ops.forEach((o, i) => {
          const bw = Math.max(52, width(o.op.name, true) + 16);
          const colW = Math.max(bw, ...o.ins.map((s) => width(s)), ...o.outs.map((s) => width(s.text, s.bold)), width(o.closure));
          const cx = x + colW / 2;
          o.ins.forEach((s, j) => text(cx - width(s) / 2, boxTop - 14 - (o.ins.length - 1 - j) * LH, s));
          if (o.ins.length) arrow(cx, boxTop - 11, cx, boxTop - 1);
          box(cx - bw / 2, boxTop, bw, BOX_H);
          text(cx - width(o.op.name, true) / 2, mid + capH() / 2, o.op.name, { bold: true });
          if (o.outs.length) arrow(cx, boxTop + BOX_H + 1, cx, boxTop + BOX_H + 11);
          o.outs.forEach((s, j) => text(cx - width(s.text, s.bold) / 2, boxTop + BOX_H + 14 + capH() + j * LH, s.text, s.bold ? { bold: true } : { color: GREY }));
          text(cx - width(o.closure) / 2, boxTop + BOX_H + 14 + capH() + maxOut * LH + 3, o.closure, { color: GREY });
          if (i < ops.length - 1) {
            const next = ops[i + 1];
            const nbw = Math.max(52, width(next.op.name, true) + 16);
            const ncolW = Math.max(nbw, ...next.ins.map((s) => width(s)), ...next.outs.map((s) => width(s.text, s.bold)), width(next.closure));
            const gap = Math.max(30, width(o.carry) + 14 - (colW - bw) / 2 - (ncolW - nbw) / 2);
            const from = cx + bw / 2 + 1;
            const to = x + colW + gap + ncolW / 2 - nbw / 2 - 1;
            arrow(from, mid, to, mid);
            text((from + to) / 2 - width(o.carry) / 2, mid - 4, o.carry);
            x += colW + gap;
          }
        });
      } else {
        // 上から下へ。入れる物は箱の左、外へ出る物と得た生成物は箱の右
        const leftW = Math.max(0, ...ops.flatMap((o) => o.ins.map((s) => width(s))));
        const bw = Math.max(64, ...ops.map((o) => width(o.op.name, true) + 18));
        const bx = x0 + leftW + (leftW ? 24 : 0);
        const ox = bx + bw + 24;
        const outW = Math.max(0, ...ops.flatMap((o) => o.outs.map((s) => width(s.text, s.bold))));
        const clx = ox + outW + 18;
        const cxm = bx + bw / 2;
        let y = top;
        ops.forEach((o, i) => {
          const n = Math.max(o.ins.length, o.outs.length, 1);
          const bh = Math.max(BOX_H, o.outs.length * LH + 6);
          const blockH = Math.max(bh, n * LH);
          const cy = y + blockH / 2;
          o.ins.forEach((s, j) => text(bx - 24 - width(s), cy + capH() / 2 + (j - (o.ins.length - 1) / 2) * LH, s));
          if (o.ins.length) arrow(bx - 20, cy, bx - 1, cy);
          box(bx, cy - bh / 2, bw, bh);
          text(cxm - width(o.op.name, true) / 2, cy + capH() / 2, o.op.name, { bold: true });
          o.outs.forEach((s, j) => {
            const ly = cy + (j - (o.outs.length - 1) / 2) * LH;
            arrow(bx + bw + 1, ly, bx + bw + 20, ly);
            text(ox, ly + capH() / 2, s.text, s.bold ? { bold: true } : { color: GREY });
          });
          text(clx, cy + capH() / 2, o.closure, { color: GREY });
          if (i < ops.length - 1) {
            const y1 = y + blockH / 2 + bh / 2 + 1;
            const y2 = y + blockH + 26;
            const nextBh = Math.max(BOX_H, ops[i + 1].outs.length * LH + 6);
            const nextBlock = Math.max(nextBh, Math.max(ops[i + 1].ins.length, ops[i + 1].outs.length, 1) * LH);
            const nextTop = y2 + nextBlock / 2 - nextBh / 2 - 1;
            arrow(cxm, y1, cxm, nextTop);
            text(cxm + 6, (y1 + nextTop) / 2 + capH() / 2, o.carry);
          }
          y += blockH + 26;
        });
      }
    });
  } finally {
    restore();
  }
}

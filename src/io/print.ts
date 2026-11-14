// 印刷・PDF: 図を紙（A4・レター）に収めたページを作り、ブラウザの印刷で出す（印刷の画面で「PDF に保存」を選べば PDF になる）
// 文書にページの設定（Doc.page）があれば、キャンバスのページを 1 枚ずつ原寸で、その大きさの紙に出す
import type { Doc } from '../chem/model';
import { pageDims, pageRects } from '../chem/page';
import { layout, primsToSvg } from '../render/layout';
import { exportSvg, svgOfArea } from './convert';

export type Paper = 'A4' | 'Letter';

/** 紙の大きさ（mm）と余白 */
const PAPER: Record<Paper, { w: number; h: number }> = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };
const MARGIN_MM = 15;
const PT_PER_MM = 72 / 25.4;

/**
 * 印刷するページの HTML。図の縦横の比で紙の向きを決め、余白の内側に収める。
 * 小さな図は原寸（ACS の大きさのまま）、大きな図は縮めて 1 ページに入れる
 */
export function printHtml(doc: Doc, paper: Paper = 'A4', title = '図'): string {
  if (doc.page) return pagesHtml(doc, title);
  const svg = exportSvg(doc);
  const m = svg.match(/width="([\d.]+)pt" height="([\d.]+)pt"/);
  const w = m ? parseFloat(m[1]) : 100;
  const h = m ? parseFloat(m[2]) : 100;
  const landscape = w > h * 1.2;
  const p = PAPER[paper];
  const pw = (landscape ? p.h : p.w) - MARGIN_MM * 2;
  const ph = (landscape ? p.w : p.h) - MARGIN_MM * 2;
  // 原寸（pt）が入らなければ縮める
  const k = Math.min(1, (pw * PT_PER_MM) / w, (ph * PT_PER_MM) / h);
  const sized = svg.replace(/width="([\d.]+)pt" height="([\d.]+)pt"/, `width="${(w * k).toFixed(2)}pt" height="${(h * k).toFixed(2)}pt"`);
  const esc = escapeHtml(title);
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${esc}</title>
<style>
@page { size: ${paper} ${landscape ? 'landscape' : 'portrait'}; margin: ${MARGIN_MM}mm; }
html, body { margin: 0; background: #fff; }
.page { display: flex; justify-content: center; align-items: flex-start; }
svg { display: block; }
</style></head>
<body><div class="page" data-paper="${paper}" data-orientation="${landscape ? 'landscape' : 'portrait'}" data-scale="${k.toFixed(3)}">${sized}</div></body></html>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** ページの設定どおりに、1 ページを 1 枚の紙に原寸で出す。紙の大きさはページと同じ（余白は付けない） */
function pagesHtml(doc: Doc, title: string): string {
  const page = doc.page!;
  const { mmW, mmH } = pageDims(page);
  const body = primsToSvg(layout(doc).prims);
  const pages = pageRects(page).map(
    (r, i) => `<div class="page" data-page="${i + 1}">${svgOfArea(r, body).replace(/width="([\d.]+)pt" height="([\d.]+)pt"/, `width="${mmW}mm" height="${mmH}mm"`)}</div>`,
  );
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: ${mmW}mm ${mmH}mm; margin: 0; }
html, body { margin: 0; background: #fff; }
.page { width: ${mmW}mm; height: ${mmH}mm; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
svg { display: block; }
</style></head>
<body data-pages="${pages.length}">${pages.join('\n')}</body></html>`;
}

/** 見えない枠にページを作って、印刷の画面を開く */
export function printDoc(doc: Doc, paper: Paper = 'A4') {
  printPage(printHtml(doc, paper));
}

/** 作ってある HTML のページを、見えない枠に入れて印刷の画面を開く */
export function printPage(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.testid = 'print-frame';
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const w = frame.contentWindow!;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // 印刷の画面を閉じたら枠を外す
  const done = () => setTimeout(() => frame.remove(), 1000);
  w.addEventListener('afterprint', done);
  setTimeout(() => {
    w.focus();
    w.print();
    // afterprint が来ないブラウザのために、少し待っても外す
    setTimeout(done, 60_000);
  }, 50);
}

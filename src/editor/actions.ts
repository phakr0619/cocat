// ボタンとショートカットから呼ぶ編集の操作
import { contractGroup, expandAbbr } from '../chem/abbrOps';
import { kindOf } from '../chem/model';
import { deleteItems } from '../chem/ops';
import { BOND_LEN } from '../chem/style';
import { extract, flipSelection, insertDoc, withInnerBonds } from '../chem/transform';
import { exportPng, importText } from '../io/convert';
import { pngHtml, pngWithData } from '../io/figureData';
import type { Doc } from '../chem/model';
import { docToSmiles } from '../io/smiles';
import type { EditorStore } from './store';

/** 選択が空なら全体を対象にする */
export function targetIds(store: EditorStore): Set<string> {
  const s = store.get();
  if (s.selection.size) return s.selection;
  return allIds(store);
}

export function allIds(store: EditorStore): Set<string> {
  const d = store.get().doc;
  return new Set([...Object.keys(d.atoms), ...Object.keys(d.bonds), ...Object.keys(d.arrows), ...Object.keys(d.texts), ...Object.keys(d.pluses), ...Object.keys(d.shapes ?? {})]);
}

let pasteCount = 0;
/** 最後にほかのアプリへ渡した文字（貼り付けで、このエディタからのものか見分ける） */
let lastText = '';

/**
 * ほかのアプリへ渡す: 図（PNG、300 dpi）と SMILES の文字。Word・PowerPoint では図として、テキストの欄では SMILES として貼れる。
 * 画像を渡せないブラウザでは文字だけ。
 * 図には、あとで Cocat で開き直すためのデータを入れる（docs/reopen-figure.md）。ブラウザは image/png を置くときに画像を作り直して
 * データを捨てるので、データ入りの PNG を中に含む HTML も置く。PowerPoint はこの HTML の画像をそのまま使う。source は part を取り出した元の文書
 */
export function writeSystemClipboard(part: Doc, source: Doc = part): Promise<void> {
  let smi = '';
  try {
    smi = docToSmiles(part).smiles ?? '';
  } catch {
    // 構造でない物（矢印・文字だけ）は SMILES にならない
  }
  lastText = smi;
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb) return Promise.resolve();
  if (typeof ClipboardItem !== 'undefined' && cb.write) {
    const png = exportPng(part).then((b) => pngWithData(b, source, part));
    const items: Record<string, Blob | Promise<Blob>> = { 'text/html': png.then(pngHtml), 'image/png': png };
    if (smi) items['text/plain'] = new Blob([smi], { type: 'text/plain' });
    return cb.write([new ClipboardItem(items)]).catch(() => (smi ? cb.writeText(smi).catch(() => {}) : undefined));
  }
  return smi ? cb.writeText(smi).catch(() => {}) : Promise.resolve();
}

export function copy(store: EditorStore) {
  const s = store.get();
  if (!s.selection.size) return;
  store.clipboard = extract(s.doc, s.selection);
  pasteCount = 0;
  void writeSystemClipboard(store.clipboard, s.doc);
}

/** 図の全体（選んでいれば選んだ物）を、ほかのアプリへ画像でコピーする */
export function copyImage(store: EditorStore) {
  const s = store.get();
  const part = s.selection.size ? extract(s.doc, s.selection) : s.doc;
  if (!Object.keys(part.atoms).length && !Object.keys(part.arrows).length && !Object.keys(part.texts).length) {
    store.set({ message: 'コピーする図がありません' });
    return;
  }
  void writeSystemClipboard(part, s.doc).then(() => store.set({ message: '図をコピーしました。Word・PowerPoint に貼れます' }));
}

export function cut(store: EditorStore) {
  copy(store);
  const s = store.get();
  if (s.selection.size) store.commit(deleteItems(s.doc, s.selection), new Set());
}

/** ほかのアプリから来た文字（SMILES・Molfile・CDXML）なら読み込む。読めた・読めないを返す */
export function pasteText(store: EditorStore, text: string): boolean {
  const t = text.trim();
  if (!t || (store.clipboard && t === lastText)) return false;
  try {
    const r = importText(store.get().doc, t);
    if (!r.ids.size) return false;
    store.commit(r.doc, r.ids);
    store.set({ tool: 'select', message: '貼り付けた文字を構造として読み込みました' });
    return true;
  } catch {
    return false;
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;
/**
 * Ctrl+V: ブラウザの貼り付け（paste の知らせ）を少し待ち、来なければこのエディタの中のコピーを貼る。
 * paste の知らせが来たら pasteEvent が引き継ぐ
 */
export function pasteKey(store: EditorStore) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    paste(store);
  }, 60);
}

export function pasteEvent(store: EditorStore, text: string) {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  if (!pasteText(store, text)) paste(store);
}

/** メニューの「貼り付け」: 読めればほかのアプリの文字、無ければこのエディタの中のコピー */
export function pasteMenu(store: EditorStore) {
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb?.readText) return paste(store);
  cb.readText().then(
    (t) => pasteText(store, t) || paste(store),
    () => paste(store),
  );
}

export function paste(store: EditorStore) {
  if (!store.clipboard) return;
  pasteCount++;
  const off = BOND_LEN * 1.5 * pasteCount;
  const { doc, ids } = insertDoc(store.get().doc, store.clipboard, { x: off, y: off });
  store.commit(doc, ids);
  store.set({ tool: 'select' });
}

export function selectAll(store: EditorStore) {
  store.set({ selection: allIds(store), tool: store.get().tool === 'lasso' ? 'lasso' : 'select' });
}

export function flip(store: EditorStore, axis: 'h' | 'v') {
  const s = store.get();
  store.commit(flipSelection(s.doc, targetIds(store), axis));
}

/** 選択（無ければカーソルの下か全体）の略号を展開する */
export function expandAbbrs(store: EditorStore) {
  const s = store.get();
  const ids = s.selection.size ? s.selection : s.hover ? new Set([s.hover]) : allIds(store);
  let d = s.doc;
  let n = 0;
  for (const id of ids) {
    if (kindOf(id) === 'atom' && d.atoms[id]?.abbr) {
      try {
        d = expandAbbr(d, id);
        n++;
      } catch (e) {
        store.set({ message: String(e) });
      }
    }
  }
  if (n) store.commit(d, new Set());
  else store.set({ message: '展開できる略号がありません。略号の原子を選ぶか、カーソルを合わせてください' });
}

/** 展開した略号のうち、選択（無ければ全部）に関わるものを縮約に戻す */
export function contractAbbrs(store: EditorStore) {
  const s = store.get();
  const ids = s.selection.size ? withInnerBonds(s.doc, s.selection) : s.hover ? new Set([s.hover]) : null;
  let d = s.doc;
  let n = 0;
  for (const g of Object.values(s.doc.groups)) {
    if (ids && !g.atomIds.some((a) => ids.has(a))) continue;
    d = contractGroup(d, g.id);
    n++;
  }
  if (n) store.commit(d, new Set());
  else store.set({ message: '縮約できる略号がありません。縮約に戻せるのは、展開した略号だけです' });
}

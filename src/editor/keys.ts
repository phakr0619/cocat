// キーボードショートカット（ChemDraw に合わせたもの）
import { findAbbr } from '../chem/abbreviations';
import { isElement } from '../chem/elements';
import { kindOf } from '../chem/model';
import { changeCharge, deleteItems, setAbbr, setBondOrder, setElement } from '../chem/ops';
import type { EditorStore } from './store';

/** 原子にカーソルを合わせて押すキー → 元素（または略号） */
export const ATOM_KEYS: Record<string, string> = {
  c: 'C', n: 'N', o: 'O', s: 'S', f: 'F', p: 'P', b: 'Br', l: 'Cl', i: 'I', h: 'H', k: 'K', m: 'Me', e: 'Et',
};

export interface KeyActions {
  copy(): void;
  cut(): void;
  paste(): void;
  /** Ctrl+V。ブラウザの貼り付けを待ってから、このエディタの中のコピーを貼る */
  pasteKey(): void;
  selectAll(): void;
  clean(): void;
  flip(axis: 'h' | 'v'): void;
  openLabelEditor(atomId: string): void;
}

/** 処理したら true */
export function handleKey(store: EditorStore, e: KeyboardEvent, actions: KeyActions): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
  const s = store.get();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (mod) {
    const k = key.toLowerCase();
    if (k === 'z' && !e.shiftKey) store.undo();
    else if ((k === 'z' && e.shiftKey) || k === 'y') store.redo();
    else if (k === 'c') actions.copy();
    else if (k === 'x') actions.cut();
    else if (k === 'v' && !e.shiftKey) {
      // ブラウザの貼り付け（ほかのアプリの文字）を通すため、既定の動きは止めない
      actions.pasteKey();
      return false;
    }
    else if (k === 'a') actions.selectAll();
    else if (k === 'k' && e.shiftKey) actions.clean();
    else if (k === 'h' && e.shiftKey) actions.flip('h');
    else if (k === 'v' && e.shiftKey) actions.flip('v');
    else return false;
    return true;
  }
  if (key === 'Delete' || key === 'Backspace') {
    if (s.selection.size) store.commit(deleteItems(s.doc, s.selection), new Set());
    else if (s.hover) store.commit(deleteItems(s.doc, [s.hover]));
    else return false;
    return true;
  }
  if (key === 'Escape') {
    store.set({ selection: new Set() });
    return true;
  }
  const hover = s.hover;
  if (!hover) return false;
  if (kindOf(hover) === 'atom') {
    if (key === 'Enter') {
      actions.openLabelEditor(hover);
      return true;
    }
    if (key === '+' || key === '=') {
      store.commit(changeCharge(s.doc, hover, 1));
      return true;
    }
    if (key === '-') {
      store.commit(changeCharge(s.doc, hover, -1));
      return true;
    }
    const label = ATOM_KEYS[key.toLowerCase()];
    if (label && !e.altKey) {
      if (isElement(label)) store.commit(setElement(s.doc, hover, label));
      else {
        const ab = findAbbr(label);
        if (ab) store.commit(setAbbr(s.doc, hover, ab));
      }
      return true;
    }
  } else if (kindOf(hover) === 'bond') {
    if (key === '1' || key === '2' || key === '3') {
      store.commit(setBondOrder(s.doc, hover, Number(key) as 1 | 2 | 3));
      return true;
    }
    const st = ({ w: 'wedge', h: 'hash', y: 'wavy' } as const)[key.toLowerCase() as 'w' | 'h' | 'y'];
    if (st) {
      store.commit(setBondOrder(s.doc, hover, 1, st));
      return true;
    }
  }
  return false;
}

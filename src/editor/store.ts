// エディタの状態。文書の履歴（undo/redo）、選択、ツール、カーソルの下の物を持つ。
import { useSyncExternalStore } from 'react';
import type { Doc } from '../chem/model';
import { emptyDoc } from '../chem/model';
import { syncSchemes } from '../scheme/sync';
import { syncTables } from '../table/sync';
import { syncRuns } from '../process/sync';
import type { BondTool } from '../chem/ops';
import type { Structure } from '../scheme/model';

export type RingTool = 'ring3' | 'ring4' | 'ring5' | 'ring6' | 'ring7' | 'ring8' | 'benzene' | 'chair';
export type ArrowTool = 'arrow-normal' | 'arrow-equilibrium' | 'arrow-retro' | 'arrow-resonance' | 'arrow-dashed' | 'arrow-nogo';
/** 反応機構の印: 曲がった矢印（電子 2 個・1 個）、ローンペア、ラジカル、部分電荷 */
/** 図形: 四角・楕円・括弧の組・線 */
export type ShapeTool = 'rect' | 'oval' | 'bracket-square' | 'bracket-round' | 'bracket-curly' | 'shape-line';
export type MechanismTool = 'arrow-curved' | 'arrow-fishhook' | 'lone-pair' | 'radical' | 'delta-plus' | 'delta-minus';
/** part は部品のパレットから選んだ部品を置く（どの部品かは EditorState.part） */
export type Tool = BondTool | 'chain' | 'select' | 'lasso' | 'erase' | RingTool | ArrowTool | MechanismTool | ShapeTool | 'text' | 'plus' | 'part';

export interface EditorState {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  selection: Set<string>;
  tool: Tool;
  hover: string | null;
  message: string;
  /** 部品のツールで置く部品 */
  part?: { id: string; name: string; structure: Structure } | null;
  /** 書き出し・保存のファイルの名前（拡張子なし）。空なら structure。開いたファイルの名前を入れ、「新規」で空にする */
  fileName?: string;
}

const HISTORY_LIMIT = 200;

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<() => void>();
  clipboard: Doc | null = null;

  constructor(doc: Doc = emptyDoc()) {
    this.state = { doc, past: [], future: [], selection: new Set(), tool: 'single', hover: null, message: '' };
  }

  get = () => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(partial: Partial<EditorState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((l) => l());
  }

  /** 文書を変える（履歴に積む）。同じ doc なら何もしない */
  commit(doc: Doc, selection?: Set<string>) {
    const s = this.state;
    if (doc === s.doc) return;
    // スキームの分子・表の母核を直したら、データへ戻して描き直す
    doc = syncRuns(s.doc, syncTables(s.doc, syncSchemes(s.doc, doc)));
    const past = [...s.past, s.doc].slice(-HISTORY_LIMIT);
    // カーソルの下の物が残っていれば、続けてキーで編集できるように保つ
    const hover = s.hover && exists(doc, s.hover) ? s.hover : null;
    this.set({ doc, past, future: [], selection: selection ?? pruneSelection(s.selection, doc), hover, message: '' });
  }

  /** ドラッグ中の見た目だけ変える（履歴に積まない）。終わったら commitFrom で確定する */
  preview(doc: Doc) {
    this.set({ doc });
  }

  /** base から doc への変更を1回分として履歴に積む */
  commitFrom(base: Doc, doc: Doc, selection?: Set<string>) {
    const s = this.state;
    doc = syncRuns(base, syncTables(base, syncSchemes(base, doc)));
    const past = [...s.past, base].slice(-HISTORY_LIMIT);
    this.set({ doc, past, future: [], selection: selection ?? pruneSelection(s.selection, doc) });
  }

  undo() {
    const s = this.state;
    const prev = s.past.at(-1);
    if (!prev) return;
    this.set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], selection: new Set(), hover: null });
  }

  redo() {
    const s = this.state;
    const next = s.future[0];
    if (!next) return;
    this.set({ doc: next, past: [...s.past, s.doc], future: s.future.slice(1), selection: new Set(), hover: null });
  }
}

const exists = (doc: Doc, id: string) => !!(doc.atoms[id] || doc.bonds[id] || doc.arrows[id] || doc.texts[id] || doc.pluses[id] || doc.shapes?.[id]);

function pruneSelection(sel: Set<string>, doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const id of sel) if (exists(doc, id)) out.add(id);
  return out;
}

export function useEditor<T>(store: EditorStore, pick: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}

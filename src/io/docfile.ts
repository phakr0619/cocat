// エディタの文書をそのまま保存する形式（.acedoc、JSON）。版の番号で将来の形の変更に備える
import type { Doc } from '../chem/model';
import { normalizePage } from '../chem/page';

export const DOC_FORMAT = 'ai-chem-editor';
/** 2: 反応スキームのデータ（compounds・schemes）を足した。3: 検討表（tables）を足した */
export const DOC_VERSION = 3;
export const DOC_EXT = '.acedoc';

export interface DocFile {
  format: typeof DOC_FORMAT;
  version: number;
  savedAt: string;
  doc: Doc;
}

export function serializeDoc(doc: Doc, now = new Date()): string {
  const file: DocFile = { format: DOC_FORMAT, version: DOC_VERSION, savedAt: now.toISOString(), doc };
  return JSON.stringify(file, null, 1);
}

export function isDocFile(text: string): boolean {
  return /^\s*\{/.test(text) && text.includes(`"${DOC_FORMAT}"`);
}

/** 読めなければ理由を添えて投げる */
export function parseDocFile(text: string): Doc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文書のファイルが JSON として読めません');
  }
  const f = data as Partial<DocFile>;
  if (f.format !== DOC_FORMAT) throw new Error('ai-chem-editor の文書ではありません');
  if (typeof f.version !== 'number' || f.version > DOC_VERSION) {
    throw new Error(`この文書は新しい版（${f.version}）で保存されています。エディタを更新してください`);
  }
  const d = f.doc as Doc | undefined;
  if (!d || typeof d !== 'object' || !d.atoms || !d.bonds) throw new Error('文書の中身が足りません');
  // 版 1 にはスキームのデータ、版 2 までは検討表が無い。足りない入れ物だけ補う
  return {
    compounds: d.compounds ?? {},
    schemes: d.schemes ?? {},
    tables: d.tables ?? {},
    ...(d.styles ? { styles: d.styles } : {}),
    ...(d.shapes ? { shapes: d.shapes } : {}),
    ...(d.drawStyle ? { drawStyle: d.drawStyle } : {}),
    ...(d.page ? { page: normalizePage(d.page) } : {}),
    atoms: d.atoms,
    bonds: d.bonds,
    arrows: d.arrows ?? {},
    texts: d.texts ?? {},
    pluses: d.pluses ?? {},
    groups: d.groups ?? {},
    nextId: typeof d.nextId === 'number' ? d.nextId : nextIdFor(d),
  };
}

function nextIdFor(d: Partial<Doc>): number {
  let max = 0;
  for (const rec of [d.atoms, d.bonds, d.arrows, d.texts, d.pluses, d.groups, d.shapes]) {
    for (const id of Object.keys(rec ?? {})) max = Math.max(max, parseInt(id.slice(1), 10) || 0);
  }
  return max + 1;
}

// ---------------------------------------------------------------- 自動保存（ブラウザの中だけ）

const AUTOSAVE_KEY = 'ai-chem-editor:autosave';

export function loadAutosave(): Doc | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? parseDocFile(text) : null;
  } catch {
    return null;
  }
}

export function saveAutosave(doc: Doc) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeDoc(doc));
  } catch {
    // 容量オーバーや無効化されたストレージでは、自動保存をあきらめる
  }
}

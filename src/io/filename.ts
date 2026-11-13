// 書き出すファイルの名前。利用者が付けた名前（拡張子なし）に形式の拡張子を足す

/** 名前が無いときの名前 */
export const DEFAULT_FILE_BASE = 'structure';

/** 名前の終わりに付いていたら外す拡張子（付けたまま入れても、二重に付かないように） */
const KNOWN_EXT = /\.(acedoc|smi|smiles|mol|sdf|cdxml|cdx|svg|png|json|csv|xlsx|zip|rxn)$/i;

/** 開いたファイルの名前から、拡張子とフォルダを外した名前 */
export function baseNameOf(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** ファイルの名前に使えない文字（Windows で使えないもの・制御文字）を外し、前後の空白と点を落とす */
export function cleanFileBase(base: string): string {
  return base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(KNOWN_EXT, '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
}

/** 書き出すファイルの名前（例: fileNameFor('アスピリン', '.cdx') → 'アスピリン.cdx'） */
export function fileNameFor(base: string | undefined, ext: string): string {
  return `${cleanFileBase(base ?? '') || DEFAULT_FILE_BASE}${ext}`;
}

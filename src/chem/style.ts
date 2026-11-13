// ACS Document 1996 の既定値（ChemDraw の「ACS Document 1996」スタイル）。単位は pt。
// 線の太さと文字の大きさは、文書の図の設定（Doc.drawStyle）で変えられる。描くあいだだけ applyDrawStyle で入れ替える
export const ACS = {
  bondLength: 14.4,
  lineWidth: 0.6,
  boldWidth: 2.0,
  /** 原子ラベルの周りの余白 */
  marginWidth: 1.6,
  hashSpacing: 2.5,
  /** 二重結合の線の間隔（結合長に対する割合） */
  bondSpacing: 0.18,
  chainAngle: 120,
  font: 'Arial, Helvetica, sans-serif',
  fontName: 'Arial',
  labelSize: 10,
  captionSize: 10,
};

/** 文書の図の設定（無ければ ACS Document 1996 の値） */
export interface DrawStyle {
  /** 線の太さ（pt） */
  lineWidth?: number;
  /** 原子のラベルと文字の大きさ（pt） */
  fontSize?: number;
}

export const DEFAULT_DRAW = { lineWidth: 0.6, fontSize: 10 };

/** 図の設定を描くあいだだけ当てる。戻り値で元に戻す（入れ子で呼んでもよい） */
export function applyDrawStyle(ds: DrawStyle | undefined): () => void {
  const before = { lineWidth: ACS.lineWidth, labelSize: ACS.labelSize, captionSize: ACS.captionSize };
  ACS.lineWidth = ds?.lineWidth ?? DEFAULT_DRAW.lineWidth;
  ACS.labelSize = ds?.fontSize ?? DEFAULT_DRAW.fontSize;
  ACS.captionSize = ds?.fontSize ?? DEFAULT_DRAW.fontSize;
  return () => Object.assign(ACS, before);
}

export const BOND_LEN = ACS.bondLength;
export const DOUBLE_GAP = ACS.bondLength * ACS.bondSpacing;
/** くさびの太い端の幅 */
export const WEDGE_WIDTH = ACS.boldWidth * 1.5;

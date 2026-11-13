// 文字の入力欄の下に出す書式のボタン: 化学式（数字を下付き）・下付き・上付き・斜体。
// 書式は文字の欄の書き方（_{…}・^{…}・*…*。src/render/text.ts の parseRich）を入れる
import type { CSSProperties } from 'react';

/** 選んだ範囲を open と close で囲む。選んでいなければ open+close を入れ、カーソルを間に置く */
export function wrapSelection(value: string, start: number, end: number, open: string, close: string): { value: string; at: number } {
  const sel = value.slice(start, end);
  return { value: value.slice(0, start) + open + sel + close + value.slice(end), at: start + open.length + sel.length + (sel ? close.length : 0) };
}

export function TextFormatBar({
  style,
  formula,
  onFormula,
  onWrap,
}: {
  style: CSSProperties;
  formula: boolean;
  onFormula(v: boolean): void;
  onWrap(open: string, close: string): void;
}) {
  // ボタンを押しても入力欄のフォーカスを外さない（外すと文字が確定して閉じる）
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="text-format" style={style} data-testid="text-format">
      <label title="英字のあとの数字を下付きにする。例: CH2Cl2 → CH₂Cl₂、Pd2(dba)3" onMouseDown={keep}>
        <input type="checkbox" checked={formula} onChange={(e) => onFormula(e.target.checked)} data-testid="text-formula" />
        化学式
      </label>
      <button type="button" tabIndex={-1} title="下付き。_{…} で囲む" onMouseDown={keep} onClick={() => onWrap('_{', '}')} data-testid="text-sub">
        x<sub>2</sub>
      </button>
      <button type="button" tabIndex={-1} title="上付き。^{…} で囲み、電荷の + などに使う" onMouseDown={keep} onClick={() => onWrap('^{', '}')} data-testid="text-sup">
        x<sup>2</sup>
      </button>
      <button type="button" tabIndex={-1} title="斜体。*…* で囲み、t-BuOK の t などに使う" onMouseDown={keep} onClick={() => onWrap('*', '*')} data-testid="text-italic">
        <i>I</i>
      </button>
      <small>Enter で確定・Shift+Enter で改行</small>
    </div>
  );
}

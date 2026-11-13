// 左の道具の列の幅を、右の縁のつまみのドラッグ（矢印キーでも）で変える。幅はブラウザに覚える
import { useRef, useState, type CSSProperties } from 'react';

const KEY = 'ai-chem-editor:tools-width';
export const TOOLS_W_DEFAULT = 92;
export const TOOLS_W_MIN = 64;
export const TOOLS_W_MAX = 260;

const clamp = (w: number) => Math.round(Math.min(TOOLS_W_MAX, Math.max(TOOLS_W_MIN, w)));

/** 幅に合わせた道具の列の数。対になる道具（くさびの実線と破線）が同じ行に来るよう、いつも偶数 */
export function toolColumns(w: number): number {
  return 2 * Math.max(1, Math.floor((w - 14) / 78));
}

export function useToolsWidth() {
  const [w, setW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(KEY));
      return v ? clamp(v) : TOOLS_W_DEFAULT;
    } catch {
      return TOOLS_W_DEFAULT;
    }
  });
  const set = (v: number, save = true) => {
    const c = clamp(v);
    setW(c);
    if (!save) return;
    try {
      localStorage.setItem(KEY, String(c));
    } catch {
      // 覚えられなくても、開いている間はその幅で使える
    }
  };
  const style = { '--tools-w': `${w}px`, '--tool-cols': toolColumns(w) } as CSSProperties;
  return { width: w, setWidth: set, style };
}

export function ToolsResize({ width, setWidth }: { width: number; setWidth(w: number, save?: boolean): void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      className={`tools-resize${active ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="道具の列の幅"
      aria-valuenow={width}
      aria-valuemin={TOOLS_W_MIN}
      aria-valuemax={TOOLS_W_MAX}
      tabIndex={0}
      title="ドラッグで道具の列の幅を変える。ダブルクリックすると元の幅に戻る"
      data-testid="tools-resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setActive(true);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (drag.current) setWidth(drag.current.w + e.clientX - drag.current.x, false);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        setWidth(drag.current.w + e.clientX - drag.current.x);
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={() => setWidth(TOOLS_W_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth(width - 8);
        else if (e.key === 'ArrowRight') setWidth(width + 8);
      }}
    />
  );
}

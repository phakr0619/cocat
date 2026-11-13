// 上のバーのメニュー（ファイル・編集・整える・ヘルプ）。押すと下に項目の一覧を開き、項目を押すか外を押すか Esc で閉じる
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onClick(): void;
  /** キーの操作（「Ctrl+Z」）。右に薄く出す */
  shortcut?: string;
  title?: string;
  disabled?: boolean;
  testId?: string;
  /** 項目の左に出す色の丸（色のメニュー） */
  swatch?: string;
}
/** 区切り線か、項目のまとまりの見出し */
export type MenuEntry = MenuItem | { sep: true } | { heading: string };

export function Menu({ label, items, testId, title, icon }: { label: string; items: MenuEntry[]; testId?: string; title?: string; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="menu-button" aria-haspopup="menu" aria-expanded={open} data-testid={testId} title={title} onClick={() => setOpen((v) => !v)}>
        {icon}
        {label}
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label={label}>
          {items.map((it, i) =>
            'sep' in it ? (
              <hr key={i} />
            ) : 'heading' in it ? (
              <div key={i} className="menu-heading">{it.heading}</div>
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                aria-label={it.label}
                disabled={it.disabled}
                title={it.title}
                data-testid={it.testId}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                <span>
                  {it.swatch && <i className="swatch" style={{ background: it.swatch }} aria-hidden="true" />}
                  {it.label}
                </span>
                {it.shortcut && <kbd>{it.shortcut}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

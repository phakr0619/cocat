// 上のバーのメニュー（ファイル・編集・整える・ヘルプ）。押すと下に項目の一覧を開き、項目を押すか外を押すか Esc で閉じる
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';

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

/** ariaLabel を渡すと、label をアイコンとして出す（▾ を付けない） */
export function Menu({ label, items, testId, title, icon, ariaLabel }: { label: string; items: MenuEntry[]; testId?: string; title?: string; icon?: ReactNode; ariaLabel?: string }) {
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
      <button type="button" className={`menu-button${ariaLabel ? ' icon-menu' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} data-testid={testId} title={title} onClick={() => setOpen((v) => !v)}>
        {icon}
        {ariaLabel ? <span aria-hidden="true">{label}</span> : label}
        {!ariaLabel && <span className="caret" aria-hidden="true">▾</span>}
      </button>
      {open && <MenuList label={ariaLabel ?? label} items={items} onPick={() => setOpen(false)} />}
    </div>
  );
}

/** メニューの項目の一覧。項目を押すと onPick を呼んでから、その項目の操作をする */
export function MenuList({ label, items, onPick, style, listRef, testId }: { label: string; items: MenuEntry[]; onPick(): void; style?: CSSProperties; listRef?: Ref<HTMLDivElement>; testId?: string }) {
  return (
        <div className="menu-list" role="menu" aria-label={label} style={style} ref={listRef} data-testid={testId}>
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
                  onPick();
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
  );
}

/** 画面の決まった所に開くメニュー（右クリック・選んだ物の帯の「ほかの操作」）。外を押すか Esc で閉じる。画面からはみ出さないように寄せる */
export function PopupMenu({ at, label, items, onClose, testId }: { at: { x: number; y: number }; label: string; items: MenuEntry[]; onClose(): void; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at.x, at.y]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return <MenuList label={label} items={items} onPick={onClose} listRef={ref} testId={testId} style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 60 }} />;
}

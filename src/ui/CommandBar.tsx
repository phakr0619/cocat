// 上のバーの入力欄（Ctrl+K）。打った文字で、構造（名前・SMILES）・雛形・操作をまとめて探す。
// 構造は、手元の辞書・ライブラリ・SMILES・OPSIN の順に読む。AI は使わない
import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '../analytics';
import { TEMPLATE_GROUPS, type Template } from '../chem/templates';
import type { EditorStore } from '../editor/store';
import { importText } from '../io/convert';
import { resolveLocally } from '../llm/nameToStructure';
import type { LibraryCompound } from '../project/model';
import type { MenuEntry } from './Menu';
import { resolveName } from './NewSchemeForm';
import { templateStructure } from './TemplatePalette';

interface Item {
  group: '構造を置く' | '雛形' | '操作';
  label: string;
  sub?: string;
  shortcut?: string;
  disabled?: boolean;
  run(): void | Promise<void>;
}

const SOURCE = { dictionary: '手元の辞書', library: 'ライブラリ', smiles: 'SMILES' } as const;

export function CommandBar({ store, menus, library }: { store: EditorStore; menus: { name: string; items: MenuEntry[] }[]; library(): LibraryCompound[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Ctrl+K（Mac は ⌘K）で、どこからでも入力欄へ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown);
    };
  }, []);

  const place = (smiles: string, how: string) => {
    const { doc, ids } = importText(store.get().doc, smiles, 'name.smi');
    store.commit(doc, ids);
    store.set({ tool: 'select', message: `${how}から構造を置きました` });
  };

  const items = useMemo<Item[]>(() => {
    const t = q.trim();
    if (!t) return [];
    const low = t.toLowerCase();
    const out: Item[] = [];
    // 構造: 手元で読めればすぐ置く。読めなければ、Enter で OPSIN に名前を送って読む
    let hit: ReturnType<typeof resolveLocally> = null;
    try {
      hit = resolveLocally(t, library());
    } catch {
      hit = null;
    }
    if (hit) {
      const h = hit;
      out.push({ group: '構造を置く', label: h.label ?? t, sub: SOURCE[h.source], run: () => (place(h.smiles, SOURCE[h.source]), track(`command:structure-${h.source}`)) });
    }
    // 手元で読めない名前は、操作と雛形の後ろに出す（操作の名前を打ったときに、先頭が操作になるように）
    const viaOpsin: Item[] = [];
    if (!hit && t.length >= 3) {
      viaOpsin.push({
        group: '構造を置く',
        label: `「${t}」を名前として読む`,
        sub: 'OPSIN',
        run: async () => {
          setBusy(true);
          try {
            const r = await resolveName(t);
            if (r) (place(r.smiles, 'OPSIN'), track('command:structure-opsin'));
            else store.set({ message: `「${t}」を構造にできませんでした。慣用名は「ファイル」の「名前から構造を置く…」で AI に調べさせられます` });
          } finally {
            setBusy(false);
          }
        },
      });
    }
    // 雛形
    const templates: Template[] = TEMPLATE_GROUPS.flatMap((g) => g.items).filter((x) => x.name.toLowerCase().includes(low) || (x.note ?? '').toLowerCase().includes(low));
    for (const x of templates.slice(0, 5))
      out.push({
        group: '雛形',
        label: x.name,
        sub: x.note ?? 'クリックした所に置く',
        run: () => (store.set({ tool: 'part', part: { id: `tpl:${x.name}`, name: x.name, structure: templateStructure(x) }, message: `クリックした所に「${x.name}」を置きます` }), track('command:template')),
      });
    // 操作: メニューの項目すべて
    for (const m of menus)
      for (const it of m.items) {
        if (!('label' in it) || !it.label.toLowerCase().includes(low)) continue;
        out.push({ group: '操作', label: it.label.replace(/^[⇋⇵]\s*/, ''), sub: m.name, shortcut: it.shortcut, disabled: it.disabled, run: () => (it.onClick(), track('command:menu')) });
      }
    return [...out.slice(0, 13), ...viaOpsin];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, menus]);

  useEffect(() => setIndex(0), [q]);

  const run = async (it: Item | undefined) => {
    if (!it || it.disabled) return;
    setOpen(false);
    setQ('');
    ref.current?.blur();
    try {
      await it.run();
    } catch (e) {
      store.set({ message: String((e as Error).message ?? e) });
    }
  };

  let last = '';
  return (
    <div className="cmd" ref={boxRef}>
      <input
        ref={ref}
        className="cmd-input"
        data-testid="command-input"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls="command-list"
        aria-label="名前・SMILES・操作を入力"
        placeholder={busy ? '名前を読んでいます…' : '名前・SMILES・操作を入力'}
        value={q}
        spellCheck={false}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(items.length - 1, i + 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
          else if (e.key === 'Enter') void run(items[index]);
          else if (e.key === 'Escape') (setOpen(false), setQ(''), ref.current?.blur());
        }}
      />
      <kbd className="cmd-key" aria-hidden="true">Ctrl K</kbd>
      {open && q.trim() && (
        <div className="cmd-list" id="command-list" role="listbox" data-testid="command-list">
          {items.length === 0 && <div className="cmd-empty">当てはまる物がありません</div>}
          {items.map((it, i) => {
            const head = it.group !== last;
            last = it.group;
            return (
              <div key={`${it.group}:${it.label}:${i}`}>
                {head && <div className="cmd-group">{it.group}</div>}
                <button type="button" role="option" aria-selected={i === index} className={`cmd-item${i === index ? ' on' : ''}`} disabled={it.disabled} data-testid="command-item" onPointerEnter={() => setIndex(i)} onClick={() => void run(it)}>
                  <span>{it.label}</span>
                  <small>{[it.sub, it.shortcut].filter(Boolean).join('  ')}</small>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

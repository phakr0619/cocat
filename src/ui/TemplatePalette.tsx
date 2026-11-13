// 雛形（テンプレート）の一覧。左の道具の「雛形」から開き、選ぶとキャンバスをクリックした所に置ける（部品と同じ置き方）
import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '../analytics';
import { emptyDoc } from '../chem/model';
import { TEMPLATE_GROUPS, type Template } from '../chem/templates';
import { useEditor, type EditorStore } from '../editor/store';
import { importText } from '../io/convert';
import { structureSvg } from '../render/layout';
import { structureFrom, type Structure } from '../scheme/model';

const cache = new Map<string, Structure>();

/** 雛形の構造（RDKit で座標を作る。一度作ったものは覚えておく） */
export function templateStructure(t: Template): Structure {
  const hit = cache.get(t.smiles);
  if (hit) return hit;
  const d = importText(emptyDoc(), t.smiles).doc;
  const s = structureFrom(d, Object.keys(d.atoms));
  cache.set(t.smiles, s);
  return s;
}

function Thumb({ t }: { t: Template }) {
  const svg = useMemo(() => {
    try {
      const s = templateStructure(t);
      return structureSvg({ ...emptyDoc(), atoms: s.atoms, bonds: s.bonds, groups: s.groups }, 72, 48);
    } catch {
      return '';
    }
  }, [t]);
  // 自前で作った SVG（文字はエスケープ済み）
  return <span className="tpl-thumb" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function TemplatePalette({ store }: { store: EditorStore }) {
  // 左の道具の列は縦にスクロールするので、一覧は画面に固定して、押したボタンの右に出す
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const [group, setGroup] = useState(0);
  const current = useEditor(store, (s) => (s.tool === 'part' ? s.part?.id : null));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const choose = (t: Template) => {
    try {
      store.set({ tool: 'part', part: { id: `tpl:${t.name}`, name: t.name, structure: templateStructure(t) }, message: `クリックした所に「${t.note ?? t.name}」を置きます` });
      track('template:choose');
      setOpen(null);
    } catch (e) {
      store.set({ message: String((e as Error).message ?? e) });
    }
  };
  return (
    <div className="tpl" ref={ref}>
      <button
        type="button"
        className={current?.startsWith('tpl:') ? 'active' : ''}
        data-testid="open-templates"
        aria-expanded={!!open}
        title="ナフタレン・ピリジン・インドールなどの芳香環と、アミノ酸・糖・核酸塩基・環の骨格の雛形を選んで置く"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen((v) => (v ? null : { x: r.right + 6, y: Math.max(8, Math.min(r.top, window.innerHeight - 420)) }));
        }}
      >
        芳香環・雛形
      </button>
      {open && (
        <div className="tpl-panel" role="dialog" aria-label="芳香環・雛形" data-testid="templates" style={{ left: open.x, top: open.y }}>
          <div className="tpl-tabs" role="tablist">
            {TEMPLATE_GROUPS.map((g, i) => (
              <button key={g.name} type="button" role="tab" aria-selected={group === i} className={group === i ? 'on' : ''} onClick={() => setGroup(i)}>
                {g.name}
              </button>
            ))}
          </div>
          <div className="tpl-grid">
            {TEMPLATE_GROUPS[group].items.map((t) => (
              <button key={t.name} type="button" className="tpl-item" data-testid="template" title={t.note ?? t.name} onClick={() => choose(t)}>
                <Thumb t={t} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

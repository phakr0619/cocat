import { useState, type ReactNode } from 'react';
import { TOOL_KEYS } from '../editor/keys';
import type { EditorStore, Tool } from '../editor/store';
import { track } from '../analytics';
import { useEditor } from '../editor/store';
import { TemplatePalette } from './TemplatePalette';
import { hasToolIcon, ToolIcon } from './ToolIcon';

export interface ToolDef {
  id: Tool;
  label: string;
  title: string;
}

/**
 * 道具の並び。グループの中は 2 列に並ぶので、対になる道具（くさびの実線と破線など）は同じ行に来るよう 2 つずつ並べる。
 * 結合と環は ToolIcon の絵で出し、label は絵が無いときと、畳んだグループの見出しの印に使う
 */
export const TOOL_GROUPS: { name: string; tools: ToolDef[] }[] = [
  {
    name: '選択',
    tools: [
      { id: 'select', label: '▭', title: '矩形選択。ドラッグで範囲を選んで動かし、ハンドルで回す' },
      { id: 'lasso', label: '◌', title: '投げ縄選択' },
      { id: 'erase', label: '⌫', title: '消しゴム' },
    ],
  },
  {
    name: '結合',
    tools: [
      { id: 'single', label: '─', title: '単結合。クリックで伸ばし、描いてある結合をクリックすると次数が切り替わる' },
      { id: 'double', label: '═', title: '二重結合。描いてある二重結合をクリックすると、線の位置が切り替わる' },
      { id: 'wedge', label: '◀', title: '実線のくさび: 手前に出る結合 (up)。もう一度クリックすると向きが逆になる' },
      { id: 'hash', label: '⋯', title: '破線のくさび: 奥へ向かう結合 (down)。もう一度クリックすると向きが逆になる' },
      { id: 'triple', label: '≡', title: '三重結合' },
      { id: 'chain', label: '⌇', title: '鎖。ドラッグした長さのジグザグ鎖を描く' },
      { id: 'bold', label: '▬', title: '太い結合' },
      { id: 'wavy', label: '∿', title: '波線' },
      { id: 'dashed', label: '┅', title: '点線の結合。部分結合や水素結合に使う' },
      { id: 'dative', label: '⇾', title: '配位結合。引いた向きに矢印が付き、もう一度クリックすると向きが逆になる' },
    ],
  },
  {
    name: '環',
    tools: [
      { id: 'benzene', label: '⌬', title: 'ベンゼン。ナフタレンやピリジンなどは、下の「芳香環・雛形」にある' },
      { id: 'chair', label: '⑂', title: 'シクロヘキサン（椅子形）' },
      { id: 'ring3', label: '△', title: 'シクロプロパン' },
      { id: 'ring4', label: '□', title: 'シクロブタン' },
      { id: 'ring5', label: '⬠', title: 'シクロペンタン' },
      { id: 'ring6', label: '⬡', title: 'シクロヘキサン' },
      { id: 'ring7', label: '7', title: 'シクロヘプタン' },
      { id: 'ring8', label: '8', title: 'シクロオクタン' },
    ],
  },
  {
    name: '反応',
    tools: [
      { id: 'arrow-normal', label: '→', title: '反応矢印。クリックで置き、ドラッグで向きと長さを決める' },
      { id: 'arrow-equilibrium', label: '⇌', title: '平衡の矢印' },
      { id: 'arrow-retro', label: '⇒', title: '逆合成の矢印' },
      { id: 'arrow-resonance', label: '↔', title: '共鳴の矢印。両向きの矢頭が付く' },
      { id: 'arrow-dashed', label: '⇢', title: '点線の矢印' },
      { id: 'arrow-nogo', label: '↛', title: '進まない反応の矢印。✕ が付く' },
      { id: 'plus', label: '+', title: '＋記号' },
      { id: 'text', label: 'T', title: '文字。矢印の上下の条件などを書く' },
    ],
  },
  {
    name: '図形',
    tools: [
      { id: 'rect', label: '⬚', title: '四角。ドラッグで大きさを決める' },
      { id: 'oval', label: '◯', title: '円・楕円。ドラッグで大きさを決める' },
      { id: 'bracket-square', label: '[ ]', title: '角かっこ。ドラッグで大きさを決め、分子をクリックするとその分子を囲む' },
      { id: 'bracket-round', label: '( )', title: '丸かっこ。分子をクリックするとその分子を囲む' },
      { id: 'bracket-curly', label: '{ }', title: '波かっこ。分子をクリックするとその分子を囲む' },
      { id: 'shape-line', label: '╱', title: '矢頭の無い線' },
    ],
  },
  {
    name: '機構',
    tools: [
      { id: 'arrow-curved', label: '↷', title: '電子の動き（電子 2 個）: 出どころから行き先へドラッグし、Shift を押すと反対側にふくらむ。置いた矢印は、ドラッグで曲がり具合を、クリックでふくらむ側を変えられる' },
      { id: 'arrow-fishhook', label: '⇀', title: '電子 1 個の動き。矢頭が片側だけになる' },
      { id: 'lone-pair', label: '꞉', title: 'ローンペア。原子をクリックするたびに 1・2・3・なしと変わる' },
      { id: 'radical', label: '•', title: 'ラジカル。原子をクリックすると付け外しできる' },
      { id: 'delta-plus', label: 'δ+', title: '部分電荷 δ+。原子をクリックして付ける' },
      { id: 'delta-minus', label: 'δ−', title: '部分電荷 δ−。原子をクリックして付ける' },
    ],
  },
];

/** 道具 → キー（大文字） */
const KEY_OF = new Map(Object.entries(TOOL_KEYS).map(([k, t]) => [t, k.toUpperCase()]));
/** 道具の短い名前（説明のはじめの 1 文） */
const shortName = (title: string) => title.split(/[。:]/)[0];

/** キャンバスの左下に出す、今の道具の案内 */
export function toolHint(tool: Tool, partName: string): string {
  if (tool === 'part') return partName ? `${partName}。クリックして置く` : '';
  const t = TOOL_GROUPS.flatMap((g) => g.tools).find((x) => x.id === tool);
  if (!t) return '';
  const key = KEY_OF.get(tool);
  return key ? `${t.title}。${key} キーで選べます` : t.title;
}

/** はじめに畳んでおくグループ（使う人が少なく、道具が多く見えるもの） */
export const COLLAPSED_BY_DEFAULT = ['図形', '機構'];
const COLLAPSE_KEY = 'ai-chem-editor:tool-groups-collapsed';
const ORDER_KEY = 'ai-chem-editor:tool-group-order';

/** 覚えたグループの並び。知らない名前は捨て、足りない名前（あとで増えたグループ）は元の並びの所に足す */
export function loadOrder(names: string[], raw: string | null): string[] {
  let saved: string[] = [];
  try {
    const v = JSON.parse(raw ?? '[]');
    if (Array.isArray(v)) saved = v.filter((x): x is string => typeof x === 'string' && names.includes(x));
  } catch {
    // 読めなければはじめの並び
  }
  const out = [...new Set(saved)];
  names.forEach((n, i) => {
    if (out.includes(n)) return;
    // 元の並びで前にあるグループのすぐ後ろに入れる
    const prev = names.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, n);
  });
  return out;
}

/** name を、target の位置へ動かす */
export function moveGroup(order: string[], name: string, target: string): string[] {
  if (name === target) return order;
  const out = order.filter((n) => n !== name);
  const at = out.indexOf(target);
  // 下から上へ動かすときは target の前、上から下へは後ろに置く
  out.splice(order.indexOf(name) > order.indexOf(target) ? at : at + 1, 0, name);
  return out;
}

function readOrderRaw(): string | null {
  try {
    return localStorage.getItem(ORDER_KEY);
  } catch {
    return null;
  }
}

function saveOrder(order: string[]) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // 覚えられなくても、開いている間は並べ替えたまま使える
  }
}

/** 押して畳む・開くを選んだグループだけを覚える（{ グループ名: 畳んでいるか }）。選んでいないグループははじめの状態 */
function loadCollapsed(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function saveCollapsed(v: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v));
  } catch {
    // 覚えられなくても、開いている間は畳んだ状態のまま使える
  }
}

export function Toolbar({ store, groups, footer }: { store: EditorStore; groups: typeof TOOL_GROUPS; footer?: ReactNode }) {
  // 道具の名前とキーを出す吹き出し。すぐに出す（title の吹き出しは出るのが遅い）
  const [tip, setTip] = useState<{ text: string; key?: string; x: number; y: number } | null>(null);
  const tool = useEditor(store, (s) => s.tool);
  const templateActive = useEditor(store, (s) => s.tool === 'part' && !!s.part?.id.startsWith('tpl:'));
  const [chosen, setChosen] = useState(loadCollapsed);
  const isCollapsed = (name: string) => chosen[name] ?? COLLAPSED_BY_DEFAULT.includes(name);
  const toggle = (name: string) => {
    const next = { ...chosen, [name]: !isCollapsed(name) };
    setChosen(next);
    saveCollapsed(next);
    track(`tool-group:${next[name] ? 'collapse' : 'expand'}`, { once: true });
  };
  const [order, setOrder] = useState(() => loadOrder(groups.map((g) => g.name), readOrderRaw()));
  const [dragging, setDragging] = useState<string | null>(null);
  const reorder = (name: string, target: string) => {
    const next = moveGroup(order, name, target);
    setOrder(next);
    saveOrder(next);
    track('tool-group:reorder', { once: true });
  };
  const sorted = [...groups].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return (
    <nav className="tools" aria-label="ツール">
      {sorted.map((g, i) => {
        const collapsed = isCollapsed(g.name);
        const bodyId = `tool-group-${i}`;
        // 畳んだグループの道具を選んでいるときは、見出しにその道具を出す（勝手には開かない）
        const active = g.tools.find((t) => t.id === tool) ?? (g.name === '環' && templateActive ? { label: '雛形', title: '雛形' } : null);
        const mark = collapsed && active;
        return (
          <div
            className={`tool-group${collapsed ? ' collapsed' : ''}${dragging && dragging !== g.name ? ' drop-target' : ''}`}
            key={g.name}
            data-group={g.name}
            onDragOver={(e) => {
              if (dragging) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging) reorder(dragging, g.name);
              setDragging(null);
            }}
          >
            <button
              type="button"
              className={`tool-group-name${mark ? ' has-active' : ''}`}
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              title={(collapsed ? `${g.name}の道具を開く` : `${g.name}の道具を畳む`) + (mark ? `。選んでいる道具: ${active.title.split(/[。:]/)[0]}` : '') + '。見出しをドラッグするか Alt+↑↓ で並べ替えられる'}
              data-testid={`tool-group-${g.name}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', g.name);
                e.dataTransfer.effectAllowed = 'move';
                setDragging(g.name);
              }}
              onDragEnd={() => setDragging(null)}
              onKeyDown={(e) => {
                if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                const at = order.indexOf(g.name) + (e.key === 'ArrowUp' ? -1 : 1);
                if (at >= 0 && at < order.length) reorder(g.name, order[at]);
                requestAnimationFrame(() => (document.querySelector(`[data-testid="tool-group-${g.name}"]`) as HTMLElement | null)?.focus());
              }}
              onClick={() => toggle(g.name)}
            >
              <span className="chev" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
              <span>{g.name}</span>
              {mark && (
                <span className="tool-group-active" data-testid="tool-group-active" aria-hidden="true">
                  {'id' in active && hasToolIcon(active.id) ? <ToolIcon id={active.id} /> : active.label}
                </span>
              )}
            </button>
            <div className="tool-group-body" id={bodyId} hidden={collapsed}>
              {g.tools.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={tool === t.id ? 'active' : ''}
                  aria-label={t.title}
                  aria-keyshortcuts={KEY_OF.get(t.id)}
                  onPointerEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTip({ text: shortName(t.title), key: KEY_OF.get(t.id), x: r.right + 8, y: r.top + r.height / 2 });
                  }}
                  onPointerLeave={() => setTip(null)}
                  aria-pressed={tool === t.id}
                  data-tool={t.id}
                  onClick={() => (track(`tool:${t.id}`, { once: true }), store.set({ tool: t.id, selection: t.id === 'select' || t.id === 'lasso' ? store.get().selection : new Set() }))}
                >
                  {hasToolIcon(t.id) ? <ToolIcon id={t.id} /> : t.label}
                </button>
              ))}
              {/* 雛形は環の下に置く（環の道具と同じく、置く物を選ぶ）。環を畳むと一緒に隠れる */}
              {g.name === '環' && <TemplatePalette store={store} />}
            </div>
          </div>
        );
      })}
      {footer && <div className="tools-foot">{footer}</div>}
      {tip && (
        <div className="tool-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
          {tip.key && <kbd>{tip.key}</kbd>}
        </div>
      )}
    </nav>
  );
}

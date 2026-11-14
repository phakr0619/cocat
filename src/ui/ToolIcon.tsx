// 左の道具の絵。ChemDraw に慣れた人が見て分かるよう、文字の記号ではなく線で描く。
// 結合は左下から右上へ向けて描く（くさびは右上が太い側）。色は文字の色（currentColor）に合わせる
import type { ReactNode } from 'react';

const S = 24;
/** 結合の始点と終点（左下 → 右上） */
const A = { x: 5, y: 19 };
const B = { x: 19, y: 5 };
/** 結合の向きに垂直な単位ベクトル */
const N = { x: Math.SQRT1_2, y: Math.SQRT1_2 };

const at = (t: number) => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
const off = (p: { x: number; y: number }, d: number) => ({ x: p.x + N.x * d, y: p.y + N.y * d });
const line = (d: number, props: Record<string, unknown> = {}) => {
  const a = off(A, d);
  const b = off(B, d);
  return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...props} />;
};

/** 正多角形の頂点（上が平らにならないよう、1 つの頂点を真上に置く） */
function polygon(n: number, r = 9, cx = 12, cy = 12.5) {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}
const pts = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

function wavyPath() {
  // 結合の向きに沿って、垂直方向に揺らす
  const steps = 40;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = off(at(t), 2.2 * Math.sin(t * Math.PI * 6));
    d += `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }
  return d;
}

function benzene() {
  const v = polygon(6);
  const c = { x: 12, y: 12.5 };
  // 内側の二重結合を 1 つおきに 3 本
  const inner = [0, 2, 4].map((i) => {
    const a = v[i];
    const b = v[(i + 1) % 6];
    const shrink = (p: { x: number; y: number }) => ({ x: c.x + (p.x - c.x) * 0.7, y: c.y + (p.y - c.y) * 0.7 });
    const pa = shrink(a);
    const pb = shrink(b);
    // 線の端を少し縮める
    const k = 0.15;
    return (
      <line key={i} x1={pa.x + (pb.x - pa.x) * k} y1={pa.y + (pb.y - pa.y) * k} x2={pb.x + (pa.x - pb.x) * k} y2={pb.y + (pa.y - pb.y) * k} />
    );
  });
  return (
    <>
      <polygon points={pts(v)} />
      {inner}
    </>
  );
}

const ICONS: Record<string, () => ReactNode> = {
  single: () => line(0),
  double: () => (
    <>
      {line(-1.8)}
      {line(1.8)}
    </>
  ),
  triple: () => (
    <>
      {line(-3)}
      {line(0)}
      {line(3)}
    </>
  ),
  // くさび（実線）: 手前に出る結合。右上が太い三角
  wedge: () => {
    const b1 = off(B, -2.8);
    const b2 = off(B, 2.8);
    return <polygon points={pts([A, b1, b2])} fill="currentColor" stroke="none" />;
  },
  // くさび（破線）: 奥へ向かう結合。右上ほど長い横線の並び
  hash: () => (
    <>
      {Array.from({ length: 6 }, (_, i) => {
        const t = 0.08 + (i / 5) * 0.92;
        const half = 0.4 + 3 * t;
        const a = off(at(t), -half);
        const b = off(at(t), half);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={1.3} />;
      })}
    </>
  ),
  wavy: () => <path d={wavyPath()} />,
  bold: () => line(0, { strokeWidth: 4.5, strokeLinecap: 'butt' }),
  dashed: () => line(0, { strokeDasharray: '2.2 2.2' }),
  dative: () => {
    const tip = B;
    const base = at(0.72);
    const w1 = off(base, -2.6);
    const w2 = off(base, 2.6);
    return (
      <>
        <line x1={A.x} y1={A.y} x2={base.x} y2={base.y} />
        <polygon points={pts([tip, w1, w2])} fill="currentColor" stroke="none" />
      </>
    );
  },
  chain: () => <polyline points="2,16 7,9 12,16 17,9 22,16" />,
  ring3: () => <polygon points={pts(polygon(3, 9, 12, 14))} />,
  ring4: () => <polygon points={pts(polygon(4, 9))} />,
  ring5: () => <polygon points={pts(polygon(5))} />,
  ring6: () => <polygon points={pts(polygon(6))} />,
  ring7: () => <polygon points={pts(polygon(7, 9))} />,
  ring8: () => <polygon points={pts(polygon(8, 9.5))} />,
  benzene,
  // 椅子形シクロヘキサン
  // 椅子形: chairPoints（src/chem/ringOps.ts）と同じ形を 10 倍して置いたもの
  chair: () => <polygon points="2,8.5 7,18.5 17,11.5 22,15.5 17,5.5 7,12.5" />,
  // 選択・消しゴム
  select: () => (
    <>
      <rect x={3} y={4} width={13} height={11} strokeDasharray="2.4 2" />
      <path d="M13 12l7.5 3.2-3.2 1.1-1.1 3.2z" fill="currentColor" />
    </>
  ),
  lasso: () => (
    <>
      <path d="M12 4.5c5 0 8.5 2.6 8.5 6s-3.5 6-8.5 6c-1.6 0-3-.3-4.3-.7" strokeDasharray="2.4 2" />
      <path d="M7.7 15.800C5 14.8 3.5 12.8 3.5 10.500c0-3.4 3.5-6 8.5-6" strokeDasharray="2.4 2" />
      <path d="M7.7 15.800c-1 1-1 2.7.5 3.200s2.3-.7 1.3-2.300c-.4-.6-1.1-.9-1.8-.900zM8.5 19.500l-1 2" />
    </>
  ),
  erase: () => (
    <>
      <path d="M9.5 19.500L3.8 13.800a1.2 1.2 0 010-1.700L11.7 4.200a1.2 1.2 0 011.7 0l5.8 5.800a1.2 1.2 0 010 1.700L11.5 19.500z" />
      <path d="M7.8 8.200l7.5 7.500M9.5 19.500h11" />
    </>
  ),
  // 反応
  'arrow-normal': () => <path d="M3 12h17M15 7.500l5 4.5-5 4.5" />,
  'arrow-equilibrium': () => <path d="M3 9.500h17l-4.5-4M21 14.500H4l4.5 4" />,
  'arrow-retro': () => <path d="M3 10h13.500M3 14h13.500M14.5 6.500L21 12l-6.5 5.5" />,
  'arrow-resonance': () => <path d="M3.5 12h17M8 7.500L3.5 12 8 16.500M16 7.500l4.5 4.5-4.5 4.5" />,
  'arrow-dashed': () => (
    <>
      <path d="M3 12h13" strokeDasharray="2.6 2.4" />
      <path d="M15 7.500l5 4.5-5 4.5" />
    </>
  ),
  'arrow-nogo': () => <path d="M3 12h17M15.5 7.500l5 4.5-5 4.500M8 8.500l5 7M13 8.500l-5 7" />,
  plus: () => <path d="M12 5.500v13M5.5 12h13" />,
  text: () => <path d="M5.5 6.500V5h13v1.500M12 5v14M9.5 19h5" />,
  // 図形
  rect: () => <rect x={3.5} y={6} width={17} height={12} rx={0.5} />,
  oval: () => <ellipse cx={12} cy={12} rx={8.5} ry={6} />,
  'bracket-square': () => <path d="M9 4.500H5.500v15H9M15 4.500h3.500v15H15" />,
  'bracket-round': () => <path d="M9 4.500c-3 2-4 4.5-4 7.500s1 5.5 4 7.500M15 4.500c3 2 4 4.5 4 7.500s-1 5.5-4 7.5" />,
  'bracket-curly': () => <path d="M9.5 4.500c-2 0-2.5 1-2.5 2.500v2.500c0 1.5-.8 2.5-2.5 2.5 1.7 0 2.5 1 2.5 2.500V17c0 1.5.5 2.5 2.5 2.500M14.5 4.500c2 0 2.5 1 2.5 2.500v2.500c0 1.5.8 2.5 2.5 2.5-1.7 0-2.5 1-2.5 2.500V17c0 1.5-.5 2.5-2.5 2.5" />,
  'shape-line': () => <path d="M4 19L20 5" />,
  // 機構
  'arrow-curved': () => <path d="M4 17C5 8 14 5.5 19.5 11M19.8 5.500l-.3 5.5-5.5-.5" />,
  'arrow-fishhook': () => <path d="M4 17C5 8 14 5.5 19.5 11M19.8 5.500l-.3 5.5" />,
  'lone-pair': () => (
    <>
      <circle cx={8.5} cy={12} r={1.7} fill="currentColor" stroke="none" />
      <circle cx={15.5} cy={12} r={1.7} fill="currentColor" stroke="none" />
    </>
  ),
  radical: () => <circle cx={12} cy={12} r={2.2} fill="currentColor" stroke="none" />,
};

export function hasToolIcon(id: string) {
  return id in ICONS;
}

export function ToolIcon({ id }: { id: string }) {
  const draw = ICONS[id];
  if (!draw) return null;
  return (
    <svg className="tool-icon" viewBox={`0 0 ${S} ${S}`} width={22} height={22} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
      {draw()}
    </svg>
  );
}

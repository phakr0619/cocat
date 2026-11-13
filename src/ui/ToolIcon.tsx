// 左の道具の絵（結合・環）。ChemDraw に慣れた人が見て分かるよう、文字の記号ではなく線で描く。
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

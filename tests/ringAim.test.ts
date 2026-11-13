import { describe, expect, it } from 'vitest';
import { angleOf, dist, sub } from '../src/chem/geometry';
import { emptyDoc } from '../src/chem/model';
import { chairPoints, placeRing, ringVertices } from '../src/chem/ringOps';

const deg = (r: number) => (r * 180) / Math.PI;
const C = { x: 100, y: 100 };

describe('環を押したまま動かして向きを決める', () => {
  it('何もない所: 最初の頂点がカーソルの向きに来る。角度は 15° 刻み、free なら刻まない', () => {
    const blank = { kind: 'blank' as const, p: C };
    // 動かさなければ今までどおり真上
    expect(deg(angleOf(sub(ringVertices(emptyDoc(), 6, blank)[0], C)))).toBeCloseTo(-90, 6);
    // 右へ動かすと右
    expect(deg(angleOf(sub(ringVertices(emptyDoc(), 6, blank, { p: { x: 200, y: 100 } })[0], C)))).toBeCloseTo(0, 6);
    // 10° の向きは 15° に止まる。free なら 10° のまま
    const p10 = { x: C.x + 50 * Math.cos(Math.PI / 18), y: C.y + 50 * Math.sin(Math.PI / 18) };
    expect(deg(angleOf(sub(ringVertices(emptyDoc(), 6, blank, { p: p10 })[0], C)))).toBeCloseTo(15, 6);
    expect(deg(angleOf(sub(ringVertices(emptyDoc(), 6, blank, { p: p10, free: true })[0], C)))).toBeCloseTo(10, 6);
  });

  it('何もない所の椅子形: 押した所を中心に回し、形（辺の長さ）は変えない', () => {
    const base = chairPoints(C);
    const turned = ringVertices(emptyDoc(), 'chair', { kind: 'blank', p: C }, { p: { x: 200, y: 100 } });
    for (let i = 0; i < 6; i++) {
      expect(dist(turned[i], C)).toBeCloseTo(dist(base[i], C), 6);
      expect(dist(turned[i], turned[(i + 1) % 6])).toBeCloseTo(dist(base[i], base[(i + 1) % 6]), 6);
    }
    // 真上に向けたときは今までの形
    const up = ringVertices(emptyDoc(), 'chair', { kind: 'blank', p: C }, { p: { x: 100, y: 0 } });
    up.forEach((p, i) => expect(dist(p, base[i])).toBeCloseTo(0, 6));
  });

  it('原子から: 環の中心がカーソルの向きに来る', () => {
    const d = placeRing(emptyDoc(), 6, { kind: 'blank', p: C });
    const atomId = Object.keys(d.atoms)[0];
    const a = d.atoms[atomId];
    const vs = ringVertices(d, 5, { kind: 'atom', id: atomId }, { p: { x: a.x - 100, y: a.y } });
    const c = { x: vs.reduce((s, v) => s + v.x, 0) / 5, y: vs.reduce((s, v) => s + v.y, 0) / 5 };
    expect(deg(angleOf(sub(c, a)))).toBeCloseTo(180, 6);
    expect(dist(vs[0], a)).toBeCloseTo(0, 6);
  });

  it('結合から: カーソルのある側に縮環する', () => {
    const d = placeRing(emptyDoc(), 6, { kind: 'blank', p: C });
    const [bondId, b] = Object.entries(d.bonds)[0];
    const a1 = d.atoms[b.a1];
    const a2 = d.atoms[b.a2];
    const m = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
    // 元の環の中心（C）の側と、その反対の側
    const inner = ringVertices(d, 6, { kind: 'bond', id: bondId }, { p: C });
    const outer = ringVertices(d, 6, { kind: 'bond', id: bondId }, { p: { x: 2 * m.x - C.x, y: 2 * m.y - C.y } });
    const cen = (vs: { x: number; y: number }[]) => ({ x: vs.reduce((s, v) => s + v.x, 0) / 6, y: vs.reduce((s, v) => s + v.y, 0) / 6 });
    expect(dist(cen(inner), C)).toBeLessThan(1);
    expect(dist(cen(outer), C)).toBeGreaterThan(10);
  });
});

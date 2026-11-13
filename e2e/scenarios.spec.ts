// 完了条件の3つの構造を、画面の操作（クリック・ドラッグ・キー）だけで描く。
// 人が描くときの手数の目安として、操作の回数を数えて出力する。
import { expect, test, type Page } from '@playwright/test';
import { canon, pt, smiles, tool } from './helpers';

type A = { id: string; x: number; y: number; element: string };

class Ops {
  count = 0;
  constructor(private page: Page) {}
  async tool(id: string) {
    this.count++;
    await tool(this.page, id);
  }
  async click(x: number, y: number) {
    this.count++;
    const p = await pt(this.page, x, y);
    await this.page.mouse.click(p.x, p.y);
  }
  async drag(a: { x: number; y: number }, b: { x: number; y: number }) {
    this.count++;
    const p = await pt(this.page, a.x, a.y);
    const q = await pt(this.page, b.x, b.y);
    await this.page.mouse.move(p.x, p.y);
    await this.page.mouse.down();
    await this.page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 3 });
    await this.page.mouse.move(q.x, q.y, { steps: 3 });
    await this.page.mouse.up();
  }
  /** 原子にカーソルを合わせてキーを押す（1操作と数える） */
  async key(a: { x: number; y: number }, key: string) {
    this.count++;
    const p = await pt(this.page, a.x, a.y);
    await this.page.mouse.move(p.x, p.y);
    await this.page.keyboard.press(key);
  }
  /** 原子にカーソルを合わせて Enter でラベルを入力する */
  async label(a: { x: number; y: number }, text: string) {
    this.count++;
    const p = await pt(this.page, a.x, a.y);
    await this.page.mouse.move(p.x, p.y);
    await this.page.keyboard.press('Enter');
    await this.page.getByTestId('label-input').fill(text);
    await this.page.keyboard.press('Enter');
  }
  async text(x: number, y: number, s: string) {
    await this.click(x, y);
    await this.page.getByTestId('text-input').fill(s);
    await this.page.keyboard.press('Enter');
  }
  async shortcut(k: string) {
    this.count++;
    await this.page.keyboard.press(k);
  }
  async atoms(): Promise<A[]> {
    return this.page.evaluate(() => Object.values(window.__editor!.get().doc.atoms).map((a) => ({ id: a.id, x: a.x, y: a.y, element: a.element })));
  }
  async newest(): Promise<A> {
    return (await this.atoms()).at(-1)!;
  }
  /** 2つの原子の中点（結合の上） */
  async bondBetween(a: A, b: A) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('canvas').waitFor();
});

function report(name: string, ops: Ops, started: number) {
  const sec = (Date.now() - started) / 1000;
  // 人の1操作を 3〜5 秒と見ると、操作の回数 × 4 秒が目安
  console.log(`[${name}] 操作 ${ops.count} 回（人の目安 約 ${Math.round((ops.count * 4) / 60 * 10) / 10} 分）、自動では ${sec.toFixed(1)} 秒`);
  test.info().annotations.push({ type: name, description: `${ops.count} operations` });
}

test('アスピリン', async ({ page }) => {
  const o = new Ops(page);
  const t0 = Date.now();
  await o.tool('benzene');
  await o.click(100, 100);
  const ring = await o.atoms();
  const top = ring.sort((a, b) => a.y - b.y)[0];
  const upperLeft = ring.filter((a) => a.x < top.x - 1).sort((a, b) => a.y - b.y)[0];
  await o.tool('single');
  // カルボキシ基
  await o.click(top.x, top.y);
  const c1 = await o.newest();
  await o.click(c1.x, c1.y);
  const o1 = await o.newest();
  await o.click(c1.x, c1.y);
  const o2 = await o.newest();
  await o.key(o1, 'o');
  await o.key(o2, 'o');
  await o.key(await o.bondBetween(c1, o2), '2');
  // アセトキシ基
  await o.click(upperLeft.x, upperLeft.y);
  const e1 = await o.newest();
  await o.key(e1, 'o');
  await o.click(e1.x, e1.y);
  const e2 = await o.newest();
  await o.click(e2.x, e2.y);
  await o.click(e2.x, e2.y);
  const e4 = await o.newest();
  await o.key(e4, 'o');
  await o.key(await o.bondBetween(e2, e4), '2');
  report('アスピリン', o, t0);
  await page.screenshot({ path: 'test-results/scenario-aspirin.png' });
  expect(await smiles(page)).toBe(await canon(page, 'CC(=O)Oc1ccccc1C(=O)O'));
});

test('タキソール骨格（タキサン）', async ({ page }) => {
  const o = new Ops(page);
  const t0 = Date.now();
  const R = 14.4 / (2 * Math.sin(Math.PI / 8));
  const c = { x: 150, y: 140 };
  // 8員環の頂点は真上から時計回りに 45° ずつ: v0=C1, v1=C2, v2=C3, v3=C8, v4=C9, v5=C10, v6=C11, v7=C15
  const v = Array.from({ length: 8 }, (_, i) => ({ x: c.x + R * Math.cos(-Math.PI / 2 + (i * Math.PI) / 4), y: c.y + R * Math.sin(-Math.PI / 2 + (i * Math.PI) / 4) }));
  await o.tool('ring8');
  await o.click(c.x, c.y);
  // C 環: C3-C8 の結合に6員環を縮環
  await o.tool('ring6');
  await o.click((v[2].x + v[3].x) / 2, (v[2].y + v[3].y) / 2);
  // A 環: C1 から3炭素の橋（C14・C13・C12）を描いて C11 につなぐ
  await o.tool('single');
  const dir = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
  const step = (p: { x: number; y: number }, deg: number) => ({ x: p.x + 14.4 * dir(deg).x, y: p.y + 14.4 * dir(deg).y });
  const a14 = step(v[0], -150);
  const a13 = step(a14, 150);
  const a12 = step(a13, 90);
  await o.drag(v[0], a14);
  await o.drag(a14, a13);
  await o.drag(a13, a12);
  await o.drag(a12, v[6]);
  // メチル基: C15 に2つ、C12・C8・C4 に1つずつ
  await o.click(v[7].x, v[7].y);
  await o.click(v[7].x, v[7].y);
  await o.click(a12.x, a12.y);
  await o.click(v[3].x, v[3].y);
  const as = await o.atoms();
  const known = [...v, a14, a13, a12];
  const c4 = as
    .filter((a) => !known.some((k) => Math.hypot(k.x - a.x, k.y - a.y) < 1))
    .sort((p, q) => Math.hypot(p.x - v[2].x, p.y - v[2].y) - Math.hypot(q.x - v[2].x, q.y - v[2].y))[0];
  await o.click(c4.x, c4.y);
  await o.shortcut('Control+Shift+K');
  report('タキサン骨格', o, t0);
  await page.screenshot({ path: 'test-results/scenario-taxane.png' });
  expect(await smiles(page)).toBe(await canon(page, 'C12CC3C(C)CCCC3(C)CCC(C(C)CC1)C2(C)C'));
});

test('Boc 保護アミノ酸の縮合反応スキーム', async ({ page }) => {
  const o = new Ops(page);
  const t0 = Date.now();
  const L = 14.4;
  const zig = (x0: number, y0: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ x: x0 + i * L * Math.cos(Math.PI / 6), y: y0 - (i % 2 === 1 ? L / 2 : 0) }));
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // Boc-Ala-OH: Boc–N–Cα(Me)–C(=O)–OH
  await o.tool('single');
  const p = zig(50, 150, 5);
  await o.click(p[0].x, p[0].y);
  for (let i = 1; i < 4; i++) await o.click(p[i].x, p[i].y);
  await o.click(p[3].x, p[3].y);
  const p5 = await o.newest();
  await o.click(p[2].x, p[2].y);
  const p6 = await o.newest();
  await o.label(p[0], 'Boc');
  await o.key(p[1], 'n');
  await o.key(p[4], 'o');
  await o.key(p5, 'o');
  await o.key(mid(p[3], p5), '2');
  await o.key(mid(p[2], p6), 'w');

  // H-Gly-OMe: H2N–CH2–C(=O)–O–CH3
  const q = zig(140, 150, 5);
  await o.click(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) await o.click(q[i].x, q[i].y);
  await o.click(q[2].x, q[2].y);
  const q5 = await o.newest();
  await o.key(q[0], 'n');
  await o.key(q[3], 'o');
  await o.key(q5, 'o');
  await o.key(mid(q[2], q5), '2');

  // ＋、矢印、条件
  await o.tool('plus');
  await o.click(125, 147);
  await o.tool('arrow-normal');
  await o.click(205, 147);
  await o.tool('text');
  await o.text(208, 140, 'EDC, HOBt');
  await o.text(208, 159, 'DMF, rt');

  // 生成物 Boc-Ala-Gly-OMe: 鎖ツールで8原子の骨格を一度に描く
  const r = zig(275, 150, 9);
  await o.tool('chain');
  await o.drag(r[0], { x: r[0].x + 12.47 * 8, y: r[0].y });
  await o.tool('single');
  await o.click(r[3].x, r[3].y);
  const ro1 = await o.newest();
  await o.click(r[6].x, r[6].y);
  const ro2 = await o.newest();
  await o.click(r[2].x, r[2].y);
  const rme = await o.newest();
  await o.label(r[0], 'Boc');
  await o.key(r[1], 'n');
  await o.key(r[4], 'n');
  await o.key(r[7], 'o');
  await o.key(ro1, 'o');
  await o.key(ro2, 'o');
  await o.key(mid(r[3], ro1), '2');
  await o.key(mid(r[6], ro2), '2');
  await o.key(mid(r[2], rme), 'w');
  report('Boc 縮合スキーム', o, t0);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: 'test-results/scenario-boc.png' });

  const got = await smiles(page);
  const L_ = `${await canon(page, 'C[C@H](NC(=O)OC(C)(C)C)C(=O)O')}.${await canon(page, 'NCC(=O)OC')}>>${await canon(page, 'C[C@H](NC(=O)OC(C)(C)C)C(=O)NCC(=O)OC')}`;
  const D_ = `${await canon(page, 'C[C@@H](NC(=O)OC(C)(C)C)C(=O)O')}.${await canon(page, 'NCC(=O)OC')}>>${await canon(page, 'C[C@@H](NC(=O)OC(C)(C)C)C(=O)NCC(=O)OC')}`;
  // 反応物と生成物で、アラニンの立体が同じであること
  expect([L_, D_]).toContain(got);
  const doc = await page.evaluate(() => window.__editor!.get().doc);
  expect(Object.values(doc.texts).map((t) => t.text).sort()).toEqual(['DMF, rt', 'EDC, HOBt']);
});

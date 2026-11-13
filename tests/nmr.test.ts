import { beforeAll, describe, expect, it } from 'vitest';
import ref from './fixtures/nmr-reference.json';
import holdout from './fixtures/nmr-reference-holdout.json';
import { emptyDoc } from '../src/chem/model';
import { formatNmrText, predictNmr, type NmrPrediction } from '../src/chem/nmr';
import { importText } from '../src/io/convert';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

function predict(smiles: string): { p: NmrPrediction; ids: string[] } {
  const doc = importText(emptyDoc(), smiles).doc;
  const ids = Object.keys(doc.atoms);
  const p = predictNmr(doc, ids);
  if ('error' in p) throw new Error(p.error);
  return { p, ids };
}

type Ref = { smiles: string; c13: Record<string, number>; h1: Record<string, number | number[]> };
const casesOf = (o: object) => Object.entries(o).filter(([k]) => !k.startsWith('_')) as [string, Ref][];
const cases = casesOf(ref);

/** 実測と予測の組（原子ごと）。予測できなかった原子は null */
function pairs(cases: [string, Ref][]) {
  const c: { name: string; atom: string; exp: number; got: number | null }[] = [];
  const h: { name: string; atom: string; exp: number; got: number | null }[] = [];
  for (const [name, r] of cases) {
    const { p, ids } = predict(r.smiles);
    for (const [k, exp] of Object.entries(r.c13)) {
      const s = p.c13.find((x) => x.atomIds.includes(ids[Number(k)]));
      c.push({ name, atom: k, exp, got: s?.shift ?? null });
    }
    for (const [k, e] of Object.entries(r.h1)) {
      const got = p.h1.filter((x) => x.atomIds.includes(ids[Number(k)])).map((x) => x.shift);
      const exps = Array.isArray(e) ? [...e].sort((a, b) => a - b) : [e];
      const gs = got.length === exps.length ? [...got].sort((a, b) => (a ?? 0) - (b ?? 0)) : exps.map(() => null);
      exps.forEach((exp, n) => h.push({ name, atom: k, exp, got: gs[n] ?? null }));
    }
  }
  return { c, h };
}

describe('NMR の予測（加成則）は、よく知られた化合物の実測値に近い', () => {
  it(`${cases.length} 件の化合物で、¹³C は ±5 ppm、¹H は ±0.3 ppm に収まる割合が高い`, () => {
    const { c, h } = pairs(cases);
    // 表で読める形だけを選んだので、全部の原子に値が出る
    expect(c.filter((x) => x.got === null)).toEqual([]);
    expect(h.filter((x) => x.got === null)).toEqual([]);
    const { rateC, rateH } = report('表を書くときに見た化合物', c, h);
    expect(rateC).toBeGreaterThanOrEqual(0.95);
    expect(rateH).toBeGreaterThanOrEqual(0.9);
    // 外れても大きくは外さない
    for (const x of c) expect(Math.abs(x.got! - x.exp)).toBeLessThanOrEqual(8);
    for (const x of h) expect(Math.abs(x.got! - x.exp)).toBeLessThanOrEqual(0.6);
  });

  it('表を書いた後に足した確かめ用の化合物でも、多くが範囲に収まる', () => {
    const { c, h } = pairs(casesOf(holdout));
    expect(c.filter((x) => x.got === null)).toEqual([]);
    expect(h.filter((x) => x.got === null)).toEqual([]);
    const { rateC, rateH } = report('確かめ用の化合物', c, h);
    expect(rateC).toBeGreaterThanOrEqual(0.8);
    expect(rateH).toBeGreaterThanOrEqual(0.85);
  });
});

type Pair = { name: string; atom: string; exp: number; got: number | null };
function report(title: string, c: Pair[], h: Pair[]) {
  const err = (x: Pair) => Math.abs(x.got! - x.exp);
  const okC = c.filter((x) => err(x) <= 5);
  const okH = h.filter((x) => err(x) <= 0.3);
  const mae = (xs: Pair[]) => xs.reduce((s, x) => s + err(x), 0) / xs.length;
  console.log(
    `${title}\n` +
      `¹³C: ${okC.length}/${c.length}（${((okC.length / c.length) * 100).toFixed(0)}%）が ±5 ppm、平均の誤差 ${mae(c).toFixed(2)} ppm、最大 ${Math.max(...c.map(err)).toFixed(1)}\n` +
      `¹H: ${okH.length}/${h.length}（${((okH.length / h.length) * 100).toFixed(0)}%）が ±0.3 ppm、平均の誤差 ${mae(h).toFixed(3)} ppm、最大 ${Math.max(...h.map(err)).toFixed(2)}\n` +
      [...c.filter((x) => err(x) > 5), ...h.filter((x) => err(x) > 0.3)].map((x) => `  外れ: ${x.name} の ${x.atom} 番 実測 ${x.exp} 予測 ${x.got}`).join('\n'),
  );
  return { rateC: okC.length / c.length, rateH: okH.length / h.length };
}

describe('NMR の予測の細部', () => {
  it('等価な原子をまとめる（トルエンの ortho の 2 つの炭素、メチルの 3 つの H）', () => {
    const { p, ids } = predict('Cc1ccccc1');
    expect(p.c13).toHaveLength(5);
    const ortho = p.c13.find((x) => x.atomIds.includes(ids[2]))!;
    expect(ortho.atomIds.sort()).toEqual([ids[2], ids[6]].sort());
    expect(ortho.count).toBe(2);
    const me = p.h1.find((x) => x.atomIds.includes(ids[0]))!;
    expect(me.count).toBe(3);
    expect(p.h1.reduce((s, x) => s + x.count, 0)).toBe(8);
  });

  it('表で読めない原子は値を出さず、理由を出す（ピリジン・ナフタレン・OH）', () => {
    const py = predict('c1ccncc1').p;
    expect(py.c13.every((x) => x.shift === null && /ベンゼン以外/.test(x.reason!))).toBe(true);
    const naph = predict('c1ccc2ccccc2c1').p;
    expect(naph.c13.every((x) => x.shift === null)).toBe(true);
    expect(naph.c13.some((x) => /縮環/.test(x.reason!))).toBe(true);
    const etoh = predict('CCO').p;
    const oh = etoh.h1.find((x) => x.label === 'OH')!;
    expect(oh.shift).toBeNull();
    expect(oh.reason).toMatch(/溶媒/);
  });

  it('表に無い置換基の隣は予測しない（ホウ素）', () => {
    const { p, ids } = predict('CB(O)O');
    const c = p.c13.find((x) => x.atomIds.includes(ids[0]))!;
    expect(c.shift).toBeNull();
    expect(c.reason).toMatch(/表に無い/);
  });

  it('論文の形の文字にする', () => {
    const t = formatNmrText(predict('CC(=O)OCC').p);
    expect(t).toMatch(/^1H NMR \(predicted, additivity rules\): δ 4\.\d\d \(2H\), 2\.\d\d \(3H\), 1\.\d\d \(3H\)/);
    expect(t).toMatch(/13C NMR \(predicted, additivity rules\): δ 1[67]\d\.\d, /);
  });

  it('SMILES の原子の順と文書の原子の順は同じ（テストの前提）', () => {
    const doc = importText(emptyDoc(), 'OCC').doc;
    expect(Object.values(doc.atoms).map((a) => a.element)).toEqual(['O', 'C', 'C']);
  });
});

describe('NMR の予測で、加成則が大きく外れる形は値を出さない', () => {
  it('CF3 の炭素、CHCl3 の H、芳香環の N に付いたメチル（カフェイン）', () => {
    const cf3 = predict('FC(F)(F)c1ccccc1');
    expect(cf3.p.c13.find((x) => x.atomIds.includes(cf3.ids[1]))!.shift).toBeNull();
    // ベンゼン環の側は表（CF3 の置換基の寄与）で読める
    expect(cf3.p.c13.find((x) => x.atomIds.includes(cf3.ids[4]))!.shift).not.toBeNull();
    const chcl3 = predict('ClC(Cl)Cl');
    expect(chcl3.p.h1[0].shift).toBeNull();
    const caf = predict('CN1C=NC2=C1C(=O)N(C(=O)N2C)C');
    expect(caf.p.c13.find((x) => x.atomIds.includes(caf.ids[0]))!.shift).toBeNull();
  });
});

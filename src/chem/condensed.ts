// ラベルの書き方（縮約式・原子＋略号・塩）を読み、構造（* で結合する SMILES）にする。docs/abbreviation-labels.md
// 例: NHFmoc → *NC(=O)OCC1c2ccccc2-c2ccccc21、CH2OH → *[CH2][OH]、CO2tBu → *C(=O)OC(C)(C)C、BF3K → *[B-](F)(F)F.[K+]
// 左向きの書き方（HOH2C・BocHN・KF3B）も、部品の順を逆にして読む。決まった規則だけで読み、LLM は使わない

/** 置換基の表（名前 → * で結合する SMILES）。標準の略号と、利用者の辞書を渡す */
export type GroupTable = (name: string) => string | undefined;

type Tok =
  | { t: 'el'; el: string; n: number }
  | { t: 'grp'; smiles: string; n: number; name: string }
  | { t: 'paren'; toks: Tok[]; n: number; oxo?: boolean };

/** 読める元素（有機の置換基に出るもの）。ここに無い記号は読まない */
const ELEMENTS = new Set(['H', 'B', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'Se', 'Br', 'I', 'Li', 'Na', 'K', 'Rb', 'Cs', 'Sn', 'Ge']);
/** 元素から始まる組の略号（OMe・CO2Me・NHBoc・CF3・NO2） */
const COMPOUND_GROUP = /^(?:[CNOS][A-Z0-9]|NH)/;
const METALS = new Set(['Li', 'Na', 'K', 'Rb', 'Cs']);
const HALOGENS = new Set(['F', 'Cl', 'Br', 'I']);
/** 原子価（使える値を小さい順に） */
const VALENCE: Record<string, number[]> = { H: [1], B: [3], C: [4], N: [3], O: [2], F: [1], Cl: [1], Br: [1], I: [1], Si: [4], P: [3, 5], S: [2, 4, 6], Se: [2, 4, 6], Sn: [4], Ge: [4] };

/** 縮約式の中で、元素の組み合わせでは読めない決まった部品 */
const SPECIAL: Record<string, string> = {
  N3: '*N=[N+]=[N-]',
  NCO: '*N=C=O',
  NCS: '*N=C=S',
  SCN: '*SC#N',
  C6H5: '*c1ccccc1',
  C6F5: '*c1c(F)c(F)c(F)c(F)c1F',
  C6H11: '*C1CCCCC1',
};

interface Node {
  el: string;
  h: number;
  charge: number;
  /** 部品（略号）の SMILES（* を除いたもの）。部品のときは el を使わない */
  group?: string;
}
interface Edge {
  a: number;
  b: number;
  order: number;
}

/** 原子価の上限（ホウ素は 4 本目で B⁻。電荷は N⁺・O⁻ のように原子価を増減する） */
function g_valence(n: Node): number {
  if (n.group !== undefined || n.el === '*') return 1;
  if (n.el === 'B') return 4;
  const v = VALENCE[n.el] ?? [0];
  return v[v.length - 1] + chargeShift(n);
}

function chargeShift(n: Node): number {
  return n.el === 'N' || n.el === 'P' || n.el === 'O' || n.el === 'S' ? n.charge : 0;
}

class Graph {
  nodes: Node[] = [{ el: '*', h: 0, charge: 0 }];
  edges: Edge[] = [];
  ions: string[] = [];
  add(n: Node): number {
    this.nodes.push(n);
    return this.nodes.length - 1;
  }
  bond(a: number, b: number, order = 1) {
    this.edges.push({ a, b, order });
  }
  used(i: number): number {
    const n = this.nodes[i];
    return this.edges.reduce((s, e) => s + (e.a === i || e.b === i ? e.order : 0), 0) + n.h;
  }
  /** 原子価の上限（ホウ素は 4 本目で B⁻、窒素は + が付けば 4） */
  maxValence(i: number): number {
    const n = g_valence(this.nodes[i]);
    return n;
  }
  /** 結合を足す余地（組み立ての途中で、どこにつなぐかを決めるのに使う） */
  free(i: number): number {
    return this.maxValence(i) - this.used(i);
  }
}

/** ラベルを部品に分ける。group は名前から置換基を引く */
function tokenize(text: string, group: GroupTable, atomic = false): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const num = () => {
    const m = text.slice(i).match(/^\d+/);
    if (!m) return 1;
    i += m[0].length;
    return parseInt(m[0], 10);
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '=' || ch === '-' || ch === '–' || ch === '·' || ch === ' ') {
      // 結合の記号（CH=CH2、C(=O)Me）は書かなくても読めるので飛ばす
      i++;
      continue;
    }
    if (ch === '(' || ch === '[') {
      const close = ch === '(' ? ')' : ']';
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth) {
        if (text[j] === ch) depth++;
        else if (text[j] === close) depth--;
        j++;
      }
      if (depth) return null;
      const inner = text.slice(i + 1, j - 1);
      i = j;
      const n = num();
      // (O)・(=O) はオキソ（=O）
      if (/^=?O$/.test(inner)) {
        out.push({ t: 'paren', toks: [], n, oxo: true });
        continue;
      }
      const toks = tokenize(inner, group, atomic);
      if (!toks || !toks.length) return null;
      out.push({ t: 'paren', toks, n });
      continue;
    }
    // 決まった部品（N3・C6H5 など）、置換基の名前（長いものから）、2 文字の元素、1 文字の元素の順に試す
    let matched = false;
    for (const [k, smi] of Object.entries(SPECIAL)) {
      if (text.startsWith(k, i) && !/^\d/.test(text.slice(i + k.length))) {
        i += k.length;
        out.push({ t: 'grp', smiles: smi, n: num(), name: k });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (let len = Math.min(8, text.length - i); len >= 2; len--) {
      const name = text.slice(i, i + len);
      // 置換基の名前の直後に小文字が続くなら、もっと長い名前の途中（Mes の Me など）
      if (/[a-z]/.test(text[i + len] ?? '')) continue;
      const smi = group(name);
      // atomic のときは、元素から始まる組の略号（OMe・CO2Me・NHBoc・CF3）を使わず、元素に分けて読む（COMe の OMe を取らない）
      if (smi && !ELEMENTS.has(name) && !(atomic && COMPOUND_GROUP.test(name))) {
        i += len;
        out.push({ t: 'grp', smiles: smi, n: num(), name });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const two = text.slice(i, i + 2);
    if (/^[A-Z][a-z]$/.test(two) && ELEMENTS.has(two)) {
      i += 2;
      out.push({ t: 'el', el: two, n: num() });
      continue;
    }
    if (/^[A-Z]$/.test(ch) && ELEMENTS.has(ch)) {
      i += 1;
      out.push({ t: 'el', el: ch, n: num() });
      continue;
    }
    return null;
  }
  return out;
}

/** 左向きの書き方（HOH2C）を、右向きの順（CH2OH）に並べ直す。H は直後の原子に付く */
function reverseToks(toks: Tok[]): Tok[] {
  const units: Tok[][] = [];
  let pendingH: Tok[] = [];
  for (const t of toks) {
    if (t.t === 'el' && t.el === 'H') {
      pendingH.push(t);
      continue;
    }
    units.push([t, ...pendingH]);
    pendingH = [];
  }
  if (pendingH.length) {
    if (!units.length) return toks;
    units[units.length - 1].push(...pendingH);
  }
  return units.reverse().flat();
}

class BuildError extends Error {}

/** 部品の並びを、g の at（結合する原子）の先に組み立てる。戻り値: 最後に開いている原子（鎖の続き） */
function build(g: Graph, toks: Tok[], at: number): number {
  const stack: number[] = [at];
  const top = (): number => {
    while (stack.length && g.free(stack[stack.length - 1]) <= 0) stack.pop();
    if (!stack.length) throw new BuildError('つなぐ所がありません');
    return stack[stack.length - 1];
  };
  let last = at;
  toks.forEach((tok, k) => {
    if (tok.n === 0) return;
    if (tok.t === 'grp') {
      for (let c = 0; c < tok.n; c++) {
        const p = top();
        const id = g.add({ el: '', h: 0, charge: 0, group: tok.smiles.replace(/^\*/, '') });
        g.bond(p, id);
      }
      return;
    }
    if (tok.t === 'paren') {
      if (tok.oxo) {
        const p = top();
        for (let c = 0; c < tok.n; c++) g.bond(p, g.add({ el: 'O', h: 0, charge: 0 }), 2);
        return;
      }
      // 括弧の中を 1 つ組み立てて、鎖の途中（(CH2)3）か、枝（(OMe)2）かを決める
      const probe = new Graph();
      const end = build(probe, tok.toks, 0);
      const chain = probe.free(end) > 0 && end !== 0;
      let p = top();
      for (let c = 0; c < tok.n; c++) {
        const e = build(g, tok.toks, p);
        if (chain) p = e;
      }
      if (chain) {
        stack.push(p);
        last = p;
      }
      return;
    }
    const { el, n } = tok;
    if (el === 'H') {
      const p = top();
      if (p === 0 || g.free(p) < n) throw new BuildError('水素の数が合いません');
      g.nodes[p].h += n;
      return;
    }
    if (HALOGENS.has(el)) {
      for (let c = 0; c < n; c++) {
        const p = top();
        g.bond(p, g.add({ el, h: 0, charge: 0 }));
      }
      return;
    }
    if (METALS.has(el)) {
      // アルカリ金属は対イオン。陰イオンが足りなければ、開いている原子を陰イオンにする（CO2Na の O⁻）
      for (let c = 0; c < n; c++) {
        // ホウ素に 4 本つながっていれば、ボラート（B⁻）として数える
        const borate = g.nodes.filter((x, j) => x.el === 'B' && x.charge === 0 && g.used(j) === 4).length;
        const charge = g.nodes.reduce((s, x) => s + x.charge, 0) - borate + g.ions.length;
        if (charge >= 0) {
          const p = top();
          if (p === 0) throw new BuildError('対イオンの相手がありません');
          g.nodes[p].charge -= 1;
        }
        g.ions.push(`[${el}+]`);
      }
      return;
    }
    // 酸素: 炭素・硫黄・リン・窒素のあとはカルボニル（C=O）・スルホニル（SO2）・ニトロ（NO2）として読む
    if (el === 'O') {
      const p = top();
      const pe = g.nodes[p].el;
      if ((pe === 'S' || pe === 'Se') && k > 0) {
        // SO → S=O、SO2 → S(=O)(=O)、SO3 → S(=O)(=O)O−（続きは単結合の O）
        const doubles = Math.min(n, 2);
        for (let c = 0; c < doubles; c++) g.bond(p, g.add({ el: 'O', h: 0, charge: 0 }), 2);
        if (n === 3) {
          const o = g.add({ el: 'O', h: 0, charge: 0 });
          g.bond(p, o);
          stack.push(o);
          last = o;
        } else if (n > 3) throw new BuildError('S の O が多すぎます');
        return;
      }
      if (pe === 'N' && n === 2 && k > 0) {
        g.nodes[p].charge += 1;
        g.bond(p, g.add({ el: 'O', h: 0, charge: 0 }), 2);
        g.bond(p, g.add({ el: 'O', h: 0, charge: -1 }));
        return;
      }
      if (pe === 'C' && n === 2 && k > 0) {
        g.bond(p, g.add({ el: 'O', h: 0, charge: 0 }), 2);
        const o = g.add({ el: 'O', h: 0, charge: 0 });
        g.bond(p, o);
        stack.push(o);
        last = o;
        return;
      }
      // 水素の付いていない炭素（CO・CHO の C）とリン（PO）の O は二重結合。CH2O… のように開きが 1 つなら単結合で鎖が続く
      // 並びの先頭の O（(OEt) の O）は置換基の付け根なので単結合
      if ((pe === 'C' || pe === 'P') && n === 1 && k > 0 && g.free(p) >= 2) {
        g.bond(p, g.add({ el: 'O', h: 0, charge: 0 }), 2);
        return;
      }
    }
    // 2 個以上の炭素（C2H5 など）は、つながった鎖として読む（CnH2n+1 の形だけ）
    if (el === 'C' && n > 1) {
      const h = toks[k + 1];
      if (!(h?.t === 'el' && h.el === 'H' && h.n === 2 * n + 1)) throw new BuildError('炭素の数の書き方が読めません');
      let p = top();
      for (let c = 0; c < n; c++) {
        const id = g.add({ el: 'C', h: c === n - 1 ? 3 : 2, charge: 0 });
        g.bond(p, id);
        p = id;
      }
      // 次の H（2n+1）は鎖に配ったので読み飛ばす
      (toks[k + 1] as { n: number }).n = 0;
      return;
    }
    if (n > 1) throw new BuildError(`${el}${n} は読めません`);
    const p = top();
    const id = g.add({ el, h: 0, charge: 0 });
    g.bond(p, id);
    stack.push(id);
    last = id;
  });
  return last;
}

/** 組み立てた骨格の、満たされていない原子価を二重・三重結合で埋める（CN → C≡N、CH=CH2）。埋まらなければ読めない */
function saturate(g: Graph) {
  const need = (i: number) => {
    const n = g.nodes[i];
    if (n.group !== undefined || n.el === '*' || n.el === 'B') return 0;
    const used = g.used(i);
    const v = (VALENCE[n.el] ?? [0]).map((x) => x + chargeShift(n)).find((x) => x >= used);
    return v === undefined ? -1 : v - used;
  };
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const e of [...g.edges].reverse()) {
      const k = Math.min(need(e.a), need(e.b), 3 - e.order);
      if (k > 0) {
        e.order += k;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // ホウ素は 4 本でボラート（B⁻）
  g.nodes.forEach((n, i) => {
    if (n.el === 'B' && g.used(i) === 4) n.charge = Math.min(n.charge, -1);
  });
  g.nodes.forEach((_, i) => {
    if (need(i) !== 0 && g.nodes[i].el !== 'B') throw new BuildError('原子価が合いません');
  });
}

function atomSmiles(n: Node): string {
  const ch = n.charge ? (n.charge > 0 ? '+' : '-') + (Math.abs(n.charge) > 1 ? Math.abs(n.charge) : '') : '';
  const h = n.h ? `H${n.h > 1 ? n.h : ''}` : '';
  return `[${n.el}${h}${ch}]`;
}

function toSmiles(g: Graph): string {
  const children = new Map<number, { to: number; order: number }[]>();
  for (const e of g.edges) {
    // 組み立ては * から外へ向かうので、a が親
    children.set(e.a, [...(children.get(e.a) ?? []), { to: e.b, order: e.order }]);
  }
  const bondSym = (o: number) => (o === 2 ? '=' : o === 3 ? '#' : '');
  const emit = (i: number): string => {
    const n = g.nodes[i];
    if (n.group !== undefined) return n.group;
    const kids = children.get(i) ?? [];
    let s = i === 0 ? '*' : atomSmiles(n);
    kids.forEach((c, j) => {
      const part = bondSym(c.order) + emit(c.to);
      s += j < kids.length - 1 ? `(${part})` : part;
    });
    return s;
  };
  return [emit(0), ...g.ions].join('.');
}

function tryBuild(toks: Tok[]): string | null {
  try {
    const g = new Graph();
    // 部品を書き換える所（CnH2n+1 の H）があるので、写しで組み立てる
    build(g, structuredClone(toks), 0);
    if (!g.edges.some((e) => e.a === 0)) return null;
    saturate(g);
    return toSmiles(g);
  } catch (e) {
    if (e instanceof BuildError) return null;
    throw e;
  }
}

export interface Condensed {
  /** * で結合する SMILES（対イオンは . のあと） */
  smiles: string;
  /** 右向きの書き方（左向きで書いたものは並べ直す。HOH2C → CH2OH） */
  label: string;
  /** 左向きの書き方 */
  reversed: string;
}

function tokText(toks: Tok[]): string {
  return toks
    .map((t) => {
      const n = t.n > 1 ? String(t.n) : '';
      if (t.t === 'el') return t.n === 0 ? '' : t.el + n;
      if (t.t === 'grp') return t.name + n;
      return t.oxo ? `(O)${n}` : `(${tokText(t.toks)})${n}`;
    })
    .join('');
}

/**
 * ラベルを読む。読めなければ null。右向きの順で読めなければ、左向きの書き方として読む。
 * 元素 1 つ（OH・NH2・Cl）は元素のラベルで扱うので、ここでは読まない
 */
export function parseCondensed(text: string, group: GroupTable): Condensed | null {
  const t = text.trim();
  if (!t || t.length > 40) return null;
  // 略号を長く取る読み方で読めなければ、元素に分けて読む（COMe = C(=O)Me）
  for (const atomic of [false, true]) {
    const toks = tokenize(t, group, atomic);
    if (!toks || !toks.length) continue;
    const fwd = tryBuild(toks);
    if (fwd) return { smiles: fwd, label: t, reversed: tokText(reverseToks(toks)) };
    const rev = reverseToks(toks);
    const back = tryBuild(rev);
    if (back) return { smiles: back, label: tokText(rev), reversed: t };
  }
  return null;
}

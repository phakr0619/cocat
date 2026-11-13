// 文字の幅の見積もり（Helvetica/Arial の字幅、1000 単位）。ラベルで結合を切る位置と、当たり判定に使う。
const W: Record<string, number> = {
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  '+': 584, '-': 333, '−': 584, '(': 333, ')': 333, ' ': 278, '.': 278, ',': 278, ':': 278, '%': 889, '°': 400,
  '/': 278, '=': 584, '·': 278, '[': 278, ']': 278, '!': 278, '?': 556, '&': 667, '*': 389, '\'': 191, '"': 355, '<': 584, '>': 584, '~': 584, '–': 556,
};

export const CAP_HEIGHT = 0.716;

export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const cw = W[ch];
    // 日本語など表に無い文字は全角として数える
    w += cw ?? (ch.charCodeAt(0) > 0x2e80 ? 1000 : 556);
  }
  return (w / 1000) * size;
}

export interface Run {
  text: string;
  /** ベースラインの左端 */
  x: number;
  y: number;
  size: number;
  bold?: boolean;
}

/** 化学式ではない試薬の名前（数字を下付きにしない） */
const LITERAL_NAMES = /\b(T3P)\b/g;

function literalDigit(body: string, i: number): boolean {
  for (const m of body.matchAll(LITERAL_NAMES)) if (i >= m.index! && i < m.index! + m[0].length) return true;
  return false;
}

export const SUB_SCALE = 0.75;
export const SUB_DROP = 0.28;
export const SUP_RISE = 0.42;

/**
 * 化学式の書式で文字列を並べる。英字の後の数字は下付き、charge は上付き。
 * 戻り値の x は 0 始まり。charX は body の各文字の左端。
 */
export function formulaRuns(
  body: string,
  size: number,
  baseline: number,
  charge = '',
): { runs: Run[]; width: number; charX: number[] } {
  const runs: Run[] = [];
  const charX: number[] = [];
  let x = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (/\d/.test(ch) && i > 0 && /[A-Za-z)\]]/.test(body[i - 1]) && !literalDigit(body, i)) {
      let j = i;
      while (j < body.length && /\d/.test(body[j])) j++;
      const s = body.slice(i, j);
      const sz = size * SUB_SCALE;
      for (let k = i; k < j; k++) charX.push(x);
      runs.push({ text: s, x, y: baseline + size * SUB_DROP, size: sz });
      x += textWidth(s, sz);
      i = j;
    } else {
      let j = i;
      while (j < body.length && !(/\d/.test(body[j]) && j > 0 && /[A-Za-z)\]]/.test(body[j - 1]) && !literalDigit(body, j))) j++;
      for (let k = i; k < j; k++) {
        charX.push(x + textWidth(body.slice(i, k), size));
      }
      const s = body.slice(i, j);
      runs.push({ text: s, x, y: baseline, size });
      x += textWidth(s, size);
      i = j;
    }
  }
  if (charge) {
    const sz = size * SUB_SCALE;
    const s = charge.replace('-', '−');
    runs.push({ text: s, x, y: baseline - size * SUP_RISE, size: sz });
    x += textWidth(s, sz);
  }
  return { runs, width: x, charX };
}

/** 文字の書式つきの 1 かたまり（文字の欄の 1 行を分けたもの） */
export interface RichSeg {
  text: string;
  script?: 'sup' | 'sub';
  italic?: boolean;
  bold?: boolean;
}

/**
 * 文字の欄の書き方: ^{…} か ^x は上付き、_{…} か _x は下付き、*…* は斜体、**…** は太字。\ の次の文字はそのまま。
 * 例: 「Pd^{2+}」「k_{obs}」「*t*-BuOK」「**1a**」
 */
export function parseRich(s: string): RichSeg[] {
  const out: RichSeg[] = [];
  let italic = false;
  let bold = false;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, ...(italic ? { italic } : {}), ...(bold ? { bold } : {}) });
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      buf += s[++i];
    } else if (ch === '*' && s[i + 1] === '*') {
      flush();
      bold = !bold;
      i++;
    } else if (ch === '*' && s.indexOf('*', i + 1) > i + 1) {
      // 閉じる * があるときだけ斜体（「R*」のような 1 つだけの * は文字のまま）
      flush();
      italic = !italic;
    } else if (ch === '*' && italic) {
      flush();
      italic = false;
    } else if ((ch === '^' || ch === '_') && i + 1 < s.length) {
      let t: string;
      if (s[i + 1] === '{' && s.indexOf('}', i + 2) > 0) {
        const j = s.indexOf('}', i + 2);
        t = s.slice(i + 2, j);
        i = j;
      } else {
        t = s[i + 1];
        i++;
      }
      flush();
      out.push({ text: t, script: ch === '^' ? 'sup' : 'sub', ...(italic ? { italic } : {}), ...(bold ? { bold } : {}) });
    } else buf += ch;
  }
  flush();
  return out;
}

/** 書き方の印が入っているか（入っていなければ、今までどおり 1 つの文字として描く） */
export const hasRich = (s: string): boolean => /[\^_]|\*[^*]*\*|\\/.test(s);

// PDF の文字を行・段落に分け、化合物番号の段落（合成手順）を探す。
// AI は使わない。pdf.js の getTextContent の項目（文字・位置・大きさ）だけから決める
//
// 実際の論文（tests/llm-eval/real-papers.json）で分かったこと:
// - 上付き（¹H の 1、文献番号）は、字が小さく少し上にある。そのまま続けると「化合物 15 ＋ 文献 3」が「153」になるので、「15^3」と書く
// - SI の見出しは「(R)-Hex-5-en-2-ol ((R)-4) (CAS …) [1,2]」「Synthesis of compound 17: To a …」「Compound S2」など
// - 本文は 2 段組み（左の段を読み終えてから右の段）

/** pdf.js の文字の項目（transform[4]・[5] が位置、height が字の大きさ） */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLine {
  page: number;
  /** 行の下端（PDF の座標、上が大きい） */
  y: number;
  x: number;
  /** 本文の字の大きさ */
  size: number;
  text: string;
}

/** pdf.js の getTextContent().items を、この形にする */
export function toItems(items: readonly unknown[]): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const it of items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    if (typeof it.str !== 'string' || !it.transform) continue;
    out.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: it.height || Math.abs(it.transform[3]) || 0 });
  }
  return out;
}

/** 小さい方から q の割合の所の値（q = 0.3 なら、行の間のうち狭い方の代表＝ふつうの行の間） */
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * q)];
};

/** 1 ページの項目を行にする。pageWidth は 2 段組みの見分けに使う */
export function linesOf(items: readonly PdfTextItem[], page: number, pageWidth: number): TextLine[] {
  const vis = items.filter((it) => it.str.trim() && it.h > 0);
  if (!vis.length) return [];
  // 高さの近い項目を 1 行にまとめる（上付き・下付きは、行の字の大きさの半分までずれてもよい）
  const sorted = [...vis].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  for (const it of sorted) {
    const row = rows.find((r) => {
      const base = r.reduce((m, x) => (x.h > m.h ? x : m), r[0]);
      return Math.abs(it.y - base.y) <= Math.max(base.h, it.h) * 0.5;
    });
    if (row) row.push(it);
    else rows.push([it]);
  }
  // 行の中で大きく離れた所と、ページの真ん中をまたぐ空き（2 段組みの間）で分ける
  const mid = pageWidth / 2;
  const segs: PdfTextItem[][] = [];
  for (const r of rows) {
    r.sort((a, b) => a.x - b.x);
    let cur: PdfTextItem[] = [];
    for (const it of r) {
      const prev = cur[cur.length - 1];
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      const crossesMid = prev && prev.x + prev.w <= mid + 2 && it.x >= mid - 2 && gap > Math.max(prev.h, it.h) * 0.3;
      if (prev && (gap > Math.max(prev.h, it.h) * 1.0 || crossesMid)) {
        segs.push(cur);
        cur = [];
      }
      cur.push(it);
    }
    if (cur.length) segs.push(cur);
  }
  const lines = segs.map((s) => lineOf(s, page));
  // 2 段組み: 幅が半分ほどの行が左右の両方に多くあれば、左の段 → 右の段の順に読む
  const half = pageWidth * 0.5;
  const isLeft = (l: TextLine, s: PdfTextItem[]) => l.x < half * 0.95 && s[s.length - 1].x + s[s.length - 1].w < half * 1.1;
  const isRight = (l: TextLine) => l.x > half * 0.9;
  const leftN = lines.filter((l, i) => isLeft(l, segs[i])).length;
  const rightN = lines.filter(isRight).length;
  const twoCol = leftN >= 8 && rightN >= 8 && leftN + rightN >= lines.length * 0.6;
  const order = lines.map((l) => ({ l, col: twoCol && isRight(l) ? 1 : 0 }));
  order.sort((a, b) => a.col - b.col || b.l.y - a.l.y || a.l.x - b.l.x);
  return order.map((o) => o.l);
}

function lineOf(items: PdfTextItem[], page: number): TextLine {
  const base = items.reduce((m, x) => (x.h > m.h ? x : m), items[0]);
  let text = '';
  let prev: PdfTextItem | null = null;
  for (const it of items) {
    const sup = it.h < base.h * 0.85 && it.y - base.y > base.h * 0.15;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > base.h * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    }
    // 上付きは「^」を付ける（前が英数字のときだけ。文の頭の ¹H NMR は ^1H になる）
    text += sup && /[A-Za-z0-9)\]]$/.test(text.trimEnd()) ? `^${it.str.trim()}` : sup ? `^${it.str.trim()}` : it.str;
    prev = it;
  }
  return { page, y: base.y, x: items[0].x, size: base.h, text: text.replace(/\s+/g, ' ').trim() };
}

/** 行を段落にする。行の間が、ふだんの行の間（狭い方から 3 割の所）の 1.35 倍より広ければ段落の切れ目 */
export function paragraphsOf(lines: readonly TextLine[]): TextLine[][] {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i - 1].y - lines[i].y;
    if (lines[i].page === lines[i - 1].page && d > 0) gaps.push(d);
  }
  const usual = quantile(gaps, 0.3) || 14;
  const out: TextLine[][] = [];
  let cur: TextLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const p = lines[i - 1];
    const brk = !p || l.page !== p.page || p.y - l.y > usual * 1.35 || p.y - l.y < 0 || Math.abs(l.size - p.size) > p.size * 0.2;
    if (brk && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 行をつなぐ。行末のハイフンは、前後が英小文字のときだけ取る（化合物名の「pent-4-en」の「-」は残す） */
export function joinLines(lines: readonly TextLine[]): string {
  let s = '';
  for (const l of lines) {
    if (!s) s = l.text;
    else if (/[a-z]-$/.test(s) && /^[a-z]/.test(l.text) && !/\d-$/.test(s)) s = s.slice(0, -1) + l.text;
    else if (/-$/.test(s)) s += l.text;
    else s += ' ' + l.text;
  }
  return s;
}

/** 化合物番号の形（4、4a、S12、17'、(R)-4 の 4） */
const LABEL = String.raw`[A-Z]{0,2}\d{1,3}[a-z]?['’′]*`;
/** 立体の前置き（(R)-、(S,S)-、(4R,8R)-、(±)-、rac-） */
const STEREO = String.raw`(?:\((?:±|\d*[RSEZ]\*?(?:,\s*\d*[RSEZ]\*?)*)\)-|rac-)?`;

/** 図の呼び名から番号を取り出す（「(±)-simonsol C (5)」→「5」、「saframycin A (1)」→「1」）。番号でなければそのまま */
export function figureLabel(name: string): string {
  const m = /\(\s*([A-Z]{0,2}\d{1,3}[a-z]?['’′]*)\s*\)\s*$/.exec(name);
  return m && name.trim() !== m[0].trim() ? m[1] : name.trim();
}

/** 番号のならし: 立体の前置きを外し、プライムをそろえる（「(4R,8R)-1」→「1」） */
export function normalizeLabel(label: string): string {
  return stereoLabel(label).replace(new RegExp(`^${STEREO}`), '');
}

/** 立体の前置きを残したまま、空白・プライム・外側のかっこをそろえる（「((R)-4)」→「(R)-4」） */
export function stereoLabel(label: string): string {
  let t = label.trim().replace(/^compound\s+/i, '').replace(/[’′]/g, "'").replace(/\s+/g, '');
  if (/^\(.*\)$/.test(t) && !new RegExp(`^${STEREO}$`).test(t.slice(0, t.lastIndexOf(')') + 1))) t = t.slice(1, -1);
  return t;
}

/** 図の番号と段落の番号が同じ化合物か。図の番号に立体の前置きがあれば、前置きも同じこと（(R)-4 と (S)-4 は別の化合物） */
/** 化合物番号らしいか（「3」「4a」「S12」「15'」「(R)-4」）。番号でなければ、図の呼び名（「Boc-Ala-OH」など） */
export function isNumberLabel(label: string): boolean {
  return /^[A-Z]{0,2}\d{1,3}[a-z]?['’′]*$/.test(normalizeLabel(label));
}

/** 呼び名どうしを比べる形（大文字小文字・空白・ダッシュの違いを問わない） */
const looseName = (s: string) => s.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, '').toLowerCase();

export function sameLabel(figure: string, section: { label: string; fullLabel: string }): boolean {
  if (normalizeLabel(figure) !== section.label) return false;
  const f = stereoLabel(figure);
  return f === normalizeLabel(f) || f === section.fullLabel;
}

export interface Section {
  /** 見つけた所（「SI」「本文」など）と、始まりのページ */
  source: string;
  page: number;
  kind: 'compound' | 'procedure';
  /** 化合物の番号（立体の前置きを外したもの）か、手順の名前（「A」） */
  label: string;
  /** 書いてあるとおりの番号（「(R)-4」。前置きが無ければ label と同じ） */
  fullLabel: string;
  /** 見出しの化合物名（系統名。書いていなければ空） */
  name: string;
  text: string;
  /** この段落が触れている一般的な手順（「A」） */
  procedures: string[];
}

const VERB = /\b(was|were|is|are|added|stirred|gave|afforded|afford|obtained|treated|using|with|in which)\b/i;

/** 段落の頭が見出しなら、その種類と番号・名前を返す */
export function headingOf(par: string): { kind: Section['kind']; label: string; fullLabel: string; name: string } | null {
  const t = par.trim();
  // 図・表・スキームの見出し（「Figure S25. … of 14 (H18)」）は化合物の見出しではない
  if (/^(?:Figure|Fig\.|Table|Scheme|Chart)\s*S?\d/i.test(t)) return null;
  const compound = (raw: string, name = '') => ({ kind: 'compound' as const, label: normalizeLabel(raw), fullLabel: stereoLabel(raw), name });
  let m = new RegExp(String.raw`^(?:Synthesis|Preparation) of (?:compound\s+)?(${STEREO}${LABEL})\s*[:.]`, 'i').exec(t);
  if (m) return compound(m[1]);
  // 「Compound S2」は、その行だけのとき（段落の頭の 1 行として調べる）か、後に「:」「.」が続くときだけ。「Compound 9 was …」は文
  m = new RegExp(String.raw`^Compound\s+(${STEREO}${LABEL})\s*(?:[:.](?!\d)|$)`, 'i').exec(t);
  if (m) return compound(m[1]);
  // 「General procedure A」「General procedure (GP-1)」。「General methods and materials」は手順の見出しではない
  m = /^General (?:procedure|method)\b\s*(?:\(?\s*(?:GP\s*-?\s*)?([A-Z]|\d+|[IVX]+)\)?(?![\w]))?/i.exec(t);
  if (m && !/^General (?:procedure|method)s?\s+(?:and|for)\b/i.test(t)) return { kind: 'procedure', label: (m[1] ?? '').toUpperCase(), fullLabel: (m[1] ?? '').toUpperCase(), name: '' };
  // 「系統名 (番号)」で終わる見出し。後に短いかっこ書き（(new compound)・(CAS …)・[1,2]）が付くこともある。文になっている（動詞を含む）ものは見出しではない
  m = new RegExp(String.raw`^(.{3,260}?)\s*\(\s*(${STEREO}${LABEL})\s*\)((?:\s*[([][^()[\]]{0,40}[)\]])*)\s*[.:]?\s*$`).exec(t);
  if (m && !VERB.test(m[1]) && !/^\d+\.\s|spectr/i.test(m[1]) && /^[A-Za-z(\d[±]/.test(m[1]) && /^[A-Z(\d[±]|^(?:tert|sec|iso|cis|trans|endo|exo|rac|[nN]-|[a-z]-)/.test(m[1])) return compound(m[2], m[1].trim());
  return null;
}

/** 段落が触れている一般的な手順（「general procedure A」「GP-A」「according to GP1」） */
export function procedureRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/general (?:procedure|method)\s*\(?([A-Z]|\d+|[IVX]+)\b\)?/gi)) out.add(m[1].toUpperCase());
  for (const m of text.matchAll(/\bGP\s*-?\s*([A-Z]|\d+)\b/g)) out.add(m[1].toUpperCase());
  return [...out];
}

/** 1 本の PDF の行（全ページ）を、見出しで始まる段落のまとまりに分ける。見出しの前の段落は捨てる */
export function sectionsOf(lines: readonly TextLine[], source: string, maxChars = 3000): Section[] {
  const pars = paragraphsOf(lines);
  const out: Section[] = [];
  let cur: { sec: Section; parts: string[] } | null = null;
  const close = () => {
    if (!cur) return;
    const text = cur.parts.join('\n');
    cur.sec.text = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    cur.sec.procedures = procedureRefs(cur.sec.text).filter((p) => !(cur!.sec.kind === 'procedure' && p === cur!.sec.label));
    out.push(cur.sec);
    cur = null;
  };
  for (const p of pars) {
    const text = joinLines(p);
    // 見出しは段落の頭の 1〜3 行（長い系統名は折り返す）。行の間が狭いと、見出しと手順の文が 1 つの段落になる
    let head = headingOf(text);
    for (let k = 1; !head && k <= Math.min(3, p.length - 1); k++) head = headingOf(joinLines(p.slice(0, k)));
    if (head) {
      close();
      cur = { sec: { source, page: p[0].page, kind: head.kind, label: head.label, fullLabel: head.fullLabel, name: head.name, text: '', procedures: [] }, parts: [text] };
    } else if (cur) cur.parts.push(text);
  }
  close();
  return out;
}

/** 番号が文の中に出てくるか（4 が 4.83 や 14 に当たらないように、前後が英数字・小数点でないこと） */
export function mentions(text: string, label: string): boolean {
  const esc = label.replace(/[.*+?^${}()|[\]\\']/g, (c) => (c === "'" ? "['’′]" : `\\${c}`));
  return new RegExp(String.raw`(?<![\w.^])${esc}(?![\w]|\.\d)`).test(text);
}

export interface CollectedPart {
  source: string;
  page: number;
  /** 何のために送るか */
  why: 'figure-page' | 'compound' | 'procedure' | 'mention';
  label?: string;
  name?: string;
  text: string;
}

export interface Collected {
  parts: CollectedPart[];
  /** 見出しの段落（合成手順）が見つからなかった生成物の番号（基質は市販品で手順が無いのが普通なので入れない） */
  missing: string[];
  /** 上限で送れなかったもの */
  dropped: CollectedPart[];
  /** 番号も呼び名も無いので、段落を探せなかった図の化合物の数 */
  unlabeled?: number;
  chars: number;
}

/**
 * 送る文字を集める（11.3）。figurePage は図のページの行、docs は本文・SI の見出しのまとまり（sectionsOf）と全段落。
 * products は生成物の番号（上限を超えたとき先に残す）、labels はそのほかの番号
 */
export function collectText(
  req: {
    figurePage?: { source: string; page: number; lines: readonly TextLine[] };
    docs: readonly { source: string; sections: readonly Section[]; paragraphs: readonly { page: number; text: string }[] }[];
    products: readonly string[];
    others: readonly string[];
  },
  limit = 30000,
): Collected {
  const wanted: CollectedPart[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const push = (p: CollectedPart) => {
    const key = `${p.source}|${p.page}|${p.text.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    wanted.push(p);
  };
  const procWanted = new Set<string>();
  const labels = [...new Set([...req.products, ...req.others].map(stereoLabel).filter(Boolean))];
  const productSet = new Set(req.products.map(normalizeLabel));
  for (const label of labels) {
    let found = false;
    for (const d of req.docs) {
      for (const s of d.sections) {
        // 番号でない呼び名（番号の無い図）は、見出しの名前と同じなら、その化合物の段落とみなす
        if (s.kind === 'compound' && (sameLabel(label, s) || (!isNumberLabel(label) && !!s.name && looseName(s.name) === looseName(label)))) {
          push({ source: s.source, page: s.page, why: 'compound', label: s.fullLabel, name: s.name || undefined, text: s.text });
          s.procedures.forEach((x) => procWanted.add(x));
          found = true;
        }
      }
    }
    if (!found) {
      // 見出しが無ければ、番号が出てくる段落を 2 つまで（説明の文など）
      let n = 0;
      for (const d of req.docs) {
        for (const p of d.paragraphs) {
          if (n >= 2) break;
          if (mentions(p.text, normalizeLabel(label))) {
            push({ source: d.source, page: p.page, why: 'mention', label, text: p.text });
            n++;
          }
        }
      }
      if (productSet.has(normalizeLabel(label))) missing.push(label);
    }
  }
  for (const d of req.docs) for (const s of d.sections) if (s.kind === 'procedure' && procWanted.has(s.label)) push({ source: s.source, page: s.page, why: 'procedure', label: s.label, text: s.text });

  // 上限: 図のページ → 生成物 → ほかの化合物 → 手順 → 説明の段落の順に残す
  const products = new Set(req.products.map(normalizeLabel));
  const rank = (p: CollectedPart) => (p.why === 'figure-page' ? 0 : p.why === 'compound' && products.has(normalizeLabel(p.label!)) ? 1 : p.why === 'compound' ? 2 : p.why === 'procedure' ? 3 : 4);
  const all: CollectedPart[] = [];
  if (req.figurePage) all.push({ source: req.figurePage.source, page: req.figurePage.page, why: 'figure-page', text: paragraphsOf(req.figurePage.lines).map(joinLines).join('\n') });
  all.push(...wanted);
  all.sort((a, b) => rank(a) - rank(b));
  const parts: CollectedPart[] = [];
  const dropped: CollectedPart[] = [];
  let chars = 0;
  for (const p of all) {
    if (chars + p.text.length > limit) dropped.push(p);
    else {
      parts.push(p);
      chars += p.text.length;
    }
  }
  return { parts, missing, dropped, chars };
}

/** 送る文字（②に渡す形）。ページと出所を各まとまりの頭に書く */
export function collectedText(c: Collected): string {
  return c.parts
    .map((p) => {
      const what = p.why === 'figure-page' ? 'page with the figure' : p.why === 'procedure' ? `general procedure ${p.label}` : `compound ${p.label}`;
      return `[${p.source} p.${p.page} — ${what}]\n${p.text}`;
    })
    .join('\n\n');
}

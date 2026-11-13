// CDXML を読むための小さな XML パーサー（ブラウザとテストの両方で同じものを使う）
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack.at(-1)!.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      i = src.indexOf('-->', lt) + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      i = src.indexOf('?>', lt) + 2;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      stack.at(-1)!.text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE（内部サブセットの [] を含むことがある）
      let depth = 0;
      let j = lt;
      for (; j < src.length; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const gt = findTagEnd(src, lt);
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const nm = inner.match(/^\s*([^\s/>]+)/);
    if (!nm) continue;
    const node: XmlNode = { name: nm[1], attrs: {}, children: [], text: '' };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    const rest = inner.slice(nm[0].length);
    while ((m = re.exec(rest))) node.attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
    stack.at(-1)!.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function findTagEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let j = from + 1; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  return src.length;
}

export function* walk(n: XmlNode): Generator<XmlNode> {
  yield n;
  for (const c of n.children) yield* walk(c);
}

/** 要素の中の文字（<s> をつなげたもの） */
export function innerText(n: XmlNode): string {
  return n.text + n.children.map(innerText).join('');
}

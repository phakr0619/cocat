// CDX（ChemDraw のバイナリの形式）の読み書き。CDX と CDXML は同じ物を表す 2 つの書き方なので、
// 読むときは CDXML の文字に直して readCdxml に渡し、書くときは writeCdxml の CDXML を CDX に直す。
// 形: 先頭の 28 バイト（"VjCD0100" ほか）のあと、物（番号の上の位が 1）と性質（番号・長さ・値）の木。
// 番号と名前の対応は src/io/cdxTables.ts（ChemDraw の部品の表から作った）
import { CDX_ENUMS, CDX_OBJECTS, CDX_PROPS, type CdxType } from './cdxTables';
import { escapeXml } from '../render/layout';
import { parseXml, type XmlNode } from './xml';

const HEADER = 'VjCD0100';
const HEADER_LEN = 28;
/** CDX の座標は 1/65536 pt の整数 */
const UNIT = 65536;

export function isCdx(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_LEN && String.fromCharCode(...bytes.subarray(0, 8)) === HEADER;
}

// ---------------------------------------------------------------- 読む

const PROP_BY_NAME = new Map(Object.entries(CDX_PROPS).map(([k, [name, type]]) => [name, { code: Number(k), type }]));
const OBJ_BY_NAME = new Map(Object.entries(CDX_OBJECTS).map(([k, name]) => [name, Number(k)]));

const num = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

function decodeText(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

function enumName(attr: string, v: number): string {
  const e = CDX_ENUMS[attr];
  if (!e) return String(v);
  if (e[v] !== undefined) return e[v];
  // 組み合わせ（RectangleType・OvalType・ArrowType は、いくつかの値を足したもの）
  const parts: string[] = [];
  for (const [k, name] of Object.entries(e)) {
    const bit = Number(k);
    if (bit > 0 && (v & bit) === bit) parts.push(name);
  }
  return parts.length ? parts.join(' ') : String(v);
}

interface Obj {
  name: string;
  attrs: Record<string, string>;
  children: Obj[];
  /** <t> の中の文字（<s> になる） */
  runs?: { font: number; size: number; face: number; color?: number; text: string }[];
  /** 文書の性質のうち、要素で書く物（fonttable・colortable） */
  extra?: string[];
}

class Reader {
  private v: DataView;
  pos = HEADER_LEN;
  constructor(private b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get done() {
    return this.pos + 2 > this.b.length;
  }
  u16() {
    const x = this.v.getUint16(this.pos, true);
    this.pos += 2;
    return x;
  }
  u32() {
    const x = this.v.getUint32(this.pos, true);
    this.pos += 4;
    return x;
  }
  bytes(n: number) {
    if (this.pos + n > this.b.length) throw new Error('CDX のファイルが途中で切れています');
    const x = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return x;
  }
}

function readValue(type: CdxType, d: Uint8Array, attr: string): string | null {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const i32 = (o: number) => v.getInt32(o, true) / UNIT;
  switch (type) {
    case 'INT8':
      return d.length ? enumName(attr, v.getInt8(0)) : null;
    case 'UINT8':
      return d.length ? enumName(attr, v.getUint8(0)) : null;
    case 'INT16':
      return d.length >= 2 ? enumName(attr, v.getInt16(0, true)) : d.length ? enumName(attr, v.getInt8(0)) : null;
    case 'UINT16':
      return d.length >= 2 ? enumName(attr, v.getUint16(0, true)) : null;
    case 'CDXBoolean':
      return !d.length || v.getUint8(0) ? 'yes' : 'no';
    case 'ANGLE10':
      return d.length >= 2 ? num(v.getInt16(0, true) / 10) : null;
    case 'CDXCoordinate':
      return d.length >= 4 ? num(i32(0)) : null;
    case 'CDXObjectID':
      return d.length >= 4 ? String(v.getUint32(0, true)) : null;
    case 'CDXObjectIDArray': {
      const ids: number[] = [];
      for (let o = 0; o + 4 <= d.length; o += 4) ids.push(v.getUint32(o, true));
      return ids.join(' ');
    }
    case 'CDXPoint2D':
      // 縦・横の順
      return d.length >= 8 ? `${num(i32(4))} ${num(i32(0))}` : null;
    case 'CDXPoint3D':
      return d.length >= 12 ? `${num(i32(0))} ${num(i32(4))} ${num(i32(8))}` : null;
    case 'CDXRectangle':
      // 上・左・下・右の順。CDXML は 左 上 右 下
      return d.length >= 16 ? `${num(i32(4))} ${num(i32(0))} ${num(i32(12))} ${num(i32(8))}` : null;
    case 'CDXCurvePoints': {
      const n = v.getUint16(0, true);
      const out: string[] = [];
      for (let k = 0; k < n && 2 + k * 8 + 8 <= d.length; k++) out.push(`${num(i32(2 + k * 8 + 4))} ${num(i32(2 + k * 8))}`);
      return out.join(' ');
    }
    case 'CDXString': {
      const styles = v.getUint16(0, true);
      return decodeText(d.subarray(2 + styles * 10));
    }
  }
}

function readTextRuns(d: Uint8Array): NonNullable<Obj['runs']> {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint16(0, true);
  const body = d.subarray(2 + n * 10);
  const styles = Array.from({ length: n }, (_, k) => {
    const o = 2 + k * 10;
    return { start: v.getUint16(o, true), font: v.getUint16(o + 2, true), face: v.getUint16(o + 4, true), size: v.getUint16(o + 6, true) / 20, color: v.getUint16(o + 8, true) };
  });
  if (!styles.length) return [{ font: 0, size: 10, face: 0, text: decodeText(body) }];
  return styles.map((s, k) => ({ font: s.font, size: s.size, face: s.face, color: s.color, text: decodeText(body.subarray(s.start, styles[k + 1]?.start ?? body.length)) }));
}

function readFontTable(d: Uint8Array): string {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint16(2, true);
  let o = 4;
  const fonts: string[] = [];
  for (let k = 0; k < n && o + 6 <= d.length; k++) {
    const id = v.getUint16(o, true);
    const charset = v.getUint16(o + 2, true);
    const len = v.getUint16(o + 4, true);
    const name = decodeText(d.subarray(o + 6, o + 6 + len));
    o += 6 + len;
    fonts.push(`<font id="${id}" charset="${charset === 65001 ? 'utf-8' : 'iso-8859-1'}" name="${escapeXml(name)}"/>`);
  }
  return `<fonttable>${fonts.join('')}</fonttable>`;
}

function readColorTable(d: Uint8Array): string {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint16(0, true);
  const c: string[] = [];
  for (let k = 0; k < n && 2 + k * 6 + 6 <= d.length; k++) {
    const o = 2 + k * 6;
    c.push(`<color r="${num(v.getUint16(o, true) / 65535)}" g="${num(v.getUint16(o + 2, true) / 65535)}" b="${num(v.getUint16(o + 4, true) / 65535)}"/>`);
  }
  return `<colortable>${c.join('')}</colortable>`;
}

function readObject(r: Reader, name: string, id: number | null): Obj {
  const o: Obj = { name, attrs: id ? { id: String(id) } : {}, children: [] };
  while (!r.done) {
    const tag = r.u16();
    if (tag === 0) break;
    if (tag & 0x8000) {
      const cid = r.u32();
      const child = readObject(r, CDX_OBJECTS[tag] ?? '', cid);
      // 知らない物は、中の知っている物だけを残す
      if (child.name) o.children.push(child);
      else o.children.push(...child.children);
      continue;
    }
    let len = r.u16();
    if (len === 0xffff) len = r.u32();
    const d = r.bytes(len);
    if (tag === 0x0700) o.runs = readTextRuns(d);
    else if (tag === 0x0100) (o.extra ??= []).push(readFontTable(d));
    else if (tag === 0x0300) (o.extra ??= []).push(readColorTable(d));
    else {
      const p = CDX_PROPS[tag];
      if (!p) continue;
      const s = readValue(p[1], d, p[0]);
      if (s !== null) o.attrs[p[0]] = s;
    }
  }
  return o;
}

function toXml(o: Obj): string {
  const attrs = Object.entries(o.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  const runs = (o.runs ?? []).map((s) => `<s font="${s.font}" size="${num(s.size)}" face="${s.face}"${s.color !== undefined ? ` color="${s.color}"` : ''}>${escapeXml(s.text)}</s>`);
  const inner = [...(o.extra ?? []), ...runs, ...o.children.map(toXml)].join('');
  return inner ? `<${o.name}${attrs}>${inner}</${o.name}>` : `<${o.name}${attrs}/>`;
}

/** CDX のバイト列を CDXML の文字にする */
export function cdxToCdxml(bytes: Uint8Array): string {
  if (!isCdx(bytes)) throw new Error('CDX のファイルではありません。先頭が VjCD0100 ではありません');
  const r = new Reader(bytes);
  let doc: Obj;
  // 決まりでは先頭は文書の物（0x8000）。書かずに性質から始めるソフト（Indigo など）もある
  const first = new DataView(bytes.buffer, bytes.byteOffset).getUint16(HEADER_LEN, true);
  if (first === 0x8000) {
    r.u16();
    const id = r.u32();
    doc = readObject(r, 'CDXML', id);
  } else doc = readObject(r, 'CDXML', null);
  return `<?xml version="1.0" encoding="UTF-8" ?>\n${toXml(doc)}\n`;
}

// ---------------------------------------------------------------- 書く

class Writer {
  private chunks: Uint8Array[] = [];
  private len = 0;
  push(b: Uint8Array) {
    this.chunks.push(b);
    this.len += b.length;
  }
  u16(x: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, x, true);
    this.push(b);
  }
  u32(x: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, x >>> 0, true);
    this.push(b);
  }
  prop(tag: number, d: Uint8Array) {
    this.u16(tag);
    if (d.length >= 0xffff) {
      this.u16(0xffff);
      this.u32(d.length);
    } else this.u16(d.length);
    this.push(d);
  }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

const enc = new TextEncoder();
const fnums = (s: string) => s.trim().split(/[\s,]+/).filter(Boolean).map(Number);

function enumValue(attr: string, s: string): number | null {
  const e = CDX_ENUMS[attr];
  if (e) {
    const exact = Object.entries(e).find(([, name]) => name === s);
    if (exact) return Number(exact[0]);
    let sum = 0;
    for (const part of s.split(/\s+/)) {
      const hit = Object.entries(e).find(([, name]) => name === part);
      if (!hit) return /^-?\d+$/.test(s) ? Number(s) : null;
      sum |= Number(hit[0]);
    }
    return sum;
  }
  return /^-?\d+(\.\d+)?$/.test(s.trim()) ? Math.round(Number(s)) : null;
}

function encodeValue(type: CdxType, attr: string, s: string): Uint8Array | null {
  const buf = (n: number) => {
    const b = new Uint8Array(n);
    return { b, v: new DataView(b.buffer) };
  };
  const coord = (x: number) => Math.round(x * UNIT);
  switch (type) {
    case 'INT8':
    case 'UINT8': {
      const x = enumValue(attr, s);
      if (x === null) return null;
      const { b, v } = buf(1);
      if (type === 'INT8') v.setInt8(0, x);
      else v.setUint8(0, x);
      return b;
    }
    case 'INT16':
    case 'UINT16': {
      const x = enumValue(attr, s);
      if (x === null) return null;
      const { b, v } = buf(2);
      if (type === 'INT16') v.setInt16(0, x, true);
      else v.setUint16(0, x, true);
      return b;
    }
    case 'ANGLE10': {
      const x = Number(s);
      if (!Number.isFinite(x)) return null;
      const { b, v } = buf(2);
      v.setInt16(0, Math.round(x * 10), true);
      return b;
    }
    case 'CDXBoolean': {
      const { b, v } = buf(1);
      v.setUint8(0, s === 'yes' ? 1 : 0);
      return b;
    }
    case 'CDXCoordinate': {
      const x = Number(s);
      if (!Number.isFinite(x)) return null;
      const { b, v } = buf(4);
      v.setInt32(0, coord(x), true);
      return b;
    }
    case 'CDXObjectID': {
      const { b, v } = buf(4);
      v.setUint32(0, Number(s) >>> 0, true);
      return b;
    }
    case 'CDXObjectIDArray': {
      const ids = fnums(s);
      const { b, v } = buf(ids.length * 4);
      ids.forEach((x, k) => v.setUint32(k * 4, x >>> 0, true));
      return b;
    }
    case 'CDXPoint2D': {
      const [x, y] = fnums(s);
      if (y === undefined) return null;
      const { b, v } = buf(8);
      v.setInt32(0, coord(y), true);
      v.setInt32(4, coord(x), true);
      return b;
    }
    case 'CDXPoint3D': {
      const [x, y, z = 0] = fnums(s);
      if (y === undefined) return null;
      const { b, v } = buf(12);
      v.setInt32(0, coord(x), true);
      v.setInt32(4, coord(y), true);
      v.setInt32(8, coord(z), true);
      return b;
    }
    case 'CDXRectangle': {
      const [l, t, r, bt] = fnums(s);
      if (bt === undefined) return null;
      const { b, v } = buf(16);
      v.setInt32(0, coord(t), true);
      v.setInt32(4, coord(l), true);
      v.setInt32(8, coord(bt), true);
      v.setInt32(12, coord(r), true);
      return b;
    }
    case 'CDXCurvePoints': {
      const xs = fnums(s);
      const n = Math.floor(xs.length / 2);
      const { b, v } = buf(2 + n * 8);
      v.setUint16(0, n, true);
      for (let k = 0; k < n; k++) {
        v.setInt32(2 + k * 8, coord(xs[k * 2 + 1]), true);
        v.setInt32(2 + k * 8 + 4, coord(xs[k * 2]), true);
      }
      return b;
    }
    case 'CDXString': {
      const t = enc.encode(s);
      const { b, v } = buf(2 + t.length);
      v.setUint16(0, 0, true);
      b.set(t, 2);
      return b;
    }
  }
}

function encodeRuns(ss: XmlNode[]): Uint8Array {
  const parts = ss.map((s) => ({ s, t: enc.encode(s.text + s.children.map((c) => c.text).join('')) }));
  const total = parts.reduce((a, p) => a + p.t.length, 0);
  const b = new Uint8Array(2 + parts.length * 10 + total);
  const v = new DataView(b.buffer);
  v.setUint16(0, parts.length, true);
  let start = 0;
  parts.forEach(({ s, t }, k) => {
    const o = 2 + k * 10;
    v.setUint16(o, start, true);
    v.setUint16(o + 2, Number(s.attrs.font ?? 0) || 0, true);
    v.setUint16(o + 4, Number(s.attrs.face ?? 0) || 0, true);
    v.setUint16(o + 6, Math.round((Number(s.attrs.size ?? 10) || 10) * 20), true);
    v.setUint16(o + 8, Number(s.attrs.color ?? 0) || 0, true);
    b.set(t, 2 + parts.length * 10 + start);
    start += t.length;
  });
  return b;
}

function encodeFontTable(n: XmlNode): Uint8Array {
  const fonts = n.children.filter((c) => c.name === 'font').map((f) => ({ id: Number(f.attrs.id) || 0, name: enc.encode(f.attrs.name ?? 'Arial') }));
  const b = new Uint8Array(4 + fonts.reduce((a, f) => a + 6 + f.name.length, 0));
  const v = new DataView(b.buffer);
  v.setUint16(0, 0, true);
  v.setUint16(2, fonts.length, true);
  let o = 4;
  for (const f of fonts) {
    v.setUint16(o, f.id, true);
    // 名前は UTF-8 で書くので、文字の集まりも UTF-8（65001）にする
    v.setUint16(o + 2, 65001, true);
    v.setUint16(o + 4, f.name.length, true);
    b.set(f.name, o + 6);
    o += 6 + f.name.length;
  }
  return b;
}

function encodeColorTable(n: XmlNode): Uint8Array {
  const cs = n.children.filter((c) => c.name === 'color');
  const b = new Uint8Array(2 + cs.length * 6);
  const v = new DataView(b.buffer);
  v.setUint16(0, cs.length, true);
  cs.forEach((c, k) => {
    const ch = (x: string | undefined) => Math.max(0, Math.min(65535, Math.round((Number(x) || 0) * 65535)));
    v.setUint16(2 + k * 6, ch(c.attrs.r), true);
    v.setUint16(2 + k * 6 + 2, ch(c.attrs.g), true);
    v.setUint16(2 + k * 6 + 4, ch(c.attrs.b), true);
  });
  return b;
}

/** CDXML の文字を CDX のバイト列にする。表に無い要素・属性は書かない */
export function cdxmlToCdx(xml: string): Uint8Array {
  const root = parseXml(xml);
  const top = root.children.find((c) => c.name === 'CDXML');
  if (!top) throw new Error('CDXML の要素がありません');
  let maxId = 0;
  const scan = (n: XmlNode) => {
    maxId = Math.max(maxId, Number(n.attrs.id) || 0);
    n.children.forEach(scan);
  };
  scan(top);
  const w = new Writer();
  const head = new Uint8Array(HEADER_LEN);
  head.set(enc.encode(HEADER));
  head.set([4, 3, 2, 1], 8);
  w.push(head);
  const writeObj = (n: XmlNode) => {
    const code = OBJ_BY_NAME.get(n.name);
    if (code === undefined) return;
    w.u16(code);
    w.u32(n.attrs.id ? Number(n.attrs.id) : n.name === 'CDXML' ? 0 : ++maxId);
    for (const [k, s] of Object.entries(n.attrs)) {
      if (k === 'id') continue;
      const p = PROP_BY_NAME.get(k);
      if (!p) continue;
      const d = encodeValue(p.type, k, s);
      if (d) w.prop(p.code, d);
    }
    for (const c of n.children) {
      if (c.name === 'fonttable') w.prop(0x0100, encodeFontTable(c));
      else if (c.name === 'colortable') w.prop(0x0300, encodeColorTable(c));
    }
    const ss = n.children.filter((c) => c.name === 's');
    if (n.name === 't' && ss.length) w.prop(0x0700, encodeRuns(ss));
    for (const c of n.children) writeObj(c);
    w.u16(0);
  };
  // ChemDraw の部品と同じく、文書の物から始め、最後にもう 1 つ終わりの印を置く（ChemDraw 7 はこれを要る）
  writeObj(top);
  w.u16(0);
  return w.bytes();
}

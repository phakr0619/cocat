// CDXML（ChemDraw の XML 形式）の書き出しと読み込み。座標は pt・y 下向きで、文書と同じ。
import { expandSalts } from '../chem/saltLabel';
import { getAbbr, resolveAbbr } from '../chem/abbreviations';
import { isRGroup, parseLabel } from '../chem/label';
import { expandAbbr } from '../chem/abbrOps';
import { atomicNumber, symbolOf } from '../chem/elements';
import { rectOfPoints, rectUnion, type P, type Rect } from '../chem/geometry';
import { implicitHydrogens } from '../chem/hydrogens';
import type { Arrow, ArrowKind, ShapeKind, Atom, TextBox, BondOrder, BondStereo, Doc, DoublePos } from '../chem/model';
import { adjacency, emptyDoc, fragments, molecules, newId, neighbors } from '../chem/model';
import { pageDims } from '../chem/page';
import { reactionSteps } from '../chem/reactionSteps';
import { ACS, applyDrawStyle, BOND_LEN } from '../chem/style';
import { escapeXml, layout, type Prim } from '../render/layout';
import { hasRich, parseRich, type RichSeg } from '../render/text';
import { innerText, parseXml, walk, type XmlNode } from './xml';

const n2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const pp = (p: P) => `${n2(p.x)} ${n2(p.y)}`;
const bb = (r: Rect) => `${n2(r.x1)} ${n2(r.y1)} ${n2(r.x2)} ${n2(r.y2)}`;
const FONT_ID = 3;

/** ラベルの文字。CDXML では電荷も ASCII の +/- で書く */
const plain = (s: string) => s.replace(/−/g, '-');

export function writeCdxml(doc: Doc): string {
  // 図の設定（線の太さ・文字の大きさ）を当ててから描く
  const restore = applyDrawStyle(doc.drawStyle);
  try {
    // ラベルに書いた塩（NH2Cl）は、ChemDraw に同じ書き方が無いので、陽イオンと対イオンの原子にして書く
    return writeCdxmlNow(expandSalts(doc).doc);
  } finally {
    restore();
  }
}

function writeCdxmlNow(doc: Doc): string {
  const lay = layout(doc);
  const adj = adjacency(doc);
  let nextId = 1;
  const nid = () => nextId++;
  const atomNode = new Map<string, number>();
  const objIdById = new Map<string, number>();
  const body: string[] = [];
  // 色の表: 0 は黒・1 は白で決まっていて、表の 1 つ目（白）が 2、2 つ目（黒）が 3。物の色はそのあとに足す（4 から）
  const palette: string[] = [];
  for (const rec of [doc.atoms, doc.bonds, doc.arrows, doc.texts, doc.pluses, doc.shapes ?? {}] as Record<string, { color?: string }>[]) {
    for (const o of Object.values(rec)) if (o.color && !palette.includes(o.color.toLowerCase())) palette.push(o.color.toLowerCase());
  }
  const col = (o: { color?: string } | undefined) => (o?.color ? ` color="${palette.indexOf(o.color.toLowerCase()) + 4}"` : '');

  // 分子ごとに fragment を書く。塩（まとまり）の部分は <group> で包み、ChemDraw でも一緒に動くようにする（docs/salt-design.md）
  const fragOfAtom = new Map<string, number>();
  const groupOfAtom = new Map<string, number>();
  const fragXml = (f: string[]): string => {
    const fid = nid();
    for (const id of f) (atomNode.set(id, nid()), fragOfAtom.set(id, fid));
    const box = rectOfPoints(f.map((id) => doc.atoms[id]))!;
    const lines: string[] = [`<fragment id="${fid}" BoundingBox="${bb(box)}">`];
    for (const id of f) lines.push(nodeXml(doc.atoms[id]));
    const fset = new Set(f);
    for (const b of Object.values(doc.bonds)) {
      if (!fset.has(b.a1)) continue;
      lines.push(bondXml(nid(), atomNode.get(b.a1)!, atomNode.get(b.a2)!, b.order, b.stereo, b.doublePos, col(b)));
    }
    lines.push('</fragment>');
    return lines.join('\n');
  };
  const fragsAll = fragments(doc, adj);
  for (const mol of molecules(doc, adj)) {
    const set = new Set(mol);
    const parts = fragsAll.filter((f) => set.has(f[0]));
    if (parts.length < 2) {
      body.push(fragXml(parts[0]));
      continue;
    }
    const gid = nid();
    for (const id of mol) groupOfAtom.set(id, gid);
    const box = rectOfPoints(mol.map((id) => doc.atoms[id]))!;
    body.push([`<group id="${gid}" BoundingBox="${bb(box)}">`, ...parts.map(fragXml), '</group>'].join('\n'));
  }
  /** スキームの物（分子）の CDXML の id: 塩なら group、そうでなければ fragment */
  const molRef = (atomIds: string[]) => (atomIds.length ? (groupOfAtom.get(atomIds[0]) ?? fragOfAtom.get(atomIds[0])) : undefined);

  function bondXml(id: number, B: number, E: number, order: BondOrder, stereo: BondStereo, pos: DoublePos, color = ''): string {
    let s = `<b id="${id}" B="${B}" E="${E}"${color}`;
    if (stereo === 'dative') s += ' Order="dative"';
    // 点線の結合は ChemDraw の水素結合にする（ふつうの結合のまま書くと、O−H···O の H が 2 価になり、ChemDraw の部品が分子を読まない）
    else if (stereo === 'dashed') s += ' Order="hydrogen"';
    else if (order !== 1) s += ` Order="${order}"`;
    if (stereo === 'bold') s += ' Display="Bold"';
    else if (stereo === 'dashed') s += ' Display="Dash"';
    else if (stereo === 'wedge') s += ' Display="WedgeBegin"';
    else if (stereo === 'hash') s += ' Display="WedgedHashBegin"';
    else if (stereo === 'wavy') s += ' Display="Wavy"';
    if (order === 2 && pos !== 'auto') s += ` DoublePosition="${pos === 'center' ? 'Center' : pos === 'left' ? 'Left' : 'Right'}"`;
    return s + '/>';
  }

  function labelXml(atomId: string, text: string): string {
    const l = lay.labels.get(atomId);
    if (!l || !l.runs.length) return '';
    const box = l.boxes.reduce<Rect | null>((r, b) => rectUnion(r, b), null)!;
    const a = doc.atoms[atomId];
    const right = l.runs[0].x < a.x - 4;
    const just = right ? ' LabelJustification="Right" LabelAlignment="Right"' : ' LabelJustification="Left"';
    return `<t p="${pp({ x: l.runs[0].x, y: l.runs[0].y })}" BoundingBox="${bb(box)}"${just}><s font="${FONT_ID}" size="${ACS.labelSize}" face="96"${col(a)}>${escapeXml(plain(text))}</s></t>`;
  }

  function nodeXml(a: Atom): string {
    const id = atomNode.get(a.id)!;
    if (a.abbr && getAbbr(a.abbr)) return abbrNodeXml(a, id);
    let s = `<n id="${id}" p="${pp(a)}"${col(a)}`;
    if (a.element === '*') s += ` NodeType="GenericNickname" GenericNickname="${escapeXml(a.abbr ?? 'R')}"`;
    else if (a.element !== 'C') s += ` Element="${atomicNumber(a.element)}"`;
    if (a.charge) s += ` Charge="${a.charge}"`;
    if (a.isotope) s += ` Isotope="${a.isotope}"`;
    if (a.radical) s += ' Radical="Doublet"';
    // rac・rel の組（ChemDraw の Enhanced Stereochemistry と同じ）
    if (a.stereoGroup) s += ` EnhancedStereoType="${a.stereoGroup.type === 'and' ? 'And' : 'Or'}" EnhancedStereoGroupNum="${a.stereoGroup.n}"`;
    const l = lay.labels.get(a.id);
    const showLabel = l && (a.element !== 'C' || (adj.bondsOf.get(a.id)?.length ?? 0) === 0);
    if (!showLabel) return s + '/>';
    s += ` NumHydrogens="${implicitHydrogens(a, adj)}"`;
    const text = l!.runs.map((r) => r.text).join('');
    return `${s}>${labelXml(a.id, text)}</n>`;
  }

  /** 略号は、中に展開した構造を持つ Fragment ノードにする（ChemDraw の略号と同じ形） */
  function abbrNodeXml(a: Atom, id: number): string {
    const ex = expandAbbr(doc, a.id, false);
    const inner = Object.values(ex.atoms).filter((x) => !doc.atoms[x.id] || x.id === a.id);
    const innerIds = new Map(inner.map((x) => [x.id, nid()]));
    const fid = nid();
    const lines = [`<n id="${id}" p="${pp(a)}" NodeType="Fragment" NeedsClean="yes"${col(a)}>`, `<fragment id="${fid}">`];
    for (const x of inner) {
      let s = `<n id="${innerIds.get(x.id)}" p="${pp(x)}"`;
      if (x.element !== 'C') s += ` Element="${atomicNumber(x.element)}"`;
      if (x.charge) s += ` Charge="${x.charge}"`;
      lines.push(s + '/>');
    }
    const ns = neighbors(adj, a.id);
    const ecp = nid();
    const nbPos = ns.length ? doc.atoms[ns[0]] : { x: a.x - BOND_LEN, y: a.y };
    lines.push(`<n id="${ecp}" p="${pp(nbPos)}" NodeType="ExternalConnectionPoint"/>`);
    for (const b of Object.values(ex.bonds)) {
      if (innerIds.has(b.a1) && innerIds.has(b.a2)) lines.push(bondXml(nid(), innerIds.get(b.a1)!, innerIds.get(b.a2)!, b.order, b.stereo, b.doublePos));
    }
    lines.push(bondXml(nid(), ecp, innerIds.get(a.id)!, 1, 'none', 'auto'));
    lines.push('</fragment>');
    const l = lay.labels.get(a.id);
    lines.push(labelXml(a.id, l ? l.runs.map((r) => r.text).join('') : a.abbr!));
    lines.push('</n>');
    return lines.join('\n');
  }

  for (const t of Object.values(doc.texts)) {
    const id = nid();
    objIdById.set(t.id, id);
    const box = lay.textBoxes.get(t.id) ?? { x1: t.x, y1: t.y - 8, x2: t.x + 10, y2: t.y + 2 };
    body.push(
      // face: 1 は太字、96 は化学式（英字の後の数字を下付き）
      `<t id="${id}" p="${pp(t)}" BoundingBox="${bb(box)}" Justification="Left" InterpretChemically="no">${textRunsXml(t, col(t))}</t>`,
    );
  }
  const ARROW_TYPE: Partial<Record<ArrowKind, string>> = { normal: 'FullHead', equilibrium: 'Equilibrium', retro: 'RetroSynthetic', line: 'NoHead' };
  for (const r of Object.values(doc.arrows)) {
    const id = nid();
    objIdById.set(r.id, id);
    // 共鳴・曲がった矢印・点線・進まない は、ChemDraw と同じく <arrow> で書く
    if (r.kind === 'resonance' || r.kind === 'curved' || r.dashed || r.noGo) {
      body.push(arrowXml(id, r).replace('<arrow ', `<arrow${col(r)} `));
      continue;
    }
    // Line の BoundingBox は「頭 尾」の順
    if (r.kind === 'line') {
      body.push(`<graphic id="${id}"${col(r)} BoundingBox="${n2(r.x2)} ${n2(r.y2)} ${n2(r.x1)} ${n2(r.y1)}" GraphicType="Line"/>`);
      continue;
    }
    body.push(
      `<graphic id="${id}"${col(r)} BoundingBox="${n2(r.x2)} ${n2(r.y2)} ${n2(r.x1)} ${n2(r.y1)}" GraphicType="Line" ArrowType="${ARROW_TYPE[r.kind]}" HeadSize="1000" ArrowheadCenterSize="875" ArrowheadWidth="250"/>`,
    );
  }
  // 図形: 四角・楕円・括弧の組
  const BRACKET: Record<string, string> = { 'bracket-square': 'SquarePair', 'bracket-round': 'RoundPair', 'bracket-curly': 'CurlyPair' };
  for (const sh of Object.values(doc.shapes ?? {})) {
    const box = `${n2(sh.x1)} ${n2(sh.y1)} ${n2(sh.x2)} ${n2(sh.y2)}`;
    if (sh.kind === 'rect') body.push(`<graphic id="${nid()}"${col(sh)} BoundingBox="${box}" GraphicType="Rectangle"/>`);
    else if (sh.kind === 'oval') {
      const cx = (sh.x1 + sh.x2) / 2;
      const cy = (sh.y1 + sh.y2) / 2;
      body.push(`<graphic id="${nid()}"${col(sh)} BoundingBox="${box}" GraphicType="Oval" Center3D="${n2(cx)} ${n2(cy)} 0" MajorAxisEnd3D="${n2(sh.x2)} ${n2(cy)} 0" MinorAxisEnd3D="${n2(cx)} ${n2(sh.y2)} 0"/>`);
    } else body.push(`<graphic id="${nid()}"${col(sh)} BoundingBox="${box}" GraphicType="Bracket" BracketType="${BRACKET[sh.kind]}"/>`);
  }
  // ローンペアは、ChemDraw と同じく原子の近くの記号（LonePair）として書く。位置は描いた点と同じ
  for (const a of Object.values(doc.atoms)) {
    if (!a.lonePairs) continue;
    const dots = lay.prims.filter((q) => q.owner === a.id && q.k === 'poly' && q.pts.length === 8) as Extract<Prim, { k: 'poly' }>[];
    const centers = dots.map((q) => ({ x: q.pts.reduce((s, p) => s + p.x, 0) / 8, y: q.pts.reduce((s, p) => s + p.y, 0) / 8 }));
    // ラジカルの点（先頭の 1 つ）を除いて、2 つずつ組にする
    const pairs = centers.slice(a.radical ? 1 : 0);
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const c = { x: (pairs[i].x + pairs[i + 1].x) / 2, y: (pairs[i].y + pairs[i + 1].y) / 2 };
      body.push(`<graphic id="${nid()}" BoundingBox="${n2(c.x - 1.5)} ${n2(c.y - 1.5)} ${n2(c.x + 1.5)} ${n2(c.y + 1.5)}" GraphicType="Symbol" SymbolType="LonePair"/>`);
    }
  }
  for (const p of Object.values(doc.pluses)) {
    const id = nid();
    objIdById.set(p.id, id);
    body.push(`<graphic id="${id}"${col(p)} BoundingBox="${n2(p.x - 3.6)} ${n2(p.y - 3.6)} ${n2(p.x + 3.6)} ${n2(p.y + 3.6)}" GraphicType="Symbol" SymbolType="Plus"/>`);
  }

  const steps = reactionSteps(doc, lay.textBoxes);
  if (steps.length) {
    const ref = (objs: { key: string; id?: string; atomIds: string[] }[]) => objs.map((o) => (o.id ? objIdById.get(o.id) : molRef(o.atomIds))).filter(Boolean).join(' ');
    const lines = [`<scheme id="${nid()}">`];
    for (const st of steps) {
      const attrs: string[] = [`id="${nid()}"`];
      const add = (name: string, v: string) => v && attrs.push(`${name}="${v}"`);
      add('ReactionStepReactants', ref(st.reactants));
      add('ReactionStepProducts', ref(st.products));
      add('ReactionStepPlusses', ref(st.pluses));
      add('ReactionStepArrows', String(objIdById.get(st.arrowId)));
      add('ReactionStepObjectsAboveArrow', ref(st.above));
      add('ReactionStepObjectsBelowArrow', ref(st.below));
      lines.push(`<step ${attrs.join(' ')}/>`);
    }
    lines.push('</scheme>');
    body.push(lines.join('\n'));
  }

  const box = lay.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
  // ページの設定があればその大きさと枚数（ChemDraw で開いて同じ並びになるかは、まだ確かめていない）。無ければ図が入るだけのレターの紙
  const pw = doc.page ? pageDims(doc.page).w : 540;
  const ph = doc.page ? pageDims(doc.page).h : 720;
  const widthPages = doc.page?.cols ?? Math.max(1, Math.ceil((box.x2 + 36) / 540));
  const heightPages = doc.page?.rows ?? Math.max(1, Math.ceil((box.y2 + 36) / 720));
  return [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd" >',
    `<CDXML CreationProgram="ai-chem-editor" BoundingBox="${bb(box)}" WindowPosition="0 0" WindowSize="0 0" FractionalWidths="yes" InterpretChemically="yes" ShowAtomQuery="yes" ShowAtomStereo="no" ShowAtomEnhancedStereo="yes" ShowAtomNumber="no" ShowBondQuery="yes" ShowBondRxn="yes" ShowBondStereo="no" ShowTerminalCarbonLabels="no" ShowNonTerminalCarbonLabels="no" HideImplicitHydrogens="no" LabelFont="${FONT_ID}" LabelSize="${ACS.labelSize}" LabelFace="96" CaptionFont="${FONT_ID}" CaptionSize="${ACS.captionSize}" HashSpacing="${n2(ACS.hashSpacing)}" MarginWidth="${n2(ACS.marginWidth)}" LineWidth="${n2(ACS.lineWidth)}" BoldWidth="${n2(ACS.boldWidth)}" BondLength="${n2(ACS.bondLength)}" BondSpacing="${ACS.bondSpacing * 100}" ChainAngle="${ACS.chainAngle}" LabelJustification="Auto" CaptionJustification="Left" AminoAcidTermini="HOH" ShowSequenceTermini="yes" ShowSequenceBonds="yes" PrintMargins="36 36 36 36" color="0" bgcolor="1">`,
    '<colortable>',
    '<color r="1" g="1" b="1"/>',
    '<color r="0" g="0" b="0"/>',
    ...palette.map((h) => {
      const v = (i: number) => n2(parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255);
      return `<color r="${v(0)}" g="${v(1)}" b="${v(2)}"/>`;
    }),
    '</colortable>',
    '<fonttable>',
    `<font id="${FONT_ID}" charset="iso-8859-1" name="${ACS.fontName}"/>`,
    '</fonttable>',
    `<page id="${nid()}" BoundingBox="0 0 ${+(pw * widthPages).toFixed(2)} ${+(ph * heightPages).toFixed(2)}" HeaderPosition="36" FooterPosition="36" PrintTrimMarks="yes" HeightPages="${heightPages}" WidthPages="${widthPages}">`,
    ...body,
    '</page>',
    '</CDXML>',
    '',
  ].join('\n');
}

/**
 * 文字の欄を <s> の並びにする。書き方の印（^{…}・_{…}・*…*・**…**）は、ChemDraw の文字の飾り（face）にする:
 * 1 太字・2 斜体・32 下付き・64 上付き・96 化学式（英字の後の数字を下付き）
 */
function textRunsXml(t: TextBox, color: string): string {
  const base = (t.bold ? 1 : 0) | (t.formula ? 96 : 0);
  const segs = hasRich(t.text) ? parseRich(t.text) : [{ text: t.text } as RichSeg];
  return segs
    .map((s) => {
      let face = s.script === 'sup' ? 64 | (base & 1) : s.script === 'sub' ? 32 | (base & 1) : base;
      if (s.italic) face |= 2;
      if (s.bold) face |= 1;
      return `<s font="${FONT_ID}" size="${ACS.captionSize}" face="${face}"${color}>${escapeXml(s.text)}</s>`;
    })
    .join('');
}

/** <s> の並びを、文字の欄の書き方に戻す（太字・化学式が全体に付いていれば、欄の印にする） */
function textFromRuns(ss: { text: string; face: number }[]): { text: string; bold: boolean; formula: boolean } {
  const plain = ss.filter((s) => !(((s.face & 96) === 32) || ((s.face & 96) === 64)));
  const allBold = ss.length > 0 && ss.every((s) => s.face & 1);
  const formula = plain.length > 0 && plain.every((s) => (s.face & 96) === 96);
  const esc = (x: string) => x.replace(/([\\^_*])/g, '\\$1');
  const text = ss
    .map((s) => {
      let x = esc(s.text);
      const script = s.face & 96;
      if (script === 64) x = x.length === 1 ? `^${x}` : `^{${x}}`;
      else if (script === 32) x = x.length === 1 ? `_${x}` : `_{${x}}`;
      if (s.face & 2) x = `*${x}*`;
      if (s.face & 1 && !allBold) x = `**${x}**`;
      return x;
    })
    .join('');
  return { text, bold: allBold, formula };
}

/** 曲がった矢印の、尾・曲線の中ほど・頭を通る円（中心・半径・尾から頭までの角度。角度は画面の向き、度） */
export function arcOf(r: Arrow): { c: { x: number; y: number }; rad: number; sweep: number } | null {
  if (r.cx === undefined || r.cy === undefined) return null;
  const t = { x: r.x1, y: r.y1 };
  const h = { x: r.x2, y: r.y2 };
  const m = { x: 0.25 * t.x + 0.5 * r.cx + 0.25 * h.x, y: 0.25 * t.y + 0.5 * r.cy + 0.25 * h.y };
  const d = 2 * (t.x * (m.y - h.y) + m.x * (h.y - t.y) + h.x * (t.y - m.y));
  if (Math.abs(d) < 1e-6) return null;
  const s = (p: { x: number; y: number }) => p.x * p.x + p.y * p.y;
  const c = {
    x: (s(t) * (m.y - h.y) + s(m) * (h.y - t.y) + s(h) * (t.y - m.y)) / d,
    y: (s(t) * (h.x - m.x) + s(m) * (t.x - h.x) + s(h) * (m.x - t.x)) / d,
  };
  const ang = (p: { x: number; y: number }) => Math.atan2(p.y - c.y, p.x - c.x);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  // 尾 → 中ほど → 頭 と回る向きで、尾から頭までの角度
  const a1 = norm(ang(m) - ang(t));
  const a2 = norm(ang(h) - ang(m));
  return { c, rad: Math.hypot(t.x - c.x, t.y - c.y), sweep: ((a1 + a2) * 180) / Math.PI };
}

/** 円の中心・尾・角度から、曲がった矢印の制御点に戻す */
function controlFromArc(c: number[], tail: number[], head: number[], sweep: number): { cx: number; cy: number } {
  const rad = Math.hypot(tail[0] - c[0], tail[1] - c[1]);
  const a = Math.atan2(tail[1] - c[1], tail[0] - c[0]) + ((sweep / 2) * Math.PI) / 180;
  const m = { x: c[0] + rad * Math.cos(a), y: c[1] + rad * Math.sin(a) };
  return { cx: 2 * m.x - (tail[0] + head[0]) / 2, cy: 2 * m.y - (tail[1] + head[1]) / 2 };
}

function arrowXml(id: number, r: Arrow): string {
  const head = `${n2(r.x2)} ${n2(r.y2)} 0`;
  const tail = `${n2(r.x1)} ${n2(r.y1)} 0`;
  const xs = [r.x1, r.x2, ...(r.cx !== undefined ? [r.cx] : [])];
  const ys = [r.y1, r.y2, ...(r.cy !== undefined ? [r.cy] : [])];
  let s = `<arrow id="${id}" BoundingBox="${n2(Math.min(...xs))} ${n2(Math.min(...ys))} ${n2(Math.max(...xs))} ${n2(Math.max(...ys))}" FillType="None" ArrowheadType="Solid" HeadSize="1000" ArrowheadCenterSize="875" ArrowheadWidth="250"`;
  s += ` ArrowheadHead="${r.kind === 'curved' && r.half ? 'HalfLeft' : 'Full'}"`;
  if (r.kind === 'resonance') s += ' ArrowheadTail="Full"';
  if (r.dashed) s += ' LineType="Dashed"';
  if (r.noGo) s += ' NoGo="Cross"';
  s += ` Head3D="${head}" Tail3D="${tail}"`;
  const arc = r.kind === 'curved' ? arcOf(r) : null;
  if (arc) {
    s += ` Center3D="${n2(arc.c.x)} ${n2(arc.c.y)} 0" MajorAxisEnd3D="${n2(arc.c.x + arc.rad)} ${n2(arc.c.y)} 0" MinorAxisEnd3D="${n2(arc.c.x)} ${n2(arc.c.y + arc.rad)} 0" AngularSize="${n2(arc.sweep)}"`;
  }
  return s + '/>';
}

// ---------------------------------------------------------------- 読み込み

const nums = (s: string | undefined) => (s ?? '').trim().split(/\s+/).map(Number);

/** 読み込みで、構造の抜けたラベルを補った・読めなかったものの知らせ */
export interface LabelReport {
  /** 構造を補ったラベル（ChemDraw のファイルで、ラベルの文字だけがあり中身が違った・無かったもの） */
  repaired: string[];
  /** 読めなかったラベル（赤い枠で示す） */
  unreadable: string[];
}

export function readCdxml(src: string, report?: LabelReport): Doc {
  const root = parseXml(src);
  const cdxml = [...walk(root)].find((n) => n.name === 'CDXML');
  if (!cdxml) throw new Error('CDXML の要素がありません');
  const d = emptyDoc();
  const nodeAtom = new Map<string, string>();
  const hasArrowElems = [...walk(cdxml)].some((n) => n.name === 'arrow');
  // 色の表（0 は黒・1 は白、表の 1 つ目が 2）。黒と白は色を付けない
  const colors = new Map<number, string>();
  const table = cdxml.children.find((c) => c.name === 'colortable');
  (table?.children.filter((c) => c.name === 'color') ?? []).forEach((c, i) => {
    const h = (v: string | undefined) => Math.round(Math.max(0, Math.min(1, parseFloat(v ?? '0') || 0)) * 255).toString(16).padStart(2, '0');
    const hex = `#${h(c.attrs.r)}${h(c.attrs.g)}${h(c.attrs.b)}`;
    if (hex !== '#000000' && hex !== '#ffffff') colors.set(i + 2, hex);
  });
  const colorAttr = (n: XmlNode | undefined): { color?: string } => {
    const c = colors.get(parseInt(n?.attrs.color ?? '', 10));
    return c ? { color: c } : {};
  };

  const visit = (n: XmlNode, inNode: boolean) => {
    for (const c of n.children) {
      if (c.name === 'fragment' && !inNode) readFragment(c);
      else if (c.name === 'group' && !inNode) readGroup(c);
      else if (c.name === 't' && !inNode) readText(c);
      else if (c.name === 'graphic') readGraphic(c);
      else if (c.name === 'arrow') readArrow(c);
      else if (c.name === 'n') continue;
      else visit(c, inNode);
    }
  };

  function checkLabel(atom: Atom, text: string) {
    const p = parseLabel(text);
    if (p?.kind === 'element') {
      const same = p.element === atom.element && !p.salt;
      if (!same) report?.repaired.push(text);
      atom.element = p.element;
      if (p.charge) atom.charge = p.charge;
      if (p.isotope) atom.isotope = p.isotope;
      if (p.salt) atom.salt = { x: p.salt.x, style: p.salt.style };
      return;
    }
    if (p?.kind === 'abbr') {
      const def = getAbbr(p.abbr);
      // Me のように中身が同じ 1 原子なら、構造は抜けていない（略号として描くだけ）
      if (!def || def.smiles !== `*${atom.element}`) report?.repaired.push(text);
      atom.element = '*';
      atom.abbr = p.abbr;
      atom.charge = 0;
      return;
    }
    // 読めないラベル: 炭素などにせず、ラベルの文字のまま「構造の分からない置換基」として持つ（赤い枠で示す）
    report?.unreadable.push(text);
    atom.element = '*';
    atom.abbr = text;
    atom.charge = 0;
  }

  function addAtomFromNode(n: XmlNode): string | null {
    const [x, y] = nums(n.attrs.p);
    const type = n.attrs.NodeType;
    if (type === 'ExternalConnectionPoint') return null;
    const id = newId(d, 'a');
    const atom: Atom = { id, x, y, element: 'C', charge: parseInt(n.attrs.Charge ?? '0', 10) || 0 };
    if (n.attrs.Element) atom.element = symbolOf(parseInt(n.attrs.Element, 10)) ?? '*';
    const est = n.attrs.EnhancedStereoType;
    if (est === 'And' || est === 'Or') atom.stereoGroup = { type: est === 'And' ? 'and' : 'or', n: parseInt(n.attrs.EnhancedStereoGroupNum ?? '1', 10) || 1 };
    Object.assign(atom, colorAttr(n));
    const iso = parseInt(n.attrs.Isotope ?? '', 10);
    if (iso > 0) atom.isotope = iso;
    if (n.attrs.Radical === 'Doublet') atom.radical = true;
    const label = n.children.find((c) => c.name === 't');
    const inner = n.children.find((c) => c.name === 'fragment');
    const text = label ? innerText(label).trim() : (n.attrs.GenericNickname ?? '');
    if (type === 'GenericNickname' || (text && isRGroup(text))) {
      // 置換基の記号（R・R1・Ar・X・PG など）。構造が決まっていないのが正しい
      atom.element = '*';
      atom.abbr = text || 'R';
      atom.charge = 0;
    } else if (inner && (type === 'Fragment' || type === 'Nickname' || type === 'Unspecified')) {
      // ChemDraw が中身の構造を埋め込んだ略号。名前が分かれば略号のまま、分からなければ中の構造を展開して読む
      const ab = resolveAbbr(text);
      if (ab) {
        atom.element = '*';
        atom.abbr = ab;
        atom.charge = 0;
      } else {
        const attach = readFragment(inner);
        if (attach) {
          nodeAtom.set(n.attrs.id, attach);
          return attach;
        }
        atom.element = '*';
      }
    } else if (text) {
      // ラベルの文字だけがあるノード。中身（元素）がラベルと合っているか確かめ、合わなければラベルから構造を補う。
      // ChemDraw は読めないラベルを、文字だけ残して炭素などの 1 原子として保存することがある（ほかのソフトはメチル基として読む）
      checkLabel(atom, text);
    }
    d.atoms[id] = atom;
    nodeAtom.set(n.attrs.id, id);
    return id;
  }

  /** 戻り値: 外とつながる原子（ExternalConnectionPoint の相手） */
  /** <group> の中に分子が 2 つ以上あれば、1 つの塩（まとまり）として読む（ChemDraw で塩をグループにしたもの・このエディタの書き出し） */
  function readGroup(g: XmlNode) {
    const before = new Set(Object.keys(d.atoms));
    visit(g, false);
    const added = Object.keys(d.atoms).filter((id) => !before.has(id));
    const keep = new Set(added);
    const parts = fragments(d, adjacency(d)).filter((f) => f.some((id) => keep.has(id)));
    if (parts.length < 2) return;
    const unit = newId(d, 'u');
    for (const id of added) d.atoms[id].unit = unit;
  }

  function readFragment(f: XmlNode): string | null {
    for (const c of f.children) if (c.name === 'n') addAtomFromNode(c);
    const ecp = new Set(f.children.filter((c) => c.name === 'n' && c.attrs.NodeType === 'ExternalConnectionPoint').map((c) => c.attrs.id));
    let attach: string | null = null;
    for (const c of f.children) {
      if (c.name !== 'b') continue;
      const B = c.attrs.B;
      const E = c.attrs.E;
      if (ecp.has(B) || ecp.has(E)) {
        attach = nodeAtom.get(ecp.has(B) ? E : B) ?? null;
        continue;
      }
      let a1 = nodeAtom.get(B);
      let a2 = nodeAtom.get(E);
      if (!a1 || !a2) continue;
      const ord = parseFloat(c.attrs.Order ?? '1');
      const order = (ord >= 3 ? 3 : ord >= 2 ? 2 : 1) as BondOrder;
      const disp = c.attrs.Display ?? '';
      let stereo: BondStereo = 'none';
      if (/^Wedge(Begin|End)$/.test(disp)) stereo = 'wedge';
      else if (/^WedgedHash(Begin|End)$/.test(disp) || disp === 'Hash') stereo = 'hash';
      else if (disp === 'Wavy') stereo = 'wavy';
      else if (disp === 'Bold') stereo = 'bold';
      else if (disp === 'Dash' || disp === 'Dot') stereo = 'dashed';
      if (c.attrs.Order === 'dative') stereo = 'dative';
      if (c.attrs.Order === 'hydrogen') stereo = 'dashed';
      if (/End$/.test(disp)) [a1, a2] = [a2, a1];
      const dp = c.attrs.DoublePosition;
      const doublePos: DoublePos = dp === 'Center' ? 'center' : dp === 'Left' ? 'left' : dp === 'Right' ? 'right' : 'auto';
      const id = newId(d, 'b');
      d.bonds[id] = { id, a1, a2, order: stereo !== 'none' ? 1 : order, stereo, doublePos, ...colorAttr(c) };
    }
    return attach;
  }

  function readText(t: XmlNode) {
    const [x, y] = nums(t.attrs.p);
    const raw = innerText(t).replace(/\r/g, '');
    if (!raw.trim()) return;
    const id = newId(d, 't');
    const ss = t.children.filter((c) => c.name === 's').map((c) => ({ text: innerText(c).replace(/\r/g, ''), face: parseInt(c.attrs.face ?? '0', 10) || 0 }));
    const color = colorAttr(t.children.find((c) => c.name === 's'));
    const faces = new Set(ss.map((q) => q.face));
    if (ss.length && faces.size > 1) {
      // 上付き・下付き・斜体・一部の太字があれば、文字の欄の書き方の印に直す
      const r = textFromRuns(ss);
      d.texts[id] = { id, x, y, text: r.text, ...(r.bold ? { bold: true } : {}), ...(r.formula ? { formula: true } : {}), ...color };
      return;
    }
    const face = ss[0]?.face ?? 0;
    // 書き方の印に使う文字（^ _ *）がそのまま入っていたら、印と読まないように \ を付ける
    const text = hasRich(raw) ? raw.replace(/([\\^_*])/g, '\\$1') : raw;
    if ((face & 96) === 64 || (face & 96) === 32 || face & 2) {
      const r = textFromRuns(ss);
      d.texts[id] = { id, x, y, text: r.text, ...(r.bold ? { bold: true } : {}), ...color };
      return;
    }
    d.texts[id] = { id, x, y, text, ...(face & 1 ? { bold: true } : {}), ...((face & 96) === 96 ? { formula: true } : {}), ...color };
  }

  function readGraphic(g: XmlNode) {
    const box = nums(g.attrs.BoundingBox);
    if (g.attrs.GraphicType === 'Line' && g.attrs.ArrowType && g.attrs.ArrowType !== 'NoHead') {
      if (hasArrowElems && g.attrs.SupersededBy) return;
      const kind: ArrowKind = g.attrs.ArrowType === 'Equilibrium' ? 'equilibrium' : g.attrs.ArrowType === 'RetroSynthetic' ? 'retro' : g.attrs.ArrowType === 'Resonance' ? 'resonance' : 'normal';
      const id = newId(d, 'r');
      d.arrows[id] = { id, x2: box[0], y2: box[1], x1: box[2], y1: box[3], kind, ...colorAttr(g) };
    } else if (g.attrs.GraphicType === 'Line' && box.length === 4) {
      // 矢頭の無い線（表の罫線など）
      const id = newId(d, 'r');
      d.arrows[id] = { id, x2: box[0], y2: box[1], x1: box[2], y1: box[3], kind: 'line', ...colorAttr(g) };
    } else if ((g.attrs.GraphicType === 'Rectangle' || g.attrs.GraphicType === 'Oval' || g.attrs.GraphicType === 'Bracket') && box.length === 4) {
      let x1 = Math.min(box[0], box[2]);
      let y1 = Math.min(box[1], box[3]);
      let x2 = Math.max(box[0], box[2]);
      let y2 = Math.max(box[1], box[3]);
      // 楕円は中心と軸の端から決める（ChemDraw の BoundingBox は線の太さを含むことがある）
      const c = nums(g.attrs.Center3D);
      const ma = nums(g.attrs.MajorAxisEnd3D);
      const mi = nums(g.attrs.MinorAxisEnd3D);
      if (g.attrs.GraphicType === 'Oval' && c.length >= 2 && ma.length >= 2 && mi.length >= 2) {
        const rx = Math.hypot(ma[0] - c[0], ma[1] - c[1]);
        const ry = Math.hypot(mi[0] - c[0], mi[1] - c[1]);
        [x1, y1, x2, y2] = [c[0] - rx, c[1] - ry, c[0] + rx, c[1] + ry];
      }
      const bt = g.attrs.BracketType ?? '';
      const kind: ShapeKind = g.attrs.GraphicType === 'Rectangle' ? 'rect' : g.attrs.GraphicType === 'Oval' ? 'oval' : /Round/.test(bt) ? 'bracket-round' : /Curly/.test(bt) ? 'bracket-curly' : 'bracket-square';
      d.shapes ??= {};
      const id = newId(d, 'h');
      d.shapes[id] = { id, kind, x1, y1, x2, y2, ...colorAttr(g) };
    } else if (g.attrs.GraphicType === 'Symbol' && g.attrs.SymbolType === 'LonePair') {
      // いちばん近い原子のローンペアとして読む
      const c = { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 };
      const near = Object.values(d.atoms).map((a) => ({ a, r: Math.hypot(a.x - c.x, a.y - c.y) })).sort((p, q) => p.r - q.r)[0];
      if (near && near.r < 14) near.a.lonePairs = Math.min(3, (near.a.lonePairs ?? 0) + 1);
    } else if (g.attrs.GraphicType === 'Symbol' && g.attrs.SymbolType === 'Plus') {
      const c = { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 };
      // 原子のすぐ近くの＋は電荷の記号なので読まない
      if (Object.values(d.atoms).some((a) => Math.hypot(a.x - c.x, a.y - c.y) < 9)) return;
      const id = newId(d, 'p');
      d.pluses[id] = { id, x: c.x, y: c.y, ...colorAttr(g) };
    }
  }

  function readArrow(a: XmlNode) {
    const head = nums(a.attrs.Head3D);
    const tail = nums(a.attrs.Tail3D);
    if (head.length < 2 || tail.length < 2) return;
    const h = a.attrs.ArrowheadHead ?? '';
    const t = a.attrs.ArrowheadTail ?? '';
    let kind: ArrowKind = 'normal';
    const center = nums(a.attrs.Center3D);
    const sweep = parseFloat(a.attrs.AngularSize ?? '');
    if (center.length >= 2 && Number.isFinite(sweep) && Math.abs(sweep) > 0.5) kind = 'curved';
    else if (/Half/.test(h) && /Half/.test(t)) kind = 'equilibrium';
    else if (h === 'Full' && t === 'Full') kind = 'resonance';
    else if (a.attrs.ArrowheadType === 'Hollow' || a.attrs.ArrowheadType === 'Angle' && a.attrs.ArrowShaftSpacing) kind = 'retro';
    const id = newId(d, 'r');
    d.arrows[id] = { id, x1: tail[0], y1: tail[1], x2: head[0], y2: head[1], kind, ...colorAttr(a) };
    if (kind === 'curved') {
      Object.assign(d.arrows[id], controlFromArc(center, tail, head, sweep));
      if (/Half/.test(h)) d.arrows[id].half = true;
    }
    if (/Dashed/.test(a.attrs.LineType ?? '')) d.arrows[id].dashed = true;
    if (a.attrs.NoGo === 'Cross' || a.attrs.NoGo === 'Hash') d.arrows[id].noGo = true;
  }

  visit(cdxml, false);
  return normalizeScale(d);
}

/** 結合長が ACS の長さと違う文書（ChemDraw の既定は 30pt など）を、14.4pt にそろえる */
function normalizeScale(d: Doc): Doc {
  const lens = Object.values(d.bonds).map((b) => Math.hypot(d.atoms[b.a1].x - d.atoms[b.a2].x, d.atoms[b.a1].y - d.atoms[b.a2].y)).sort((a, b) => a - b);
  if (!lens.length) return d;
  const median = lens[Math.floor(lens.length / 2)];
  if (median < 1e-6 || Math.abs(median - BOND_LEN) / BOND_LEN < 0.05) return d;
  const k = BOND_LEN / median;
  for (const a of Object.values(d.atoms)) Object.assign(a, { x: a.x * k, y: a.y * k });
  for (const r of Object.values(d.arrows)) {
    Object.assign(r, { x1: r.x1 * k, y1: r.y1 * k, x2: r.x2 * k, y2: r.y2 * k });
    if (r.cx !== undefined && r.cy !== undefined) Object.assign(r, { cx: r.cx * k, cy: r.cy * k });
  }
  for (const t of Object.values(d.texts)) Object.assign(t, { x: t.x * k, y: t.y * k });
  for (const p of Object.values(d.pluses)) Object.assign(p, { x: p.x * k, y: p.y * k });
  for (const s of Object.values(d.shapes ?? {})) Object.assign(s, { x1: s.x1 * k, y1: s.y1 * k, x2: s.x2 * k, y2: s.y2 * k });
  return d;
}

// 反応スキームの図形（矢印・文字・＋記号）の追加と変更
import type { P } from './geometry';
import type { Arrow, ArrowKind, Doc } from './model';
import { edit, newId } from './model';

/** 矢印の種類のほかの印（点線・進まない・曲がり具合・片側の頭） */
export type ArrowExtra = Partial<Pick<Arrow, 'dashed' | 'noGo' | 'cx' | 'cy' | 'half'>>;

export function addArrow(doc: Doc, tail: P, head: P, kind: ArrowKind, extra: ArrowExtra = {}): Doc {
  return edit(doc, (d) => {
    const id = newId(d, 'r');
    d.arrows[id] = { id, x1: tail.x, y1: tail.y, x2: head.x, y2: head.y, kind, ...extra };
  });
}

/** 矢印の種類を変える。点線・進まないの印は、指定が無ければ外す */
export function setArrowKind(doc: Doc, id: string, kind: ArrowKind, extra: Pick<ArrowExtra, 'dashed' | 'noGo'> = {}): Doc {
  return edit(doc, (d) => {
    const r = d.arrows[id];
    r.kind = kind;
    delete r.dashed;
    delete r.noGo;
    Object.assign(r, extra);
    if (kind !== 'curved') {
      delete r.cx;
      delete r.cy;
      delete r.half;
    }
  });
}

export function addPlus(doc: Doc, p: P): Doc {
  return edit(doc, (d) => {
    const id = newId(d, 'p');
    d.pluses[id] = { id, x: p.x, y: p.y };
  });
}

/** 文字を足す・変える。空にすると消す */
/** 文字を足す・直す。formula を渡すと、化学式の書き方（英字のあとの数字を下付き）を入れる・外す */
export function setText(doc: Doc, id: string | null, at: P, text: string, formula?: boolean): Doc {
  return edit(doc, (d) => {
    if (id && d.texts[id]) {
      if (!text.trim()) return void delete d.texts[id];
      d.texts[id].text = text;
      if (formula !== undefined) {
        if (formula) d.texts[id].formula = true;
        else delete d.texts[id].formula;
      }
      return;
    }
    if (!text.trim()) return;
    const nid = newId(d, 't');
    d.texts[nid] = { id: nid, x: at.x, y: at.y, text, ...(formula ? { formula: true } : {}) };
  });
}

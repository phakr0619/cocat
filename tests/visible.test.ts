import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { countOutside } from '../src/editor/visible';
import { importText } from '../src/io/convert';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

describe('表示の外にある物を数える', () => {
  it('分子は 1 つと数え、少しでも表示に入っていれば外とみなさない', () => {
    let { doc } = importText(emptyDoc(), 'CCO');
    const xs = Object.values(doc.atoms).map((a) => a.x);
    const ys = Object.values(doc.atoms).map((a) => a.y);
    const box = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    expect(countOutside(doc, box)).toBe(0);
    // 遠くへ離した 2 つ目の分子
    const far = importText(doc, 'c1ccccc1');
    doc = far.doc;
    for (const id of far.ids) if (doc.atoms[id]) doc.atoms[id] = { ...doc.atoms[id], x: doc.atoms[id].x + 5000 };
    expect(countOutside(doc, box)).toBe(1);
    // 端の原子だけが入っていても、外とはみなさない
    expect(countOutside(doc, { ...box, x2: box.x1 })).toBe(1);
  });
});

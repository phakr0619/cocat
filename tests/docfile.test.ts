import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { parseDocFile, serializeDoc } from '../src/io/docfile';
import { canonical, documentSmiles } from '../src/io/smiles';
import { loadRDKit } from './rdkit';
import { reactionDoc } from './samples';
import { bondAtPoint, setAbbr } from '../src/chem/ops';
import { expandAbbr } from '../src/chem/abbrOps';

beforeAll(loadRDKit);

describe('文書の保存形式', () => {
  it('保存して開き直すと、反応スキーム・文字・略号を含めて同じ文書になる', () => {
    let d = reactionDoc();
    d = bondAtPoint(d, { x: 600, y: 100 }, 'single');
    const ids = Object.keys(d.atoms);
    d = setAbbr(d, ids.at(-1)!, 'Ph');
    d = expandAbbr(d, ids.at(-1)!);
    const back = parseDocFile(serializeDoc(d));
    expect(back).toEqual(d);
    expect(documentSmiles(back).smiles).toBe(documentSmiles(d).smiles);
    expect(canonical('c1ccccc1')).toBe('c1ccccc1');
  });

  it('ほかの JSON や新しい版は、理由を添えて断る', () => {
    expect(() => parseDocFile('{"a":1}')).toThrow('ai-chem-editor の文書ではありません');
    expect(() => parseDocFile('not json')).toThrow('JSON');
    const newer = JSON.stringify({ format: 'ai-chem-editor', version: 99, doc: emptyDoc() });
    expect(() => parseDocFile(newer)).toThrow('新しい版');
  });

  it('nextId が無い文書は、使われている id から補う', () => {
    const d = bondAtPoint(emptyDoc(), { x: 0, y: 0 }, 'single');
    const raw = JSON.parse(serializeDoc(d));
    delete raw.doc.nextId;
    expect(parseDocFile(JSON.stringify(raw)).nextId).toBe(d.nextId);
  });
});

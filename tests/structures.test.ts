import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/chem/model';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { exportMol, exportSvg, importText } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import { cleanStructure } from '../src/chem/clean';
import { loadRDKit } from './rdkit';
import { STRUCTURES } from './structures';

beforeAll(() => {
  mkdirSync('out/structures', { recursive: true });
  return loadRDKit();
});

describe.each(Object.entries(STRUCTURES))('%s', (name, smiles) => {
  it('エディタの構造 → SMILES・MOL・CDXML で同じ構造に戻る', () => {
    const expected = canonical(smiles)!;
    expect(expected).toBeTruthy();
    const doc = importText(emptyDoc(), smiles).doc;
    expect(canonical(docToSmiles(doc).smiles!)).toBe(expected);
    expect(canonical(docToSmiles(importText(emptyDoc(), exportMol(doc)).doc).smiles!)).toBe(expected);
    const cdxml = writeCdxml(doc);
    expect(canonical(docToSmiles(readCdxml(cdxml)).smiles!)).toBe(expected);
    // Clean Structure をかけても構造（立体を含む）は変わらない
    const cleaned = cleanStructure(doc, new Set()).doc;
    expect(canonical(docToSmiles(cleaned).smiles!)).toBe(expected);
    writeFileSync(`out/structures/${name}.cdxml`, cdxml);
    writeFileSync(`out/structures/${name}.svg`, exportSvg(doc));
    writeFileSync(`out/structures/${name}.expected.smi`, expected + '\n');
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { analyzeFragment } from '../src/chem/analysis';
import { getAbbr, resolveAbbr, setUserAbbrs } from '../src/chem/abbreviations';
import { expandAbbr } from '../src/chem/abbrOps';
import { parseLabel } from '../src/chem/label';
import { adjacency, emptyDoc, molecules, type Doc } from '../src/chem/model';
import { setAbbr } from '../src/chem/ops';
import { cdxmlToCdx, cdxToCdxml } from '../src/io/cdx';
import { readCdxml, writeCdxml } from '../src/io/cdxml';
import { importText } from '../src/io/convert';
import { canonical, docToSmiles } from '../src/io/smiles';
import { atomLabel } from '../src/render/labels';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);
afterEach(() => setUserAbbrs({}));

/** ベンゼンの CH3 の所に、ラベルを付けた分子 */
function benzeneWith(label: string): { doc: Doc; id: string } {
  let d = importText(emptyDoc(), 'Cc1ccccc1').doc;
  const me = Object.values(d.atoms).find((a) => !Object.values(d.bonds).some((b) => (b.a1 === a.id || b.a2 === a.id) && b.order === 2) && Object.values(d.bonds).filter((b) => b.a1 === a.id || b.a2 === a.id).length === 1)!;
  const p = parseLabel(label);
  if (p?.kind !== 'abbr') throw new Error(`略号として読めない: ${label} → ${JSON.stringify(p)}`);
  d = setAbbr(d, me.id, p.abbr);
  return { doc: d, id: me.id };
}
const smi = (d: Doc) => canonical(docToSmiles(d).smiles!);

describe('ラベルの書き方を、描く所・書き出し・読み込みで使う', () => {
  const CASES: [string, string][] = [
    ['NHFmoc', 'O=C(Nc1ccccc1)OCC1c2ccccc2-c2ccccc21'],
    ['CO2tBu', 'CC(C)(C)OC(=O)c1ccccc1'],
    ['CH2OH', 'OCc1ccccc1'],
    ['BF3K', 'F[B-](F)(F)c1ccccc1.[K+]'],
    ['SO2Ph', 'O=S(=O)(c1ccccc1)c1ccccc1'],
  ];
  for (const [label, want] of CASES) {
    it(`${label}: SMILES・CDXML・CDX に構造が入り、読み戻せる`, () => {
      const { doc } = benzeneWith(label);
      expect(smi(doc)).toBe(canonical(want));
      const x = writeCdxml(doc);
      expect(x).toContain('NodeType="Fragment"');
      expect(smi(readCdxml(x))).toBe(canonical(want));
      expect(smi(readCdxml(cdxToCdxml(cdxmlToCdx(x))))).toBe(canonical(want));
      // ChemDraw の部品（RDKit）と Indigo で読めるかを verify:cdxml で確かめる
      mkdirSync('out/abbr-labels', { recursive: true });
      writeFileSync(`out/abbr-labels/${label}.cdxml`, x);
      writeFileSync(`out/abbr-labels/${label}.expected.smi`, `${canonical(want)}\n`);
    });
  }

  it('図のラベルは書いたとおり。左向きでは並べ直す（FmocHN）', () => {
    const { doc, id } = benzeneWith('NHFmoc');
    const text = atomLabel(doc.atoms[id], doc, adjacency(doc))!.runs.map((r) => r.text).join('');
    expect(['NHFmoc', 'FmocHN']).toContain(text);
    expect(getAbbr('NHFmoc')).toMatchObject({ label: 'NHFmoc', reversed: 'FmocHN' });
    // 左向きで入れたものは、右向きの名前で持つ
    expect(resolveAbbr('HOH2C')).toBe('CH2OH');
  });

  it('元素のラベル（OH・NH2・Cl）は今までどおり元素で読む', () => {
    for (const t of ['OH', 'NH2', 'Cl', 'H2N', 'SH']) expect(parseLabel(t)?.kind, t).toBe('element');
  });

  it('BF3K は、展開すると K⁺ も同じまとまり（塩）になり、分析は塩全体', () => {
    const { doc, id } = benzeneWith('BF3K');
    const ex = expandAbbr(doc, id);
    expect(molecules(ex)).toHaveLength(1);
    const a = analyzeFragment(doc, molecules(doc)[0]);
    if ('error' in a) throw new Error(a.error);
    expect(a.formula).toBe('C6H5BF3K');
    expect(a.saltFormula).toBe('C6H5BF3−·K+');
  });

  it('利用者の辞書の略号を使え、ほかの書き方の部品にもなる（ONap）', () => {
    expect(parseLabel('Nap')).toBeNull();
    setUserAbbrs({ Nap: '*c1ccc2ccccc2c1' });
    expect(parseLabel('Nap')).toEqual({ kind: 'abbr', abbr: 'Nap' });
    const { doc } = benzeneWith('ONap');
    expect(smi(doc)).toBe(canonical('c1ccc(Oc2ccc3ccccc3c2)cc1'));
  });
});

import { valenceErrors } from '../src/chem/hydrogens';
import { labelReportText } from '../src/io/convert';
import type { LabelReport } from '../src/io/cdxml';

/** ChemDraw が構造を埋め込まずに保存したラベル（ベンゼンに付いた 1 つのノードに、文字だけがある） */
function labelOnly(attrs: string, text: string): string {
  return `<?xml version="1.0"?><CDXML><page id="1"><fragment id="2">
<n id="3" p="0 0"/><n id="4" p="12 7"/><n id="5" p="12 21"/><n id="6" p="0 28"/><n id="7" p="-12 21"/><n id="8" p="-12 7"/>
<n id="9" p="0 -14" ${attrs}><t p="0 -14"><s font="3" size="10">${text}</s></t></n>
<b id="10" B="3" E="4" Order="2"/><b id="11" B="4" E="5"/><b id="12" B="5" E="6" Order="2"/><b id="13" B="6" E="7"/><b id="14" B="7" E="8" Order="2"/><b id="15" B="8" E="3"/><b id="16" B="3" E="9"/>
</fragment></page></CDXML>`;
}

describe('ChemDraw のファイルで構造の抜けたラベルを補う', () => {
  // ほかのソフト（RDKit）は、このようなノードを黙ってメチル基（トルエン）として読む
  const FORMS = ['NodeType="Unspecified"', 'NodeType="Nickname"', 'NodeType="Formula"', 'Element="5"', ''];
  const FIX: [string, string][] = [
    ['BF3K', 'F[B-](F)(F)c1ccccc1.[K+]'],
    ['NHFmoc', 'O=C(Nc1ccccc1)OCC1c2ccccc2-c2ccccc21'],
    ['OTBS', 'CC(C)(C)[Si](C)(C)Oc1ccccc1'],
    ['CH2OH', 'OCc1ccccc1'],
    ['HOH2C', 'OCc1ccccc1'],
  ];
  for (const form of FORMS) {
    for (const [label, want] of FIX) {
      it(`${form || '（属性なし）'} ${label} → 補う`, () => {
        const r: LabelReport = { repaired: [], unreadable: [] };
        const d = readCdxml(labelOnly(form, label), r);
        expect(smi(d)).toBe(canonical(want));
        expect(r.repaired).toEqual([label]);
        expect(valenceErrors(d).size).toBe(0);
      });
    }
  }

  it('ラベルと中身が合っているもの（O の OH、C の CH3・Me）はそのまま。知らせない', () => {
    for (const [attrs, text, want] of [
      ['Element="8"', 'OH', 'Oc1ccccc1'],
      ['', 'CH3', 'Cc1ccccc1'],
      ['', 'Me', 'Cc1ccccc1'],
      ['Element="7"', 'NH2', 'Nc1ccccc1'],
    ] as const) {
      const r: LabelReport = { repaired: [], unreadable: [] };
      expect(smi(readCdxml(labelOnly(attrs, text), r)), text).toBe(canonical(want));
      expect(r, text).toEqual({ repaired: [], unreadable: [] });
    }
  });

  it('読めないラベルは炭素にせず、構造の分からない置換基として赤い枠で示し、知らせる', () => {
    const r: LabelReport = { repaired: [], unreadable: [] };
    const d = readCdxml(labelOnly('NodeType="Unspecified"', 'Xyz9'), r);
    const x = Object.values(d.atoms).find((a) => a.abbr === 'Xyz9')!;
    expect(x.element).toBe('*');
    expect(valenceErrors(d).has(x.id)).toBe(true);
    expect(r.unreadable).toEqual(['Xyz9']);
    expect(labelReportText(r)).toContain('Xyz9');
    // 置換基の記号（R1）は構造が無いのが正しいので、赤い枠にしない
    const rr: LabelReport = { repaired: [], unreadable: [] };
    expect(valenceErrors(readCdxml(labelOnly('', 'R1'), rr)).size).toBe(0);
    expect(rr.unreadable).toEqual([]);
  });

  it('ChemDraw が中身の構造を埋め込んだ略号は、今までどおり中身を使う', () => {
    // このエディタの書き出し（Fragment ノード）を読み直す
    const { doc } = benzeneWith('NHFmoc');
    const r: LabelReport = { repaired: [], unreadable: [] };
    expect(smi(readCdxml(writeCdxml(doc), r))).toBe(canonical('O=C(Nc1ccccc1)OCC1c2ccccc2-c2ccccc21'));
    expect(r.repaired).toEqual([]);
  });
});

import { vi } from 'vitest';
import { addUserAbbr, applyAbbrs, nameProblem, normalizeAbbrSmiles, removeUserAbbr, setDocAbbrs, withUsedAbbrDefs } from '../src/ui/abbrStore';

describe('略号の辞書（利用者の辞書）', () => {
  beforeAll(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  });

  it('SMILES は * がちょうど 1 つで、* から始まる形にする', () => {
    expect(normalizeAbbrSmiles('OCC*')).toEqual({ smiles: '*CCO' });
    // 2-ナフチルを * の位置を変えて書いても、* から始まる同じ構造になる
    const nap = normalizeAbbrSmiles('c1ccc2cc(*)ccc2c1') as { smiles: string };
    expect(nap.smiles.startsWith('*')).toBe(true);
    expect(canonical(nap.smiles)).toBe(canonical('*c1ccc2ccccc2c1'));
    expect(normalizeAbbrSmiles('c1ccccc1')).toHaveProperty('error');
    expect(normalizeAbbrSmiles('*CC*')).toHaveProperty('error');
    expect(normalizeAbbrSmiles('C(((')).toHaveProperty('error');
  });

  it('名前: 元素記号・標準の略号・空白は使えない', () => {
    expect(nameProblem('Nap')).toBeNull();
    expect(nameProblem('Cl')).toContain('元素記号');
    expect(nameProblem('Boc')).toContain('標準');
    expect(nameProblem('a b')).toContain('空白');
  });

  it('足すと使え、使った略号は文書に写り、別の PC（利用者の辞書が空）でも文書の辞書で読める', () => {
    addUserAbbr('Nap', '*c1ccc2ccccc2c1');
    const { doc } = benzeneWith('Nap');
    const withDefs = withUsedAbbrDefs(doc);
    expect(withDefs.abbrDefs).toEqual({ Nap: '*c1ccc2ccccc2c1' });
    removeUserAbbr('Nap');
    expect(getAbbr('Nap')).toBeUndefined();
    setDocAbbrs(withDefs.abbrDefs);
    expect(smi(withDefs)).toBe(canonical('c1ccc(-c2ccc3ccccc3c2)cc1'));
    setDocAbbrs(undefined);
    applyAbbrs();
  });
});

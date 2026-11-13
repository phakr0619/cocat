import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkCasNumber } from '../src/chem/casNumber';
import { commonNameEntries, lookupCommonName, normalizeName } from '../src/chem/commonNames';
import { canonical } from '../src/io/smiles';
import { checkNameAnswer, checkNameShape, formulaCounts, formulaOfSmiles, nameToStructure, namePrompt, resolveLocally } from '../src/llm/nameToStructure';
import { cipOf } from '../src/llm/textToScheme';
import type { LlmProvider } from '../src/llm/types';
import type { LibraryCompound } from '../src/project/model';
import { loadRDKit } from './rdkit';

beforeAll(loadRDKit);

/** 辞書の SMILES を手で書いたので、組成式を別に書いて照らす（書き違いを見つけるため） */
const FORMULAS: Record<string, string> = {
  water: 'H2O', methanol: 'CH4O', ethanol: 'C2H6O', isopropanol: 'C3H8O', acetone: 'C3H6O', acetonitrile: 'C2H3N',
  dichloromethane: 'CH2Cl2', chloroform: 'CHCl3', tetrahydrofuran: 'C4H8O', 'diethyl ether': 'C4H10O', '1,4-dioxane': 'C4H8O2',
  'ethyl acetate': 'C4H8O2', 'acetic acid': 'C2H4O2', 'acetic anhydride': 'C4H6O3', 'n,n-dimethylformamide': 'C3H7NO',
  'dimethyl sulfoxide': 'C2H6OS', 'n-methyl-2-pyrrolidone': 'C5H9NO', hexane: 'C6H14', cyclohexane: 'C6H12', benzene: 'C6H6',
  toluene: 'C7H8', styrene: 'C8H8', naphthalene: 'C10H8', phenol: 'C6H6O', anisole: 'C7H8O', aniline: 'C6H7N',
  'benzyl alcohol': 'C7H8O', benzaldehyde: 'C7H6O', 'benzoic acid': 'C7H6O2', acetophenone: 'C8H8O', nitrobenzene: 'C6H5NO2',
  pyridine: 'C5H5N', pyrrole: 'C4H5N', furan: 'C4H4O', thiophene: 'C4H4S', imidazole: 'C3H4N2', indole: 'C8H7N',
  piperidine: 'C5H11N', morpholine: 'C4H9NO', triethylamine: 'C6H15N', 'n,n-diisopropylethylamine': 'C8H19N',
  '4-dimethylaminopyridine': 'C7H10N2', 'trifluoroacetic acid': 'C2HF3O2', 'di-tert-butyl dicarbonate': 'C10H18O5',
  triphenylphosphine: 'C18H15P', glycine: 'C2H5NO2', 'l-alanine': 'C3H7NO2', aspirin: 'C9H8O4', caffeine: 'C8H10N4O2',
};

describe('手元の辞書', () => {
  it('どの SMILES も RDKit で読め、組成式が別に書いたものと合う', () => {
    for (const [smiles, first] of commonNameEntries()) {
      expect(canonical(smiles), first).not.toBeNull();
      expect(formulaOfSmiles(smiles), first).toBe(FORMULAS[normalizeName(first)]);
    }
    expect(Object.keys(FORMULAS)).toHaveLength(commonNameEntries().length);
  });

  it('L-アラニンは S', () => {
    expect(cipOf(lookupCommonName('L-alanine')!)).toEqual({ R: 0, S: 1 });
  });

  it('大文字・小文字・空白・全角・ダッシュの違いは同じ名前として引く', () => {
    expect(lookupCommonName('  Ethyl   Acetate ')).toBe('CCOC(C)=O');
    expect(lookupCommonName('ＴＨＦ')).toBe('C1CCOC1');
    expect(lookupCommonName('di‐tert‐butyl dicarbonate')).toBe(lookupCommonName('Boc2O'));
    expect(lookupCommonName('酢酸エチル')).toBe('CCOC(C)=O');
    expect(lookupCommonName('unobtainium')).toBeNull();
  });

  it('同じ名前を2つの構造に当てていない', () => {
    const seen = new Map<string, string>();
    for (const [smiles, ...names] of commonNameEntries())
      for (const n of names) {
        const k = normalizeName(n);
        expect(seen.get(k) ?? smiles, n).toBe(smiles);
        seen.set(k, smiles);
      }
  });
});

describe('送らずに引く', () => {
  const lib = [{ id: 'l1', smiles: 'CC(=O)NCc1ccccc1', number: '12a', nickname: 'アミド A' } as LibraryCompound];

  it('辞書 → ライブラリ（番号・呼び名）→ SMILES の順', () => {
    expect(resolveLocally('toluene', lib)).toEqual({ source: 'dictionary', smiles: 'Cc1ccccc1' });
    expect(resolveLocally('12A', lib)).toEqual({ source: 'library', smiles: 'CC(=O)NCc1ccccc1', label: '12a' });
    expect(resolveLocally('アミド a', lib)).toMatchObject({ source: 'library' });
    expect(resolveLocally('CC(=O)Cl', lib)).toEqual({ source: 'smiles', smiles: 'CC(=O)Cl' });
  });

  it('SMILES と読めない名前・空白を含む名前・空は null（LLM に回す）', () => {
    expect(resolveLocally('2-methylpentan-3-one')).toBeNull();
    expect(resolveLocally('sodium chloride')).toBeNull();
    expect(resolveLocally('   ')).toBeNull();
  });
});

describe('LLM の答えを確かめる', () => {
  it('形: オブジェクトで、項目は文字', () => {
    expect(checkNameShape({ smiles: 'CCO', formula: 'C2H6O' })).toEqual({ value: { smiles: 'CCO', formula: 'C2H6O', note: undefined } });
    expect(checkNameShape([])).toHaveProperty('error');
    expect(checkNameShape({ smiles: 3 })).toHaveProperty('error');
  });

  it('組成式を数にする', () => {
    expect(formulaCounts('C3H7NO2')).toEqual(new Map([['C', 3], ['H', 7], ['N', 1], ['O', 2]]));
    expect(formulaCounts('C3H7-NO2')).toBeNull();
  });

  it('合っていれば気づいたことは無い', () => {
    expect(checkNameAnswer('(S)-2-aminopropanoic acid', { smiles: 'C[C@H](N)C(=O)O', formula: 'C3H7NO2' })).toEqual({ smiles: 'C[C@H](N)C(=O)O', formula: 'C3H7NO2', warnings: [] });
  });

  it('組成式の食い違いと、名前の立体との食い違いを知らせる', () => {
    const r = checkNameAnswer('(R)-2-aminopropanoic acid', { smiles: 'C[C@H](N)C(=O)O', formula: 'C3H9NO2' });
    expect(r).toHaveProperty('warnings');
    const w = (r as { warnings: string[] }).warnings;
    expect(w[0]).toContain('C3H9NO2');
    expect(w[1]).toBe('名前の立体（R）と、構造の立体（S）が違います');
  });

  it('SMILES が無い・読めないなら置かない', () => {
    expect(checkNameAnswer('compound 3', { note: '社内のコード名です' })).toEqual({ error: '構造を決められませんでした: 社内のコード名です' });
    expect(checkNameAnswer('x', { smiles: 'C1CC' })).toHaveProperty('error');
  });
});

describe('まとめて呼ぶ', () => {
  const fake = (...answers: unknown[]): LlmProvider & { calls: { system: string; user: string }[] } => {
    const calls: { system: string; user: string }[] = [];
    return {
      id: 'gemini',
      calls,
      generateJson: vi.fn(async (req: { system: string; user: string }) => {
        calls.push(req);
        return { ok: true as const, value: answers.shift() as never };
      }),
      listModels: vi.fn(),
    };
  };

  it('送るのは名前だけ。形が崩れていれば1回だけ直させる', async () => {
    const llm = fake({ smiles: 5 }, { smiles: 'CC(=O)CC(C)C', formula: 'C6H12O' });
    const r = await nameToStructure(llm, { name: '4-methylpentan-2-one' });
    expect(r).toMatchObject({ ok: true, smiles: 'CC(=O)CC(C)C', formula: 'C6H12O', warnings: [] });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].user).toBe(namePrompt('4-methylpentan-2-one'));
    expect(llm.calls[0].user).toBe('NAME: 4-methylpentan-2-one');
  });

  it('構造を決められなければ unresolved', async () => {
    const r = await nameToStructure(fake({ note: '化合物番号だけでは決められません' }), { name: '3' });
    expect(r).toMatchObject({ ok: false, error: { kind: 'unresolved', message: '構造を決められませんでした: 化合物番号だけでは決められません' } });
  });
});

describe('CAS 番号の形と検査数字', () => {
  it('正しい番号は ok（先頭の 0 と全角・ダッシュはそろえる）', () => {
    expect(checkCasNumber('50-00-0')).toEqual({ ok: true, cas: '50-00-0' });
    expect(checkCasNumber('7732-18-5')).toEqual({ ok: true, cas: '7732-18-5' });
    expect(checkCasNumber(' ７７３２−１８−５ ')).toEqual({ ok: true, cas: '7732-18-5' });
    expect(checkCasNumber('0050-00-0')).toEqual({ ok: true, cas: '50-00-0' });
  });

  it('検査数字が違えば、正しい数字を返す', () => {
    expect(checkCasNumber('7732-18-4')).toEqual({ ok: false, cas: '7732-18-4', expected: 5 });
  });

  it('形でなければ null（化合物番号・SMILES・名前は CAS として扱わない）', () => {
    for (const t of ['12a', '50000', '5-00-0', '12345678-00-0', '50-0-0', 'CCO', 'ethanol']) expect(checkCasNumber(t), t).toBeNull();
  });
});

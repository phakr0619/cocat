import { describe, expect, it } from 'vitest';
import { baseNameOf, fileNameFor } from '../src/io/filename';

describe('書き出すファイルの名前', () => {
  it('付けた名前に形式の拡張子を足す。名前が無ければ structure', () => {
    expect(fileNameFor('アスピリン', '.cdx')).toBe('アスピリン.cdx');
    expect(fileNameFor('', '.cdxml')).toBe('structure.cdxml');
    expect(fileNameFor(undefined, '.png')).toBe('structure.png');
    expect(fileNameFor('   ', '.mol')).toBe('structure.mol');
  });

  it('使えない文字を外し、付けたままの拡張子は二重にしない', () => {
    expect(fileNameFor('Boc-Ala/Gly: 2段目?', '.cdxml')).toBe('Boc-AlaGly 2段目.cdxml');
    expect(fileNameFor('aspirin.cdxml', '.cdxml')).toBe('aspirin.cdxml');
    expect(fileNameFor('aspirin.CDX', '.svg')).toBe('aspirin.svg');
    expect(fileNameFor('..', '.mol')).toBe('structure.mol');
    // 拡張子に見えない点は残す
    expect(fileNameFor('compound 1.2', '.mol')).toBe('compound 1.2.mol');
  });

  it('開いたファイルの名前から拡張子とフォルダを外す', () => {
    expect(baseNameOf('C:\\data\\taxol.cdxml')).toBe('taxol');
    expect(baseNameOf('scheme.v2.acedoc')).toBe('scheme.v2');
    expect(baseNameOf('.hidden')).toBe('.hidden');
  });
});

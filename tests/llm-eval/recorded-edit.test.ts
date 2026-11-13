// 本物の Gemini の編集の答えを記録したもの（npm run eval:llm-edit を RECORD=1 で回したとき）を流し直し、採点が変わらないかを確かめる
import { beforeAll, describe, expect, it } from 'vitest';
import { textEdit } from '../../src/llm/textEdit';
import { loadRDKit } from '../rdkit';
import { EDIT_CASES, editBase, scoreEdit } from './edit-score';
import { changedOutcomes, recordedFiles, replayLlm } from './replay';

beforeAll(loadRDKit);

const files = recordedFiles('tests/llm-eval/recorded-edit');

describe.skipIf(!files.length)('記録した本物の編集の答えの採点が変わらない', () => {
  it.each(files)('$file', async (rec) => {
    const changed = await changedOutcomes(rec, async (id, answers) => {
      const c = EDIT_CASES.find((x) => x.id === id);
      if (!c) return undefined;
      const base = editBase(c);
      const r = await textEdit(replayLlm(answers), { doc: base.doc, schemeId: base.schemeId, text: c.text, selected: base.selected });
      return scoreEdit(c, base, r).outcome;
    });
    expect(changed).toEqual([]);
  });
});

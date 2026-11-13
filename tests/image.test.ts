import { describe, expect, it } from 'vitest';
import { fitSize, imageFileError, imageSummary, MAX_IMAGE_SIDE } from '../src/llm/image';

describe('送る画像の用意', () => {
  it('送れる形式と大きさを確かめる', () => {
    expect(imageFileError({ type: 'image/png', size: 1000 })).toBeNull();
    expect(imageFileError({ type: 'image/heic', size: 1000 })).toBeNull();
    expect(imageFileError({ type: 'image/gif', size: 1000 })).toContain('PNG');
    expect(imageFileError({ type: 'application/pdf', size: 1000 })).toContain('PNG');
    expect(imageFileError({ type: 'image/jpeg', size: 21 * 1024 * 1024 })).toContain('20 MB');
  });

  it('長辺が上限を超えるときだけ、比を保って縮める', () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(4096, 1024)).toEqual({ width: MAX_IMAGE_SIDE, height: 512 });
    expect(fitSize(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
  });

  it('送る内容の説明に、名前・形式・大きさを出す（中身は出さない）', () => {
    const s = imageSummary({ name: 'a.png', mimeType: 'image/png', data: 'xxxx', width: 640, height: 480, bytes: 2048 });
    expect(s).toBe('IMAGE: a.png（image/png、640×480 px、2 KB）');
  });
});

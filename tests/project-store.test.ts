import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../src/project/storage';
import { ProjectStore } from '../src/project/store';

describe('プロジェクトの状態（ProjectStore）', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  // React の StrictMode（開発のとき）は useEffect を 2 回動かすので、init が重ねて呼ばれる。
  // 重なっても「マイプロジェクト」は 1 つだけ作り、画面のプロジェクトと次に開くプロジェクトを同じにする
  it('init を重ねて呼んでも、はじめのプロジェクトは 1 つで、開き直すと同じものを開く', async () => {
    const storage = new MemoryStorage();
    const a = new ProjectStore(storage);
    await Promise.all([a.init(), a.init()]);
    expect(await storage.list()).toHaveLength(1);
    const shown = a.get().project!.id;
    const reopened = new ProjectStore(storage);
    await reopened.init();
    expect(reopened.get().project!.id).toBe(shown);
  });

  // 変更を 0.3 秒待ってから書いていたので、その間にページを開き直すと消えた（閉じるときの書き込みは、ページが消えると途中で切られる）。
  // プロジェクトの変更はボタン・欄を離れたときなどの一回ずつの操作なので、すぐ書き始める（CI の library.spec.ts で、検討表が消えていた）
  it('変更すると、すぐ（次の一巡で）保存先に書く。続けて変えても最後の状態を書く', async () => {
    const storage = new MemoryStorage();
    const a = new ProjectStore(storage);
    await a.init();
    const p = a.get().project!;
    a.update({ ...p, name: '一つ目' });
    a.update({ ...p, name: '二つ目' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await storage.get(p.id))!.name).toBe('二つ目');
  });
});

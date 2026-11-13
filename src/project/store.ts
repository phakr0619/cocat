// 開いているプロジェクトの状態。変更はすぐ（同じ一巡の変更をまとめて）保存先（IndexedDB）へ書く
import { useSyncExternalStore } from 'react';
import { newProject, type Project, type ProjectSummary } from './model';
import { defaultStorage, type ProjectStorage } from './storage';

const CURRENT_KEY = 'ai-chem-editor:project';

export interface ProjectState {
  ready: boolean;
  project: Project | null;
  summaries: ProjectSummary[];
}

export class ProjectStore {
  private state: ProjectState = { ready: false, project: null, summaries: [] };
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private initializing: Promise<void> | null = null;

  constructor(private storage: ProjectStorage = defaultStorage()) {}

  get = () => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(partial: Partial<ProjectState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((l) => l());
  }

  /**
   * 前回開いていたプロジェクトを開く。無ければ「マイプロジェクト」を作る。
   * 重ねて呼んでも 1 回だけ動かす（React の StrictMode は開発のとき useEffect を 2 回動かす。
   * 2 回動くと「マイプロジェクト」が 2 つでき、画面のものと次に開くものが食い違うことがあった）
   */
  init() {
    if (!this.initializing && typeof window !== 'undefined') {
      // 書き始める前（同じ一巡の中）にページを閉じることもあるので、閉じる前にも書く
      window.addEventListener('pagehide', () => void this.flush());
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void this.flush());
    }
    this.initializing ??= this.load();
    return this.initializing;
  }

  private async load() {
    let summaries = await this.storage.list();
    let current: string | null = null;
    try {
      current = localStorage.getItem(CURRENT_KEY);
    } catch {
      // 使えない環境では最新のものを開く
    }
    let project = current ? await this.storage.get(current) : null;
    if (!project && summaries[0]) project = await this.storage.get(summaries[0].id);
    if (!project) {
      project = newProject('マイプロジェクト');
      await this.storage.put(project);
      summaries = await this.storage.list();
    }
    this.remember(project.id);
    this.emit({ ready: true, project, summaries });
  }

  private remember(id: string) {
    try {
      localStorage.setItem(CURRENT_KEY, id);
    } catch {
      // 同上
    }
  }

  /**
   * プロジェクトを変える（すぐ画面に出し、次の一巡で保存先に書く。同じ一巡の変更はまとめて、最後の状態を書く）。
   * 前は 0.3 秒待ってから書いていたが、その間にページを開き直す・閉じると消えた（閉じるときの書き込みは、ページが消えると途中で切られる。
   * CI の library.spec.ts で検討表が消えていた）。プロジェクトの変更はボタン・欄を離れたときなどの一回ずつの操作なので、待たずに書く
   */
  update(project: Project) {
    this.emit({ project });
    this.saveTimer ??= setTimeout(() => void this.flush(), 0);
  }

  async flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const p = this.state.project;
    if (!p) return;
    await this.storage.put(p);
    this.emit({ summaries: await this.storage.list() });
  }

  async open(id: string) {
    await this.flush();
    const project = await this.storage.get(id);
    if (!project) return;
    this.remember(id);
    this.emit({ project });
  }

  async create(name: string, from?: Project) {
    await this.flush();
    const project = from ?? newProject(name);
    await this.storage.put(project);
    this.remember(project.id);
    this.emit({ project, summaries: await this.storage.list() });
  }

  async remove(id: string) {
    await this.storage.remove(id);
    const summaries = await this.storage.list();
    if (this.state.project?.id === id) {
      this.emit({ project: null, summaries });
      if (summaries[0]) await this.open(summaries[0].id);
      else await this.create('マイプロジェクト');
    } else this.emit({ summaries });
  }
}

export function useProject<T>(store: ProjectStore, pick: (s: ProjectState) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}

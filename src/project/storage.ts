// プロジェクトの保存先。ブラウザでは IndexedDB、テストでは記憶の中だけ
import type { Project, ProjectSummary } from './model';
import { summarize } from './model';

export interface ProjectStorage {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<Project | null>;
  put(p: Project): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryStorage implements ProjectStorage {
  private data = new Map<string, Project>();
  async list() {
    return [...this.data.values()].map(summarize).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string) {
    const p = this.data.get(id);
    return p ? structuredClone(p) : null;
  }
  async put(p: Project) {
    this.data.set(p.id, structuredClone(p));
  }
  async remove(id: string) {
    this.data.delete(id);
  }
}

const DB_NAME = 'ai-chem-editor';
const STORE = 'projects';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          resolve(req.result);
          db.close();
        };
        tx.onerror = () => {
          reject(tx.error);
          db.close();
        };
      }),
  );
}

/** IndexedDB。構造式は PC の外に出ない */
export class IndexedDbStorage implements ProjectStorage {
  async list() {
    const all = await run<Project[]>('readonly', (s) => s.getAll() as IDBRequest<Project[]>);
    return all.map(summarize).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string) {
    return (await run<Project | undefined>('readonly', (s) => s.get(id) as IDBRequest<Project | undefined>)) ?? null;
  }
  async put(p: Project) {
    await run('readwrite', (s) => s.put(p));
  }
  async remove(id: string) {
    await run('readwrite', (s) => s.delete(id));
  }
}

/** IndexedDB が使えない環境（プライベートウィンドウなど）では、記憶の中に置く */
export function defaultStorage(): ProjectStorage {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbStorage();
  } catch {
    // 使えない
  }
  return new MemoryStorage();
}

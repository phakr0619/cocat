// 右の欄の「この文書」（何も選んでいないとき）と、空のキャンバスの入口
import type { Doc } from '../chem/model';
import { Thumb } from './LibraryPanel';
import { Menu } from './Menu';
import { runLabel } from '../process/ops';

/** 文書の中の分子の数（つながった原子のまとまり） */
function moleculeCount(doc: Doc): number {
  const free = Object.values(doc.atoms);
  const parent = new Map(free.map((a) => [a.id, a.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const b of Object.values(doc.bonds)) if (parent.has(b.a1) && parent.has(b.a2)) parent.set(find(b.a1), find(b.a2));
  return new Set(free.map((a) => find(a.id))).size;
}

/** 何も選んでいないときの右の欄: 新しく作る物と、文書の中身の一覧 */
export function SideHome({
  doc,
  onNewScheme,
  onNewTable,
  onScheme,
  onTable,
  onMolecules,
  onNewRun,
  onRun,
}: {
  onNewRun(): void;
  onRun(id: string): void;
  doc: Doc;
  onNewScheme(): void;
  onNewTable(): void;
  onScheme(id: string): void;
  onTable(id: string): void;
  onMolecules(): void;
}) {
  const schemes = Object.values(doc.schemes ?? {});
  const tables = Object.values(doc.tables ?? {});
  const molecules = moleculeCount(doc);
  return (
    <section className="side-home" data-testid="side-home">
      <div className="side-home-new">
        <Menu
          label="＋ 作る"
          testId="side-new"
          items={[
            { label: '反応スキーム', testId: 'new-scheme', title: '分子と矢印から、条件・番号・書式を持つスキームを作る', onClick: onNewScheme },
            { label: '検討表', testId: 'new-table', title: '条件検討や SAR の表を作る', onClick: onNewTable },
            { label: '実験の記録', testId: 'new-run', title: '実験の 1 回ぶんの記録を作る。仕込み・操作の流れと重さ・操作ごとの記録を入れると、フロー図と収支を描く', onClick: onNewRun },
          ]}
        />
      </div>
      <ul className="side-home-list">
        {schemes.map((s, i) => {
          const compounds = new Set(s.steps.flatMap((st) => [...st.from, ...st.to])).size;
          // 最初の基質と、最後の生成物の小さな絵（スキームを見分けるため）
          const first = doc.compounds?.[s.steps[0]?.from[0] ?? ''];
          const last = doc.compounds?.[s.steps.at(-1)?.to[0] ?? ''];
          return (
            <li key={s.id}>
              <button type="button" className="home-item" data-testid="home-scheme" onClick={() => onScheme(s.id)}>
                <span className="home-thumbs" aria-hidden="true">
                  {first && <Thumb c={first} />}
                  <span className="home-arrow">→</span>
                  {last && <Thumb c={last} />}
                </span>
                <span className="home-text">
                  <b>{`反応スキーム ${i + 1}`}</b>
                  <small>{`${s.steps.length} 段・${compounds} 化合物${s.draft ? '・下書き' : ''}`}</small>
                </span>
              </button>
            </li>
          );
        })}
        {tables.map((t, i) => (
          <li key={t.id}>
            <button type="button" className="home-item" data-testid="home-table" onClick={() => onTable(t.id)}>
              <span className="home-icon" aria-hidden="true">▦</span>
              <span className="home-text">
                <b>{`検討表 ${i + 1}`}</b>
                <small>{`${t.rows.length} 行`}</small>
              </span>
            </button>
          </li>
        ))}
        {Object.values(doc.runs ?? {}).map((r) => (
          <li key={r.id}>
            <button type="button" className="home-item" data-testid="home-run" onClick={() => onRun(r.id)}>
              <span className="home-icon" aria-hidden="true">▤</span>
              <span className="home-text">
                <b>{runLabel(r)}</b>
                <small>{`${r.operations.length} 操作・記録 ${r.events.length} 行${r.date ? `・${r.date}` : ''}`}</small>
              </span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="home-item" data-testid="home-molecules" onClick={onMolecules}>
            <span className="home-icon" aria-hidden="true">⌬</span>
            <span className="home-text">
              <b>{molecules ? `分子 ${molecules} 個` : '分子'}</b>
              <small>SMILES・分子量・構造の確認</small>
            </span>
          </button>
        </li>
      </ul>
      <p className="muted">キャンバスで選ぶと、ここで直せます。</p>
    </section>
  );
}

/** 空のキャンバスの真ん中に出す、3 つの入口 */
export function EntryCards({ onSample, onAi }: { onSample(id: string): void; onAi(): void }) {
  return (
    <div className="entry" data-testid="empty-hint">
      <p className="entry-title">反応スキームと構造式を描きます</p>
      <div className="entry-cards">
        <div className="entry-card">
          <h3>描く</h3>
          <p>左の道具を選んで、ここをクリックします。名前や SMILES は、上の入力欄から置けます。</p>
        </div>
        <div className="entry-card" data-testid="welcome">
          <h3>見本を開く</h3>
          <div className="chips">
            <button type="button" onClick={() => onSample('coupling')}>反応スキーム</button>
            <button type="button" onClick={() => onSample('conditions')}>条件検討の表</button>
            <button type="button" onClick={() => onSample('taxol')}>タキソール</button>
          </div>
        </div>
        <div className="entry-card">
          <h3>文章や図から作る</h3>
          <p>実験の文章や論文の図から、スキームの下書きを AI で作ります。</p>
          <button type="button" className="primary" data-testid="entry-ai" onClick={onAi}>始める</button>
        </div>
      </div>
    </div>
  );
}

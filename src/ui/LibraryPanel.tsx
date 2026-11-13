import { useMemo, useState } from 'react';
import { track } from '../analytics';
import { targetFragments } from '../chem/analysis';
import type { P } from '../chem/geometry';
import { emptyDoc } from '../chem/model';
import { useEditor, type EditorStore } from '../editor/store';
import {
  addPart, removePart, exportBundle, exportSdf, importBundle, linkedFragments, placeCompound, registerCompound, removeFigure, removeLibraryCompound,
  removeSavedTable, saveFigure, saveTable, searchCompounds, setLink, updateLibraryInfo, updateLibraryStructure,
} from '../project/library';
import { placeTable } from '../table/ops';
import { displayName, type LibraryCompound } from '../project/model';
import { useProject, type ProjectStore } from '../project/store';
import { structureSvg } from '../render/layout';
import { download } from './IoPanel';
import { exportZip } from '../project/zip';
import type { Structure } from '../scheme/model';
import { attachPoint } from '../chem/partOps';

export const COMPOUND_MIME = 'application/x-ace-compound';

export function Thumb({ c }: { c: { structure: Structure } }) {
  const svg = useMemo(() => structureSvg({ ...emptyDoc(), atoms: c.structure.atoms, bonds: c.structure.bonds, groups: c.structure.groups }), [c.structure]);
  // 自前で作った SVG（文字はエスケープ済み）
  return <div className="thumb" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function LibraryPanel({ store, projects, viewCenter }: { store: EditorStore; projects: ProjectStore; viewCenter(): P }) {
  const project = useProject(projects, (s) => s.project);
  const summaries = useProject(projects, (s) => s.summaries);
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const [tab, setTab] = useState<'compounds' | 'figures' | 'tables' | 'parts'>('compounds');
  const [partName, setPartName] = useState('');
  const activePart = useEditor(store, (s) => (s.tool === 'part' ? s.part?.id : null));
  const [query, setQuery] = useState('');
  const [bySelection, setBySelection] = useState(false);
  const [dup, setDup] = useState<{ of: string; atomIds: string[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [figName, setFigName] = useState('');
  const say = (message: string) => store.set({ message });

  const selected = useMemo(() => (selection.size ? targetFragments(doc, selection) : []), [doc, selection]);
  const one = selected.length === 1 ? selected[0] : null;
  const linked = useMemo(() => {
    try {
      return linkedFragments(doc, project);
    } catch {
      return [];
    }
  }, [doc, project]);
  const changed = linked.filter((l) => l.status === 'changed');
  const list = useMemo(() => {
    if (!project) return [];
    try {
      return searchCompounds(project, query, bySelection && one ? { doc, atomIds: one } : undefined);
    } catch {
      return [];
    }
  }, [project, query, bySelection, one, doc]);

  if (!project) return <aside className="library" data-testid="library">読み込んでいます…</aside>;

  const register = (allowDuplicate = false) => {
    if (!one) return;
    const r = registerCompound(project, store.get().doc, one, allowDuplicate);
    if (!r) return say('この分子は構造として読めないので登録できません。価数を確かめてください');
    if ('duplicateOf' in r) {
      setDup({ of: r.duplicateOf, atomIds: one });
      return;
    }
    projects.update(r.project);
    store.commit(setLink(store.get().doc, one, r.id));
    setDup(null);
    setEditing(r.id);
    track('library:register');
    say('ライブラリに登録しました。番号や呼び名を入れられます');
  };

  const place = (c: LibraryCompound) => {
    const { doc: d, ids } = placeCompound(store.get().doc, c, viewCenter());
    store.commit(d, ids);
    store.set({ tool: 'select' });
    track('library:place');
  };

  return (
    <aside className="library" data-testid="library">
      <div className="lib-head">
        <select
          aria-label="プロジェクト"
          data-testid="project-select"
          value={project.id}
          onChange={(e) => void projects.open(e.target.value)}
        >
          {summaries.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === project.id ? project.name : s.name}（{s.id === project.id ? Object.keys(project.compounds).length : s.compoundCount}）
            </option>
          ))}
        </select>
        <button type="button" title="新しいプロジェクト" onClick={() => setNewName('')}>＋</button>
      </div>
      {newName !== null && (
        <form
          className="lib-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) void projects.create(newName.trim());
            setNewName(null);
          }}
        >
          <input autoFocus placeholder="プロジェクトの名前" value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="project-name" />
          <button type="submit">作る</button>
        </form>
      )}
      <div className="lib-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'compounds'} className={tab === 'compounds' ? 'on' : ''} onClick={() => setTab('compounds')}>
          化合物 {Object.keys(project.compounds).length}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'figures'} className={tab === 'figures' ? 'on' : ''} onClick={() => setTab('figures')}>
          図 {Object.keys(project.figures).length}
        </button>
        <button type="button" role="tab" data-testid="tables-tab" aria-selected={tab === 'tables'} className={tab === 'tables' ? 'on' : ''} onClick={() => setTab('tables')}>
          表 {Object.keys(project.tables ?? {}).length}
        </button>
        <button type="button" role="tab" data-testid="parts-tab" aria-selected={tab === 'parts'} className={tab === 'parts' ? 'on' : ''} onClick={() => setTab('parts')}>
          部品 {Object.keys(project.parts ?? {}).length}
        </button>
      </div>

      {changed.map((l) => {
        const c = project.compounds[l.compoundId];
        return (
          <div className="lib-notice" key={l.atomIds[0]} data-testid="link-changed">
            <p>キャンバスの分子が、ライブラリの「{displayName(c)}」と違います。</p>
            <div className="row">
              <button type="button" onClick={() => projects.update(updateLibraryStructure(project, c.id, store.get().doc, l.atomIds))}>ライブラリを更新</button>
              <button
                type="button"
                onClick={() => {
                  const r = registerCompound(project, store.get().doc, l.atomIds, true);
                  if (r && 'project' in r) {
                    projects.update(r.project);
                    store.commit(setLink(store.get().doc, l.atomIds, r.id));
                  }
                }}
              >
                別の化合物として登録
              </button>
              <button type="button" onClick={() => store.commit(setLink(store.get().doc, l.atomIds, null))}>つながりを外す</button>
            </div>
          </div>
        );
      })}

      {tab === 'compounds' && (
        <>
          <div className="row">
            <button type="button" data-testid="register" disabled={!one} onClick={() => register()} title="選んだ分子をこのプロジェクトのライブラリに入れる">
              選んだ分子を登録
            </button>
          </div>
          {dup && (
            <div className="lib-notice" data-testid="duplicate">
              <p>同じ構造の「{displayName(project.compounds[dup.of])}」が登録済みです。</p>
              <div className="row">
                <button
                  type="button"
                  onClick={() => {
                    store.commit(setLink(store.get().doc, dup.atomIds, dup.of));
                    setDup(null);
                  }}
                >
                  登録済みのものにつなぐ
                </button>
                <button type="button" onClick={() => register(true)}>別の化合物として登録</button>
                <button type="button" onClick={() => setDup(null)}>やめる</button>
              </div>
            </div>
          )}
          <input className="lib-search" placeholder="番号・呼び名・組成式で探す" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="lib-search" />
          <label className="lib-sub">
            <input type="checkbox" checked={bySelection} onChange={(e) => setBySelection(e.target.checked)} disabled={!one} /> 選んだ分子を含むものだけ
          </label>
          {Object.keys(project.compounds).length === 0 && (
            <p className="muted">キャンバスの分子を選んで「選んだ分子を登録」すると、ここに並びます。ドラッグかクリックでキャンバスに置けます。</p>
          )}
          <ul className="lib-list">
            {list.map((c) => (
              <li
                key={c.id}
                className="lib-card"
                draggable
                data-testid="lib-card"
                onDragStart={(e) => {
                  e.dataTransfer.setData(COMPOUND_MIME, c.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <button type="button" className="lib-place" title="クリックすると表示の中央に置く。ドラッグしても置ける" onClick={() => place(c)}>
                  <Thumb c={c} />
                </button>
                <div className="lib-info">
                  <b>{displayName(c)}</b>
                  <small>{c.formula} · {c.mw.toFixed(2)}</small>
                  {editing === c.id ? (
                    <div className="lib-edit">
                      <input placeholder="番号" defaultValue={c.number ?? ''} onBlur={(e) => projects.update(updateLibraryInfo(projects.get().project!, c.id, { number: e.target.value || undefined }))} data-testid="lib-number" />
                      <input placeholder="呼び名" defaultValue={c.nickname ?? ''} onBlur={(e) => projects.update(updateLibraryInfo(projects.get().project!, c.id, { nickname: e.target.value || undefined }))} data-testid="lib-nickname" />
                      <input placeholder="メモ" defaultValue={c.note ?? ''} onBlur={(e) => projects.update(updateLibraryInfo(projects.get().project!, c.id, { note: e.target.value || undefined }))} />
                      <div className="row">
                        <button type="button" onClick={() => setEditing(null)}>閉じる</button>
                        <button type="button" className="danger" onClick={() => { projects.update(removeLibraryCompound(project, c.id)); setEditing(null); }}>消す</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="link" onClick={() => setEditing(c.id)}>編集</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'figures' && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const name = figName.trim() || `図 ${Object.keys(project.figures).length + 1}`;
              projects.update(saveFigure(project, name, store.get().doc).project);
              setFigName('');
              track('figure:save');
              say(`「${name}」をプロジェクトに保存しました`);
            }}
          >
            <input placeholder="図の名前" value={figName} onChange={(e) => setFigName(e.target.value)} data-testid="figure-name" />
            <button type="submit">今の図を保存</button>
          </form>
          <ul className="fig-list">
            {Object.values(project.figures)
              .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
              .map((f) => (
                <li key={f.id} data-testid="figure">
                  <span>{f.name}</span>
                  <small>{new Date(f.savedAt).toLocaleString('ja-JP')}</small>
                  <button type="button" onClick={() => store.commit(structuredClone(f.doc), new Set())} title="今の図と入れ替える。元に戻すと前の図に戻る">開く</button>
                  <button type="button" onClick={() => projects.update(saveFigure(project, f.name, store.get().doc, f.id).project)} title="今の図で上書きする">上書き</button>
                  <button type="button" className="danger" onClick={() => projects.update(removeFigure(project, f.id))}>消す</button>
                </li>
              ))}
          </ul>
        </>
      )}

      {tab === 'tables' && (
        <>
          <p className="muted">検討表を、表の上の反応式ごとプロジェクトに入れます。入れた表は、ほかの図に置き直せます。化合物は、置いた図の新しい化合物になります。</p>
          {Object.values(doc.tables ?? {}).length > 0 ? (
            <ul className="fig-list">
              {Object.values(doc.tables ?? {}).map((t) => {
                const label = `Table ${t.number ?? ''}${t.title ? ` ${t.title}` : ''}`.trim();
                return (
                  <li key={t.id} data-testid="doc-table">
                    <span>{label}</span>
                    <small>この図の表・{t.rows.length} 行</small>
                    <button
                      type="button"
                      data-testid="save-table"
                      onClick={() => {
                        const r = saveTable(project, store.get().doc, t.id, label);
                        if (!r) return;
                        projects.update(r.project);
                        track('table:save');
                        say(`「${label}」をプロジェクトに入れました`);
                      }}
                    >
                      入れる
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">この図には検討表がありません。右の欄の「検討表」で作れます。</p>
          )}
          <ul className="fig-list">
            {Object.values(project.tables ?? {})
              .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
              .map((t) => (
                <li key={t.id} data-testid="saved-table">
                  <span>{t.name}</span>
                  <small>{new Date(t.savedAt).toLocaleString('ja-JP')}・{t.table.rows.length} 行{t.scheme ? '・反応式つき' : ''}</small>
                  <button
                    type="button"
                    data-testid="place-table"
                    onClick={() => (store.commit(placeTable(store.get().doc, t).doc, new Set()), track('table:place'))}
                    title="今の図の下に置く"
                  >
                    置く
                  </button>
                  <button type="button" className="danger" onClick={() => projects.update(removeSavedTable(project, t.id))}>消す</button>
                </li>
              ))}
          </ul>
        </>
      )}

      {tab === 'parts' && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!one) return say('部品にする分子を1つ選んでください');
              const r = addPart(project, partName, store.get().doc, one);
              projects.update(r.project);
              setPartName('');
              track('part:add');
              say(attachPoint(r.project.parts![r.id].structure) ? '部品にしました。R の原子がつなぐ点です' : '部品にしました。つなぐ点の R が無いので、何もない所に置く部品です');
            }}
          >
            <input placeholder="母核 A などの部品の名前" value={partName} onChange={(e) => setPartName(e.target.value)} data-testid="part-name" />
            <button type="submit" disabled={!one} data-testid="add-part">選んだ分子を部品にする</button>
          </form>
          <p className="muted">原子のラベルに R を付けた所が、つなぐ点です。部品を選んでから、キャンバスの原子をクリックするとそこにつなぎ、何もない所をクリックするとそこに置きます。</p>
          <ul className="lib-list">
            {Object.values(project.parts ?? {}).map((pt) => (
              <li key={pt.id} className={`lib-card part${activePart === pt.id ? ' on' : ''}`} data-testid="part-card">
                <button
                  type="button"
                  className="lib-place"
                  title="この部品を置くツールにする"
                  onClick={() => {
                    store.set({ tool: 'part', part: { id: pt.id, name: pt.name, structure: pt.structure } });
                    track('part:use', { once: true });
                    say(`部品「${pt.name}」を選びました。原子をクリックするとつなぎ、何もない所をクリックすると置きます`);
                  }}
                >
                  <Thumb c={pt} />
                </button>
                <div className="lib-info">
                  <b>{pt.name}</b>
                  <button type="button" className="danger" onClick={() => projects.update(removePart(project, pt.id))}>消す</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="lib-io">
        <summary>プロジェクトの書き出し・読み込み</summary>
        <div className="row">
          <button type="button" onClick={() => download(`${project.name}.aceproj.json`, exportBundle(project), 'application/json')}>一式（JSON）</button>
          <button type="button" onClick={() => download(`${project.name}.sdf`, exportSdf(project), 'chemical/x-mdl-sdfile')}>化合物（SDF）</button>
          <button
            type="button"
            data-testid="project-zip"
            title="ほかのソフトで開ける図の CDXML・SVG、化合物の SDF・CSV、表の CSV と、読み込み直せる JSON を 1 つの zip にまとめる"
            onClick={() => download(`${project.name}.zip`, new Blob([exportZip(project) as BlobPart], { type: 'application/zip' }), 'application/zip')}
          >
            一式（zip）
          </button>
          <label className="file">
            読み込む
            <input
              type="file"
              accept=".json"
              data-testid="project-import"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  await projects.create('', importBundle(await f.text()));
                } catch (err) {
                  say(String((err as Error).message ?? err));
                }
              }}
            />
          </label>
        </div>
        <p className="muted">プロジェクトはこのブラウザの中に保存され、PC の外には出ません。別の PC へは、一式（JSON）で持っていけます。</p>
      </details>
    </aside>
  );
}

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { track } from '../analytics';
import type { Doc } from '../chem/model';
import { useEditor, type EditorStore } from '../editor/store';
import { freeFragments } from '../scheme/ops';
import { COLUMN_KINDS, cellText, type ColumnKind, type StudyTable } from '../table/model';
import {
  addColumn, addRow, createTable, dissolveTable, moveColumn, moveRow, moveRowTo, pasteRows, removeColumn, removeRow, removeTable, schemeFromRow, setCell,
  setNotes, setTableInfo, tableCsv, tableTsv, tableXlsx, updateColumn,
} from '../table/ops';
import { download } from './IoPanel';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
import { Field } from './SchemePanel';

/** 選択に含まれる表の id（無ければ文書の最初の表） */
function activeTableId(doc: Doc, sel: Set<string>, chosen: string | null): string | null {
  for (const id of sel) {
    const ref = doc.atoms[id]?.ref?.split(':')[0] ?? doc.arrows[id]?.ref ?? doc.texts[id]?.ref;
    if (ref && doc.tables?.[ref]) return ref;
  }
  if (chosen && doc.tables?.[chosen]) return chosen;
  return Object.keys(doc.tables ?? {})[0] ?? null;
}

/** 選択に含まれるスキームの id（無ければ文書の最初のスキーム） */
function activeSchemeId(doc: Doc, sel: Set<string>): string | null {
  for (const id of sel) {
    const ref = doc.atoms[id]?.ref?.split(':')[0] ?? doc.arrows[id]?.ref ?? doc.texts[id]?.ref ?? doc.pluses[id]?.ref;
    if (ref && doc.schemes?.[ref]) return ref;
  }
  return Object.keys(doc.schemes ?? {})[0] ?? null;
}

/** セルの入力欄。確定（Enter かフォーカスが外れたとき）で値を渡す */
function Cell({ value, onCommit, testId, placeholder }: { value: string; onCommit(v: string): void; testId?: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="cell"
      value={v}
      data-testid={testId}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function TablePanel({ store, onCreated, gridHost }: { store: EditorStore; onCreated?: () => void; /** 行と列の表を出す所（キャンバスの下の表の欄）。無ければこの欄の中に出す */ gridHost?: HTMLElement | null }) {
  const doc = useEditor(store, (s) => s.doc);
  const selection = useEditor(store, (s) => s.selection);
  const [chosen, setChosen] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const tid = activeTableId(doc, selection, chosen);
  const table = tid ? doc.tables![tid] : null;
  const sid = activeSchemeId(doc, selection);
  const selected = freeFragments(doc, selection);
  const oneSelected = selection.size > 0 && selected.length === 1 ? selected[0] : null;
  const say = (message: string) => store.set({ message });
  // ドラッグ中の行（ドラッグを始めたときに描き直すと、Chrome がドラッグをやめるので state にしない）
  const dragRow = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const commit = (f: (d: Doc) => Doc) => store.commit(f(store.get().doc));

  const create = (kind: 'conditions' | 'sar') => {
    const d = store.get().doc;
    const r =
      kind === 'conditions'
        ? createTable(d, 'conditions', sid ? { schemeId: sid } : {})
        : createTable(d, 'sar', oneSelected ? { coreAtomIds: oneSelected } : {});
    store.commit(r.doc, new Set());
    setChosen(r.tableId);
    track(`table:create-${kind}`);
    onCreated?.();
    // 反応式（母核）が無いと表だけになるので、そう知らせる
    if (kind === 'conditions' && !sid) say('反応スキームが無いので、表だけを作りました。先に反応スキームを作ってから押すと、表の上に反応式を描きます');
    if (kind === 'sar' && !oneSelected) say('分子を選んでいないので、表だけを作りました。R1・R2 のラベルを付けた分子を選んでから押すと、表の上に母核を描きます');
  };

  const copy = () => {
    if (!table) return;
    navigator.clipboard?.writeText(tableTsv(table)).then(
      () => say('表をコピーしました。Excel に貼れます'),
      () => say('コピーできませんでした'),
    );
  };

  /** 行と列の表（セルの入力・行の操作・行と列を足す・コピー）。下の表の欄があれば、そこに出す */
  const grid = (tid: string, table: StudyTable) => (
    <>
          <p className="muted hint">セルの終わりに「^b」と書くと、注 b の記号 ᵇ を付けます。例: 85^b、rt^a,c</p>
      <div className="table-wrap">
        <table className="study">
          <thead>
            <tr>
              <th />
              {table.columns.map((c) => (
                <th key={c.id} title={COLUMN_KINDS.find((k) => k.kind === c.kind)?.name}>
                  {c.label}
                  {c.unit ? ` (${c.unit})` : ''}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, ri) => (
              <tr
                key={r.id}
                data-testid="table-row"
                className={dragOver === ri && dragRow.current !== null && dragRow.current !== ri ? (dragRow.current < ri ? 'drop-below' : 'drop-above') : undefined}
                onDragOver={(e) => {
                  if (dragRow.current === null) return;
                  e.preventDefault();
                  if (dragOver !== ri) setDragOver(ri);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragRow.current;
                  if (from !== null && from !== ri) commit((d) => moveRowTo(d, tid, table.rows[from].id, ri));
                  dragRow.current = null;
                  setDragOver(null);
                }}
              >
                <td className="drag-cell">
                  <span
                    className="drag-handle"
                    draggable
                    data-testid="row-drag"
                    title="ドラッグで行を並べ替える"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', r.id);
                      dragRow.current = ri;
                    }}
                    onDragEnd={() => {
                      dragRow.current = null;
                      setDragOver(null);
                    }}
                  >
                    ⠿
                  </span>
                </td>
                {table.columns.map((c) => (
                  <td key={c.id}>
                    {c.kind === 'entry' ? (
                      <Cell value={r.cells[c.id] ?? ''} placeholder={cellText(table, ri, c)} onCommit={(v) => commit((d) => setCell(d, tid, r.id, c.id, v))} />
                    ) : (
                      <Cell value={r.cells[c.id] ?? ''} testId={`cell-${c.kind}`} onCommit={(v) => commit((d) => setCell(d, tid, r.id, c.id, v))} />
                    )}
                  </td>
                ))}
                <td className="row-actions">
                  <button type="button" title="上へ" onClick={() => commit((d) => moveRow(d, tid, r.id, -1))}>↑</button>
                  <button type="button" title="下へ" onClick={() => commit((d) => moveRow(d, tid, r.id, 1))}>↓</button>
                  <button type="button" title="この行を複製" onClick={() => commit((d) => addRow(d, tid, r.id))}>⧉</button>
                  <button type="button" title="この行を消す" onClick={() => commit((d) => removeRow(d, tid, r.id))}>×</button>
                  {table.schemeId && (
                    <button
                      type="button"
                      data-testid="row-to-scheme"
                      title="この行の条件で反応式を作り、表の下に置く"
                      onClick={() => {
                        const out = schemeFromRow(store.get().doc, tid, r.id);
                        if (out) {
                          store.commit(out.doc, new Set());
                          track('table:row-to-scheme');
                        }
                      }}
                    >
                      →式
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button type="button" data-testid="add-row" onClick={() => commit((d) => addRow(d, tid))}>行を足す</button>
        <select
          data-testid="add-column"
          value=""
          onChange={(e) => {
            if (e.target.value) commit((d) => addColumn(d, tid, e.target.value as ColumnKind));
          }}
        >
          <option value="">列を足す…</option>
          {COLUMN_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>{k.name}</option>
          ))}
        </select>
        <button type="button" onClick={copy} title="タブ区切りでコピーする。Excel に貼れる">コピー</button>
        <button type="button" onClick={() => download(`table-${table.number ?? tid}.csv`, `﻿${tableCsv(table)}`, 'text/csv')} title="CSV で保存する。Excel で開ける">CSV</button>
        <button
          type="button"
          data-testid="table-xlsx"
          onClick={() => download(`table-${table.number ?? tid}.xlsx`, new Blob([tableXlsx(table) as BlobPart], { type: XLSX_TYPE }), XLSX_TYPE)}
          title="Excel のファイル（.xlsx）で保存する。題・見出し・注も入り、数は数として入る"
        >
          Excel
        </button>
      </div>
    </>
  );

  return (
    <section className="table-panel" data-testid="table-panel" data-table-ui>
      <h2>検討表</h2>
      <div className="row">
        <button type="button" className="primary" data-testid="new-conditions-table" onClick={() => create('conditions')} title={sid ? 'スキームの反応式を表の上に描く' : '反応式なしで表を作る。先にスキームを作ると、表の上に反応式を描ける'}>
          ＋条件検討の表
        </button>
        <button type="button" data-testid="new-sar-table" onClick={() => create('sar')} title="R1・R2 のラベルを付けて選んだ分子を、母核にする">
          ＋SAR の表
        </button>
      </div>
      {!table && (
        <>
          <p className="muted">条件検討の表は、反応スキームの反応式を表の上に描きます。SAR の表は、原子のラベルに R1・R2 を付けて選んだ分子を、母核にします。</p>
          <details className="table-sub">
            <summary>置換基の書き方</summary>
            <p className="muted">置換基の列に「*c1ccc(OC)cc1」のように * でつなぐ点を示した SMILES を入れると、構造を描きます。Ph や 4-ClC6H4 のようなほかの書き方は、文字で描きます。</p>
          </details>
        </>
      )}
      {table && tid && (
        <>
          {Object.keys(doc.tables!).length > 1 && (
            <label className="field">
              <span>表</span>
              <select value={tid} onChange={(e) => setChosen(e.target.value)}>
                {Object.values(doc.tables!).map((t) => (
                  <option key={t.id} value={t.id}>
                    Table {t.number} {t.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid head">
            <Field label="番号" testId="table-number" value={table.number ?? ''} onCommit={(v) => commit((d) => setTableInfo(d, tid, { number: v.trim() || undefined }))} />
            <Field label="題" width="2 / 4" testId="table-title" value={table.title ?? ''} onCommit={(v) => commit((d) => setTableInfo(d, tid, { title: v.trim() || undefined }))} />
          </div>
          {gridHost ? createPortal(grid(tid, table), gridHost) : grid(tid, table)}
          <details className="table-sub">
            <summary>Excel から貼り付け</summary>
            <textarea
              data-testid="table-paste"
              placeholder={'Excel の範囲をコピーして、ここに貼り付け\n1 行目が見出しなら、見出しで列を合わせます'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <button
              type="button"
              data-testid="table-paste-apply"
              disabled={!paste.trim()}
              onClick={() => {
                const r = pasteRows(store.get().doc, tid, paste);
                store.commit(r.doc);
                track('table:paste');
                say(`${r.added} 行を入れました`);
                setPaste('');
              }}
            >
              行として入れる
            </button>
          </details>
          <details className="table-sub">
            <summary>列の見出し・単位・注の記号</summary>
            {table.columns.map((c, ci) => (
              <div className="col-edit" key={c.id} data-testid="column-edit">
                <span className="kind">{COLUMN_KINDS.find((k) => k.kind === c.kind)?.name}</span>
                <Cell value={c.label} testId="column-label" onCommit={(v) => commit((d) => updateColumn(d, tid, c.id, { label: v }))} />
                <Cell value={c.unit ?? ''} placeholder="単位" onCommit={(v) => commit((d) => updateColumn(d, tid, c.id, { unit: v }))} />
                <Cell value={c.mark ?? ''} placeholder="注" onCommit={(v) => commit((d) => updateColumn(d, tid, c.id, { mark: v }))} />
                <button type="button" disabled={ci === 0} title="左へ" onClick={() => commit((d) => moveColumn(d, tid, c.id, -1))}>←</button>
                <button type="button" disabled={ci === table.columns.length - 1} title="右へ" onClick={() => commit((d) => moveColumn(d, tid, c.id, 1))}>→</button>
                <button type="button" title="この列を消す" onClick={() => commit((d) => removeColumn(d, tid, c.id))}>×</button>
              </div>
            ))}
          </details>
          <label className="field">
            <span>表の下の注。1 行に 1 つ、a, b, c… の順に書き、列の「注」に同じ記号を入れると見出しに付きます</span>
            <NotesField notes={table.notes} onCommit={(notes) => commit((d) => setNotes(d, tid, notes))} />
          </label>
          <div className="row">
            <button type="button" onClick={() => store.commit(dissolveTable(store.get().doc, tid), new Set())} title="表のデータを消して、文字と線だけの図に戻す">表をやめる</button>
            <button type="button" onClick={() => store.commit(removeTable(store.get().doc, tid), new Set())} title="表を消す。反応式は残す">表を消す</button>
          </div>
        </>
      )}
    </section>
  );
}

function NotesField({ notes, onCommit }: { notes: string[]; onCommit(n: string[]): void }) {
  const text = notes.join('\n');
  const [v, setV] = useState(text);
  useEffect(() => setV(text), [text]);
  return <textarea className="notes" data-testid="table-notes" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== text && onCommit(v.split('\n'))} />;
}

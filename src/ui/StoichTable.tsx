import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Doc } from '../chem/model';
import type { EditorStore } from '../editor/store';
import type { Step } from '../scheme/model';
import { updateStoich } from '../scheme/ops';
import { formatNumber as fmt, stoichTable, stoichTsv } from '../scheme/stoich';

/** 段ごとの化学量論表。基準の量（最初の基質）を入れると、各試薬の量を出す */
export function StoichTable({ store, doc, schemeId, index, step, host }: { store: EditorStore; doc: Doc; schemeId: string; index: number; step: Step; /** 表を出す所（キャンバスの下の欄） */ host?: HTMLElement | null }) {
  const [open, setOpen] = useState(false);
  const rows = stoichTable(doc, step);
  const set = (patch: Parameters<typeof updateStoich>[3]) => store.commit(updateStoich(store.get().doc, schemeId, index, patch));
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const copy = () => {
    navigator.clipboard?.writeText(stoichTsv(rows)).then(
      () => store.set({ message: '化学量論表をコピーしました。Excel に貼れます' }),
      () => store.set({ message: 'コピーできませんでした' }),
    );
  };
  const body = (
    <div className="stoich-body" data-testid="stoich-body" data-scheme-ui>
      {host && <h3>化学量論表　段 {index + 1}</h3>}
      <div className="row">
        <label className="field">
          <span>最初の基質の量</span>
          <input
            type="number"
            min={0}
            step="any"
            data-testid="stoich-scale"
            value={step.scale?.value ?? ''}
            onChange={(e) => set({ scale: num(e.target.value) === undefined ? undefined : { value: Number(e.target.value), unit: step.scale?.unit ?? 'mg' } })}
          />
        </label>
        <label className="field">
          <span>単位</span>
          <select value={step.scale?.unit ?? 'mg'} data-testid="stoich-unit" onChange={(e) => set({ scale: { value: step.scale?.value ?? 0, unit: e.target.value as 'mg' | 'mmol' } })}>
            <option value="mg">mg</option>
            <option value="mmol">mmol</option>
          </select>
        </label>
        <button type="button" onClick={copy}>表をコピー</button>
      </div>
      <div className="table-wrap">
        <table data-testid="stoich-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>MW</th>
              <th>当量</th>
              <th>mmol</th>
              <th>mg</th>
              <th>µL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.kind}>
                <td>{r.name}{r.kind === 'product' ? '（理論）' : ''}</td>
                <td>
                  {r.kind === 'reagent' ? (
                    <input
                      type="number"
                      step="any"
                      className="cell"
                      placeholder="?"
                      aria-label={`${r.name} の分子量`}
                      value={r.mw ?? ''}
                      onChange={(e) => set({ reagent: { index: r.ref as number, mw: num(e.target.value) } })}
                    />
                  ) : (
                    fmt(r.mw, 2)
                  )}
                </td>
                <td>
                  {r.kind === 'substrate' && i > 0 ? (
                    <input
                      type="number"
                      step="any"
                      className="cell"
                      aria-label={`${r.name} の当量`}
                      value={r.equiv ?? ''}
                      onChange={(e) => set({ substrateEquiv: { [r.ref as string]: Number(e.target.value) || 0 } })}
                    />
                  ) : (
                    fmt(r.equiv, 2)
                  )}
                </td>
                <td>{fmt(r.mmol, 3)}</td>
                <td>{fmt(r.mg, 1)}</td>
                <td>
                  {r.kind === 'reagent' ? (
                    <span title="密度（g/mL）を入れると体積を出す">
                      {fmt(r.uL, 1)}
                      <input
                        type="number"
                        step="any"
                        className="cell density"
                        placeholder="d"
                        aria-label={`${r.name} の密度`}
                        value={r.density ?? ''}
                        onChange={(e) => set({ reagent: { index: r.ref as number, density: num(e.target.value) } })}
                      />
                    </span>
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
  return (
    <details className="stoich" data-testid="stoich" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>化学量論表</summary>
      {/* 表は列が多いので、キャンバスの下の欄があれば、そこに出す */}
      {open && (host ? createPortal(body, host) : body)}
    </details>
  );
}

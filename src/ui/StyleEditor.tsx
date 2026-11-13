import { useState } from 'react';
import type { EditorStore } from '../editor/store';
import { editSchemeStyle } from '../scheme/ops';
import { saveMyStyle, wrapAtOf, type ConditionField, type SchemeStyle } from '../scheme/style';

const FIELDS: { id: ConditionField; label: string }[] = [
  { id: 'reagents', label: '試薬' },
  { id: 'solvent', label: '溶媒' },
  { id: 'temp', label: '温度' },
  { id: 'time', label: '時間' },
];

const EQUIV_FORMATS = ['{n} equiv', '({n} equiv)', '{n} eq.', '({n} eq.)', '{n} equiv.'];
const YIELD_FORMATS = ['{y}%', '({y}%)', '{y}% yield'];

/** スキームの書式を画面で直す。プリセットを直すと、写しが文書の書式になる */
export function StyleEditor({ store, schemeId, style, onSaved }: { store: EditorStore; schemeId: string; style: SchemeStyle; onSaved(list: SchemeStyle[]): void }) {
  const [name, setName] = useState('');
  const set = (patch: Partial<SchemeStyle>) => store.commit(editSchemeStyle(store.get().doc, schemeId, patch));
  const wrap = wrapAtOf(style);
  const hasPage = !!store.get().doc.page;

  const placeOf = (f: ConditionField) => (style.above.includes(f) ? 'above' : style.below.includes(f) ? 'below' : 'none');
  const setPlace = (f: ConditionField, place: string) => {
    // 並びは 試薬・溶媒・温度・時間 の順に保つ
    const order = FIELDS.map((x) => x.id);
    const pick = (where: string) => order.filter((x) => (x === f ? place === where : placeOf(x) === where));
    set({ above: pick('above'), below: pick('below') });
  };

  return (
    <details className="style-editor" data-testid="style-editor">
      <summary>書式を編集</summary>
      <div className="grid">
        <label className="field">
          <span>条件の置き方</span>
          <select data-testid="style-conditions" value={style.conditions} onChange={(e) => set({ conditions: e.target.value as SchemeStyle['conditions'] })}>
            <option value="on-arrow">矢印の上下</option>
            <option value="footnote">脚注</option>
          </select>
        </label>
        {FIELDS.map((f) => (
          <label className="field" key={f.id}>
            <span>{f.label}</span>
            <select data-testid={`style-place-${f.id}`} value={placeOf(f.id)} onChange={(e) => setPlace(f.id, e.target.value)}>
              <option value="above">矢印の上</option>
              <option value="below">矢印の下</option>
              <option value="none">書かない</option>
            </select>
          </label>
        ))}
        <label className="field">
          <span>当量の書き方</span>
          <select data-testid="style-equiv" value={style.equivFormat} onChange={(e) => set({ equivFormat: e.target.value })}>
            {[...new Set([style.equivFormat, ...EQUIV_FORMATS])].map((x) => (
              <option key={x} value={x}>{x.replace('{n}', '1.2')}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>収率の書き方</span>
          <select data-testid="style-yield" value={style.yieldFormat} onChange={(e) => set({ yieldFormat: e.target.value })}>
            {[...new Set([style.yieldFormat, ...YIELD_FORMATS])].map((x) => (
              <option key={x} value={x}>{x.replace('{y}', '85')}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>収率の位置</span>
          <select data-testid="style-yield-position" value={style.yieldPosition} onChange={(e) => set({ yieldPosition: e.target.value as SchemeStyle['yieldPosition'] })}>
            <option value="below-arrow">矢印の下</option>
            <option value="after-label">番号の横</option>
            <option value="none">書かない</option>
          </select>
        </label>
        <label className="field">
          <span>脚注の段の記号</span>
          <select value={style.stepMarks} onChange={(e) => set({ stepMarks: e.target.value as SchemeStyle['stepMarks'] })}>
            <option value="alpha">a, b, c</option>
            <option value="roman">i, ii, iii</option>
            <option value="number">1, 2, 3</option>
          </select>
        </label>
        <label className="field">
          <span>区切り</span>
          <select value={style.separator} onChange={(e) => set({ separator: e.target.value })}>
            <option value=", ">, （カンマ）</option>
            <option value="; ">; （セミコロン）</option>
            <option value=" / ">/ （スラッシュ）</option>
          </select>
        </label>
        <label className="field">
          <span>行の幅（pt）</span>
          <input type="number" min={150} step={10} value={style.maxRowWidth} onChange={(e) => set({ maxRowWidth: Math.max(150, Number(e.target.value) || 500) })} />
        </label>
        <label className="field">
          <span>条件の幅（pt）</span>
          <input type="number" min={40} step={10} value={style.maxConditionWidth} onChange={(e) => set({ maxConditionWidth: Math.max(40, Number(e.target.value) || 120) })} />
        </label>
      </div>
      {hasPage && <p className="muted" data-testid="style-page-width">ページの設定があるので、行の幅は、ページの右端の少し内側までにします。</p>}
      <fieldset className="checks wrap-at" data-testid="style-wrap-at">
        <legend>行の折り返し位置</legend>
        {(['arrow', 'compound'] as const).map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              data-testid={`style-wrap-${k}`}
              checked={wrap[k]}
              // どちらか 1 つは必ず付いている
              disabled={wrap[k] && !wrap[k === 'arrow' ? 'compound' : 'arrow']}
              onChange={(e) => set({ wrapAt: { ...wrap, [k]: e.target.checked } })}
            />{' '}
            {k === 'arrow' ? '矢印の後' : '化合物の後'}
          </label>
        ))}
      </fieldset>
      <div className="checks">
        <label><input type="checkbox" checked={style.boldNumber} onChange={(e) => set({ boldNumber: e.target.checked })} /> 番号を太字</label>
        <label><input type="checkbox" data-testid="style-nickname" checked={style.showNickname} onChange={(e) => set({ showNickname: e.target.checked })} /> 番号が無ければ呼び名</label>
        <label><input type="checkbox" data-testid="style-notebook" checked={style.showNotebook} onChange={(e) => set({ showNotebook: e.target.checked })} /> ノート番号</label>
      </div>
      <div className="row">
        <input className="name" placeholder="テンプレートの名前" value={name} onChange={(e) => setName(e.target.value)} data-testid="style-name" />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => {
            const id = `my-${Date.now().toString(36)}`;
            onSaved(saveMyStyle({ ...style, id, name: name.trim() }));
            setName('');
            store.set({ message: `「${name.trim()}」を自分のテンプレートに保存しました。このブラウザに残ります` });
          }}
        >
          自分のテンプレートに保存
        </button>
      </div>
    </details>
  );
}

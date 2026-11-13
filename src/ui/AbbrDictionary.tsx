// 略号の辞書: 標準の略号と自分で足した略号を見る・足す・消す。ラベルの書き方がどう読まれるかも試せる。
// 「整える」→「略号の辞書…」から開く。docs/abbreviation-labels.md
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { track } from '../analytics';
import { ABBREVIATIONS, abbrSource, getAbbr, resolveAbbr, subscribeAbbrs, userAbbrEntries } from '../chem/abbreviations';
import { emptyDoc } from '../chem/model';
import { type EditorStore } from '../editor/store';
import { importText } from '../io/convert';
import { docToSmiles } from '../io/smiles';
import { structureSvg } from '../render/layout';
import { addUserAbbr, loadUserDict, nameProblem, normalizeAbbrSmiles, removeUserAbbr } from './abbrStore';
import { targetFragments } from '../chem/analysis';

const SOURCE: Record<string, string> = { standard: '標準', user: '自分の辞書', label: 'ラベルの読み方' };

/** * で結合する SMILES の小さな絵（* は R として描く） */
function Thumb({ smiles }: { smiles: string }) {
  const svg = useMemo(() => {
    try {
      return structureSvg(importText(emptyDoc(), smiles).doc, 96, 48);
    } catch {
      return '';
    }
  }, [smiles]);
  return <span className="abbr-thumb" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function AbbrDictionary({ store, onClose }: { store: EditorStore; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  // 辞書が変わったら描き直す
  const version = useSyncExternalStore(subscribeAbbrs, () => JSON.stringify(userAbbrEntries()));
  const user = useMemo(() => loadUserDict(), [version]);
  const [query, setQuery] = useState('');
  const [trial, setTrial] = useState('');
  const [name, setName] = useState('');
  const [smiles, setSmiles] = useState('');
  const [error, setError] = useState('');

  const tried = useMemo(() => {
    const t = trial.trim();
    if (!t) return null;
    const n = resolveAbbr(t);
    const def = n ? getAbbr(n) : undefined;
    return n && def ? { name: n, def, source: abbrSource(n)! } : { error: true as const };
  }, [trial, version]);

  const q = query.trim().toLowerCase();
  const match = (n: string, s: string) => !q || n.toLowerCase().includes(q) || s.toLowerCase().includes(q);
  const std = Object.entries(ABBREVIATIONS).filter(([n, d]) => match(n, d.smiles));
  const mine = Object.entries(user).filter(([n, s]) => match(n, s));

  const fromSelection = () => {
    const s = store.get();
    const mols = s.selection.size ? targetFragments(s.doc, s.selection) : [];
    if (mols.length !== 1) return setError('キャンバスで、結合する所を R にした置換基を 1 つ選んでください');
    const r = docToSmiles(s.doc, mols[0]);
    if (!r.smiles) return setError(r.error ?? '選んだ構造の SMILES が作れません');
    setSmiles(r.smiles);
    setError('');
  };

  const add = () => {
    const bad = nameProblem(name);
    if (bad) return setError(bad);
    const n = normalizeAbbrSmiles(smiles);
    if ('error' in n) return setError(n.error);
    addUserAbbr(name.trim(), n.smiles);
    track('abbr:add');
    setName('');
    setSmiles('');
    setError('');
  };

  return (
    <dialog ref={ref} className="about abbr-dict" data-testid="abbr-dict" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>略号の辞書</h2>
      <p className="muted">
        原子のラベルに書いた略号は、標準の略号、自分の辞書、ラベルの読み方の順に探して構造にします。ラベルの読み方は、NHFmoc・CH2OH・CO2tBu・BF3K のような組み合わせを読みます。
        CDX・CDXML に書き出すときは、どの略号にも中身の構造を入れます。
      </p>

      <section>
        <h3>ラベルを試す</h3>
        <input placeholder="例: NHFmoc、CO2tBu、BF3K、HOH2C" value={trial} onChange={(e) => setTrial(e.target.value)} data-testid="abbr-trial" />
        {tried &&
          ('error' in tried ? (
            <p className="warn" data-testid="abbr-trial-result">
              読めません。下で自分の辞書に足すと、ラベルに使えます。
            </p>
          ) : (
            <div className="abbr-row" data-testid="abbr-trial-result">
              <b>{tried.name}</b>
              <small>{SOURCE[tried.source]}</small>
              <Thumb smiles={tried.def.smiles} />
              <code>{tried.def.smiles}</code>
            </div>
          ))}
      </section>

      <section>
        <h3>自分の辞書に足す</h3>
        <div className="abbr-add">
          <input placeholder="名前 例: Nap" value={name} onChange={(e) => setName(e.target.value)} data-testid="abbr-name" />
          <input placeholder="結合する所を * にした SMILES 例: *c1ccc2ccccc2c1" value={smiles} onChange={(e) => setSmiles(e.target.value)} data-testid="abbr-smiles" />
          <button type="button" onClick={fromSelection} title="キャンバスで選んだ置換基の SMILES を入れる。結合する所を R にした置換基を選んでから押す" data-testid="abbr-from-selection">
            選んだ構造から
          </button>
          <button type="button" className="primary" onClick={add} data-testid="abbr-add">
            足す
          </button>
        </div>
        {error && <p className="warn" data-testid="abbr-error">{error}</p>}
      </section>

      <section>
        <h3>一覧</h3>
        <input placeholder="名前・SMILES で探す" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="abbr-query" />
        <h4>自分の辞書（{Object.keys(user).length}）</h4>
        {mine.length === 0 && <p className="muted">まだありません。</p>}
        <ul className="abbr-list" data-testid="abbr-user-list">
          {mine.map(([n, s]) => (
            <li key={n} className="abbr-row" data-testid="abbr-user-row">
              <b>{n}</b>
              <Thumb smiles={s} />
              <code>{s}</code>
              <button type="button" className="danger" onClick={() => removeUserAbbr(n)} data-testid="abbr-remove">
                消す
              </button>
            </li>
          ))}
        </ul>
        <h4>標準（{Object.keys(ABBREVIATIONS).length}）</h4>
        <ul className="abbr-list">
          {std.map(([n, d]) => (
            <li key={n} className="abbr-row">
              <b>{n}</b>
              <small>{d.reversed !== n ? d.reversed : ''}</small>
              <Thumb smiles={d.smiles} />
              <code>{d.smiles}</code>
            </li>
          ))}
        </ul>
      </section>
      <div className="row">
        <button type="button" onClick={() => ref.current?.close()}>
          閉じる
        </button>
      </div>
    </dialog>
  );
}

// 下書きに出す、本文・SI の文字との突き合わせ。
// 文字から補った条件の出所、系統名を OPSIN で構造にして比べた結果と「名前の構造にする」、送った文字（外して補い直せる）
import { useState } from 'react';
import type { Doc } from '../chem/model';
import type { Collected } from '../llm/pdfText';
import { partKey } from '../llm/paperFacts';
import type { SchemeDraft, TextField } from '../scheme/model';

const FIELD_JA: Record<TextField, string> = { reagents: '試薬', solvent: '溶媒', temp: '温度', time: '時間', yield: '収率' };
const WHY_JA = { 'figure-page': '図のページ', compound: '化合物', procedure: '一般手順', mention: '番号が出てくる段落' } as const;

/** 本文・SI の文字を読んだ結果（その場だけ。文書には出所と名前の確かめだけを残す） */
export type PaperRun = {
  schemeId: string;
  collected: Collected;
  removed: string[];
  result: { ok: true; dropped: number } | { ok: false; text: string };
};

export function PaperFactsView({
  doc,
  draft,
  run,
  busy,
  onRefill,
}: {
  doc: Doc;
  draft: SchemeDraft;
  /** この下書きで本文・SI の文字を読んだときの記録（ページを開き直した後は無い） */
  run: PaperRun | null;
  busy: boolean;
  onRefill(removed: string[]): void;
}) {
  const [removed, setRemoved] = useState<string[]>(run?.removed ?? []);
  const label = (id: string) => {
    const c = doc.compounds?.[id];
    return c?.number || c?.nickname || '番号なしの化合物';
  };
  const sources = draft.textSources ?? [];
  const names = draft.nameChecks ?? [];
  if (!run && !sources.length && !names.length) return null;
  const sent = run?.collected.parts ?? [];
  const changed = run && (removed.length !== run.removed.length || removed.some((k) => !run.removed.includes(k)));
  const notes: string[] = [];
  if (run?.result.ok) {
    if (!sent.length) notes.push('本文・SI に送る文字が無かったので、読んでいません。');
    if (run.collected.missing.length) notes.push(`生成物 ${run.collected.missing.join('、')} の合成手順は、本文・SI に見つかりませんでした。`);
    if (run.collected.unlabeled) notes.push(`図の化合物 ${run.collected.unlabeled} 個には番号も名前も無いので、手順を探していません。`);
    if (run.collected.dropped.length) notes.push(`1 回に送れる 3 万文字を超えたので、${run.collected.dropped.length} 段落は送っていません。`);
  }
  return (
    <div className="tts-paper" data-testid="tts-paper">
      {run && !run.result.ok && <p className="warn" data-testid="tts-paper-error">{`本文・SI の文字を読めませんでした。図から読んだ値だけの下書きです。理由: ${run.result.text}`}</p>}
      {notes.length > 0 && (
        <p className="muted" data-testid="tts-paper-summary">
          {notes.join('')}
        </p>
      )}
      {sources.length > 0 && (
        <details className="tts-fold">
          <summary>{`本文・SI から補った所 ${sources.length} 件`}</summary>
          <ul data-testid="tts-text-sources">
            {sources.map((s, i) => (
              <li key={i}>{`${s.stepIndex + 1} 段目の${FIELD_JA[s.field]}: ${s.where || '本文・SI'} から補いました`}</li>
            ))}
          </ul>
        </details>
      )}
      {names.length > 0 && (
        <details className="tts-fold">
          <summary>{`名前と構造の確認 ${names.length} 件`}</summary>
          <ul data-testid="tts-name-checks">
            {names.map((n, i) => (
              <li key={i} data-result={n.result}>
                {nameText(label(n.compoundId), n)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {run && sent.length > 0 && (
        <details className="tts-fold" data-testid="tts-paper-sent">
          <summary>{`AI に送った文字 ${sent.length} 段落`}</summary>
          <p className="muted">外す段落のチェックを外して「補い直す」を押すと、残りの段落だけで読み直します。図は読み直しません。</p>
          <ul className="tts-paper-parts">
            {sent.map((p) => {
              const k = partKey(p);
              return (
                <li key={k}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid="tts-paper-part"
                      checked={!removed.includes(k)}
                      onChange={(e) => setRemoved((r) => (e.target.checked ? r.filter((x) => x !== k) : [...r, k]))}
                    />
                    {`${p.source} p.${p.page}・${WHY_JA[p.why]}${p.label ? ` ${p.label}` : ''}`}
                  </label>
                  <pre>{p.text}</pre>
                </li>
              );
            })}
          </ul>
          <button type="button" data-testid="tts-paper-refill" disabled={busy || !changed || removed.length >= sent.length} onClick={() => onRefill(removed)}>
            補い直す
          </button>
        </details>
      )}
    </div>
  );
}

function nameText(label: string, n: NonNullable<SchemeDraft['nameChecks']>[number]): string {
  const src = `${n.where} の名前「${n.name}」`;
  switch (n.result) {
    case 'match':
      return `${label}: ${src}の構造は、図から読んだ構造と一致しました。立体も同じです`;
    case 'stereo':
      return `${label}: ${src}の構造と、図から読んだ構造の立体が合いません。骨格は同じです`;
    case 'mismatch':
      return `${label}: ${src}の構造と、図から読んだ構造が違います`;
    case 'filled':
      return `${label}: 図から構造を読めなかったので、${src}から構造を入れました`;
    case 'replaced':
      return `${label}: ${src}の構造に置き換えました`;
    case 'unread':
      return `${label}: ${src}を構造にできなかったので、確かめていません`;
  }
}

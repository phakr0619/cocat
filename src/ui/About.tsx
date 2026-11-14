import { useEffect, useRef, useState } from 'react';
import { isOptedOut, setOptOut } from '../analytics';
import { APP_VERSION, FEEDBACK_EMAIL, feedbackLink } from '../feedback';
import { providerLabel } from '../llm/providerLabel';
import { getLlmSettings } from '../llm/settings';
import { AiNotice } from './AiNotice';


/** このツールについて: ベータ版であること、データの扱い、感想の送り先 */
export function About({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [share, setShare] = useState(() => !isOptedOut());
  const to = providerLabel(getLlmSettings().provider).label;
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="about" data-testid="about" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>Cocat（ベータ版）</h2>
      <p>化学構造式と反応スキーム・検討表を描くための、ブラウザで動くエディタです。無料のベータ版として公開しています。</p>
      <p className="muted" data-testid="about-name">名前の Cocat は co-catalyst（助触媒）から。主役の化学者の横で、描く・調べる・まとめる仕事を手伝う道具でありたい、という意味です。</p>
      <h3>データの扱い</h3>
      <ul>
        <li>描いた構造・スキーム・プロジェクトは、このブラウザの中だけに保存し、サーバーへは送りません。計算もブラウザの中で行います。例外は、下に書いた名前の変換だけです。</li>
        <li data-testid="about-opsin">「名前から置く」と分析の「AI で名前を調べる」では、名前を構造にするために、名前だけをこのサイトのサーバーに送ります。サーバーでは、名前を規則で構造にする OPSIN という部品が動いています。名前は保存も記録もしません。</li>
        <li data-testid="about-llm">{`AI の機能を使うときだけ、入力した文章、添付した画像、今のスキームの化合物を、あなたのキーで ${to}に送ります。`}分析の「AI で名前を調べる」で送るのは、その分子の構造です。キーはこのブラウザの中だけに置きます。</li>
        <li data-testid="about-run">{`実験の記録で「メモから作る」を使うと、入力したメモと、仕込みの名前・量・役割を${to}に送ります。実験項を書くときに実験の記録を使うと、仕込みの名前と量、操作の名前、記録の行も送ります。`}時刻とロットは送りません。</li>
        <li data-testid="about-pdf">論文の PDF は、このブラウザの中で pdf.js（Apache-2.0）を使って開き、外へは送りません。{`${to}に送るのは、あなたが選んだ範囲を描いた画像です。図の範囲を探させるために、選んだページ全体の画像を送ることもあります。`}PDF は保存せず、外すか閉じると捨てます。</li>
        <li data-testid="about-pdf-text">{`論文の図から作るときは、本文・SI（Supporting Information）の PDF から、合成手順などの図の化合物の段落と、図のページの文字を探して${to}に送ります。送った文字から条件と収率を補い、名前と構造を確かめます。PDF そのものは送りません。系統名は、構造に直して図と比べるために、名前だけをこのサイトの OPSIN のサーバーに送ります。`}本文・SI から補った条件も、元の論文と見比べてください。送った段落は下書きで見られ、外して補い直せます。</li>
        <li data-testid="about-figure-data">「コピー」した図と書き出した PNG には、あとで Cocat で開き直すためのデータが、目に見えない形で入ります。入るのは、その図に描いてある構造・条件・番号・呼び名などです。スライドを人に渡すと、受け取った人も Cocat で開けます。化合物のメモ、プロジェクトのほかの化合物、化学量論表の量、AI に送った文章は入れません。</li>
        <li>ブラウザのデータを消すと、保存した図やプロジェクトも消えます。大事なものは「保存」やプロジェクトの「一式（zip）」で書き出してください。</li>
        <li>ベータ版のため、保存の形式が変わることがあります。古い形式の文書も開けるようにしますが、念のため書き出しも残してください。</li>
      </ul>
      <h3>AI の答えについて</h3>
      <AiNotice kind="general" />
      <h3>使い方の統計</h3>
      <p>
        どの機能が使われているかを知るため、「検討表を作った」「CDXML で書き出した」のような機能の名前だけを数えています。描いた構造・文字・ファイルの中身は送りません。IP アドレスも記録しません。人数を数える番号はブラウザの中で毎月作り直すので、あなたを特定したり、月をまたいで追ったりはできません。ブラウザで「追跡しないで」（Global Privacy Control）を有効にしていれば送りません。
      </p>
      <label className="check">
        <input
          type="checkbox"
          data-testid="analytics-toggle"
          checked={share}
          onChange={(e) => {
            setOptOut(!e.target.checked);
            setShare(e.target.checked);
          }}
        />
        使い方の統計を送る
      </label>
      <h3>感想・不具合の連絡</h3>
      {feedbackLink() || FEEDBACK_EMAIL ? (
        <>
          <p>
            {feedbackLink() && (
              <a href={feedbackLink()} target="_blank" rel="noreferrer" data-testid="feedback-link">フォームで感想・要望・不具合を送る</a>
            )}
            {feedbackLink() && FEEDBACK_EMAIL && '　'}
            {FEEDBACK_EMAIL && (
              <span data-testid="feedback-email">メール: {FEEDBACK_EMAIL}</span>
            )}
          </p>
          <p className="muted">構造式などの秘密の情報は書かないでください。</p>
        </>
      ) : (
        <p className="muted" data-testid="feedback-pending">連絡先は準備中です。</p>
      )}
      <p className="muted">版: {APP_VERSION}</p>
      <form method="dialog">
        <button type="submit">閉じる</button>
      </form>
    </dialog>
  );
}

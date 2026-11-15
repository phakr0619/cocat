import { useEffect, useRef } from 'react';
import { getLlmSettings } from '../llm/settings';
import { providerLabel } from '../llm/providerLabel';
import { AiNotice } from './AiNotice';

/** 初めて送るときの同意: 何を（設定の送り先に）送るか。onlyName: 名前から構造（送るのは名前だけ） */
export function LlmConsent({ paidKey, onlyName = false, onClose }: { paidKey: boolean; onlyName?: boolean; onClose(ok: boolean): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const ok = useRef(false);
  const to = providerLabel(getLlmSettings().provider).label;
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="about" data-testid="llm-consent" onClose={() => onClose(ok.current)}>
      <h2>{to}に送ります</h2>
      <ul>
        {onlyName && <li data-testid="llm-consent-name">「名前から置く」で送るのは、入力した名前だけです。名前が手元の辞書かライブラリにあるとき、SMILES のとき、OPSIN で読めたときは送りません。OPSIN は、このサイトのサーバーで名前を規則で構造にする部品です。</li>}
        <li>「言葉から作る」で送るのは、入力した文章、添付した画像、今の反応スキームとプロジェクトのライブラリの化合物です。化合物は、番号・呼び名・構造の SMILES を送ります。直すときはそのスキームの試薬・溶媒・温度・時間・収率と書式の名前も、書くときは化学量論表の量も送ります。描いた図のほかの部分は送りません。</li>
        <li data-testid="llm-consent-run">実験の記録で「メモから下書きを作る」ときに送るのは、入力したメモと、仕込みの名前・量・役割、生成物の名前です。実験項を書くときに実験の記録を使うと、仕込みの名前と量、操作の名前、記録の行も送ります。時刻とロットは送りません。</li>
        <li data-testid="llm-consent-struct">分析の「AI で名前を調べる」で送るのは、その分子の構造（SMILES）だけです。押したときだけ送ります。</li>
        <li>送る前に、「送る内容を見る」で中身を確かめられます。</li>
        <li data-testid="llm-consent-image">送れる画像は、権利を持っているものか、AI に入れてよいと許されているものだけです。出版社によっては、論文の図を AI に入れることを認めていません。画像には未発表の構造が写りやすいので、送る前に確かめてください。</li>
        <li data-testid="llm-consent-pdf">{`PDF はこの端末の中で開き、外へは送りません。${to}に送るのは選んだ範囲の画像だけですが、図の範囲を探すときは、選んだページ全体の画像を送ることがあります。`}未発表の論文、投稿前の原稿、学位論文の草稿は、共著者や所属の決まりで AI に入れてよいかを確かめてください。秘密のものは、請求先を付けた有料のキーで送ってください。査読で預かった原稿は送らないでください。多くの出版社が、査読中の原稿を AI に入れることを禁じています。</li>
        <li data-testid="llm-consent-pdf-text">本文・SI の PDF からは、図の化合物の段落の文字も送ります。PDF そのものは送りません。系統名は、構造に直して確かめるために、名前だけをこのサイトの OPSIN のサーバーに送ります。</li>
        {!paidKey && providerLabel(getLlmSettings().provider).freeKeyUsedForTraining && <li className="warn">無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。未発表の構造など秘密の内容は送らないでください。</li>}
      </ul>
      <AiNotice kind="general" />
      <form method="dialog" className="row">
        <button type="submit" data-testid="llm-consent-ok" onClick={() => (ok.current = true)}>
          同意して送る
        </button>
        <button type="submit">やめる</button>
      </form>
    </dialog>
  );
}

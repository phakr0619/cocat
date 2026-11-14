// AI が作ったものへの注意の部品。
// 1 段目: AI の答えは間違っていることがある・アプリの確かめを通っても正しいとは限らない。機能ごとに文を合わせる。会社・モデルの名前は入れない。
// 2 段目（lowResDpi）: PDF の中の画像として貼られた図の解像度が低いとき、さらに足す警告

export type AiNoticeKind =
  /** 文章から作った下書き */
  | 'text'
  /** 画像・PDF から読んだ下書き */
  | 'image'
  /** 言葉で直す（直し方） */
  | 'edit'
  /** 仕上げ */
  | 'finish'
  /** 実験項の文章 */
  | 'write'
  /** 名前から置く（AI が書いた構造） */
  | 'name'
  /** 構造から名前（AI が書いた名前）。checked: 名前を何で構造に戻して確かめたか */
  | 'struct-name'
  /** 実験のメモから作った、実験の記録の下書き */
  | 'run'
  /** 同意の画面・「このツールについて」の一般の文 */
  | 'general';

const WRONG = 'は AI が作ったもので、間違っていることがあります。';
/** AI が付けた名前の注意の 1 文目 */
const NAMED = 'AI が付けた名前です。';

/** 機能ごとの本文 */
function body(kind: AiNoticeKind, checked?: 'opsin' | 'llm'): string {
  switch (kind) {
    case 'text':
      return `この下書き${WRONG}アプリで確かめられるのは、構造として成り立つか・元素の数が合うかなどだけで、文章が指す構造と同じかまでは確かめられません。確定する前に、元の文章と見比べてください。`;
    case 'image':
      return `この下書き${WRONG}アプリで確かめられるのは、構造として成り立つか・元素の数が合うかなどだけで、図と同じ構造かまでは確かめられません。確定する前に、元の図と見比べてください。`;
    case 'edit':
      return 'AI が作った直し方です。アプリは、直した後の形が成り立つかと、指す番号や試薬があるかなどを確かめます。その確かめで問題が無くても、指示のとおりに直せているとは限らないので、確定する前に、直す所を一つずつ元の指示と見比べてください。';
    case 'finish':
      return 'AI が作った仕上げ方です。アプリが確かめて問題が無くても間違っていることがあるので、確定する前に変わる所を確かめてください。投稿先の決まりは AI の知識によるものなので、最後は投稿規定で確かめてください。';
    case 'write':
      return 'AI が書いた文章です。数字がスキームの値から入っているかと、試薬が抜けていないかはアプリが確かめますが、それで問題が無くても間違っていることがあります。化合物名・量・条件が元のスキームと合うかを確かめてから使ってください。';
    case 'name':
      return 'AI が名前から書いた構造です。アプリが確かめるのは、構造として読めるかと、名前に書いた立体（R/S）と合うかなどで、名前が指す構造と同じかどうかは確かめられません。間違っていることがあるので、名前と見比べてから使ってください。';
    case 'struct-name':
      return checked === 'opsin'
        ? `${NAMED}「確かめ済み」は、名前を OPSIN の規則で構造に戻すと、元の構造と同じになったという意味です。それでも正しい名前とは限らないので、論文や報告に使う前に確かめてください。`
        : `${NAMED}${checked === 'llm' ? '規則では読めない名前だったので、AI で構造に戻して比べただけです。AI の答えを AI で確かめたので、' : ''}アプリが確かめて問題が無くても正しいとは限りません。論文や報告に使う前に確かめてください。`;
    case 'run':
      return 'AI がメモから作った下書きです。アプリは、量・温度・時刻の数字がメモにあるかを確かめます。それで問題が無くても、操作の分け方や、どの操作の記録かが違っていることがあります。記録に入れる前に、メモと見比べてください。';
    case 'general':
      return 'AI が作った下書きは、間違っていることがあります。アプリが確かめるのは、構造として成り立つかと、元素の数が合うかなどです。元の図や文章と同じ構造かどうかは確かめられないので、アプリが確かめて問題が無くても正しいとは限りません。確定する前に、元の図や文章と見比べてください。';
  }
}

/** 解像度の低い図への、2 段目の警告の文（約 72 dpi など） */
export const lowResText = (dpi: number) => `この図は解像度が低い（約 ${Math.round(dpi)} dpi）ので、読み違いがいつもより起きやすくなります。`;

/** 下書き（図・文章から）の注意: いつも出す 1 行と、「詳しく」の中身 */
const DRAFT: Record<'image' | 'text', { line: string; more: string }> = {
  image: {
    line: 'AI が図から読んだ下書きです。間違っていることがあるので、元の図と見比べてから確定してください。',
    more: 'アプリが確かめるのは、構造として成り立つかと、元素の数が合うかなどです。図と同じ構造かどうかは確かめられません。',
  },
  text: {
    line: 'AI が文章から作った下書きです。間違っていることがあるので、元の文章と見比べてから確定してください。',
    more: 'アプリが確かめるのは、構造として成り立つかと、元素の数が合うかなどです。文章が指す構造と同じかどうかは確かめられません。',
  },
};

/** AI が作ったものの下に出す注意。lowResDpi があれば（画像から読んだ下書きで）2 段目も出す */
export function AiNotice({ kind, checked, lowResDpi, fromPaper }: { kind: AiNoticeKind; checked?: 'opsin' | 'llm'; lowResDpi?: number | null; fromPaper?: boolean }) {
  if (kind === 'image' || kind === 'text') {
    return (
      <div className="ai-notice" data-testid="ai-notice">
        <p>{DRAFT[kind].line}</p>
        {fromPaper && <p data-testid="ai-notice-paper">本文・SI から補った条件も、元の論文と見比べてください。AI が文字を読み違えたり、別の段の条件を取ったりすることがあります。</p>}
        {typeof lowResDpi === 'number' && <p className="ai-notice-lowres" data-testid="ai-notice-lowres">{lowResText(lowResDpi)}</p>}
        <details className="ai-notice-more" data-testid="ai-notice-more">
          <summary>詳しく</summary>
          <p>{DRAFT[kind].more}</p>
          {kind === 'image' && <p data-testid="ai-notice-image">置換の位置、環の大きさ、くさびの向きは、特に読み違えやすいところです。</p>}
        </details>
      </div>
    );
  }
  return (
    <div className="ai-notice" data-testid="ai-notice">
      <p>{body(kind, checked)}</p>
    </div>
  );
}

// LLM の呼び出しの共通の口
//
// 各社の実装（今は Gemini だけ）はこの形に合わせる

/** 応答の形（JSON Schema の部分集合。各社の構造化出力に渡す） */
export type JsonSchema = { [k: string]: unknown };

export type LlmErrorKind = 'auth' | 'rate' | 'quota' | 'network' | 'timeout' | 'server' | 'invalid-output' | 'refused' | 'aborted';
export type LlmError = { kind: LlmErrorKind; message: string };

/** 使ったトークン。output は考えた分（thinking）を含む（どちらも出力として請求される） */
export type LlmUsage = { input: number; output: number; thinking?: number };
/** 失敗でも、答えが届いていれば usage がある（形が崩れた答えも請求される） */
export type LlmResult<T> = { ok: true; value: T; usage?: LlmUsage } | { ok: false; error: LlmError; usage?: LlmUsage };

/** 何回かの呼び出しの使用量を足す（どれにも無ければ undefined） */
export function addUsage(...us: (LlmUsage | undefined)[]): LlmUsage | undefined {
  const xs = us.filter((u): u is LlmUsage => !!u);
  if (!xs.length) return undefined;
  return { input: xs.reduce((a, u) => a + u.input, 0), output: xs.reduce((a, u) => a + u.output, 0), thinking: xs.reduce((a, u) => a + (u.thinking ?? 0), 0) };
}

export type LlmModel = { id: string; name: string };

/** 一緒に送る画像（base64。送れる形式は LLM_IMAGE_TYPES）。今の画面は 1 枚だけ送るが、口は何枚でも渡せる */
export type LlmImage = { mimeType: string; data: string };

/** 答える前に考える深さ。浅いほど速い（Gemini 3 以降の thinkingLevel） */
export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface LlmProvider {
  id: 'gemini';
  /** 決まった形（JSON Schema）の答えを返させる。形が合っているかの検証は呼ぶ側で必ず行う */
  generateJson<T>(req: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<LlmResult<T>>;
  /** 使えるモデルの一覧（キーが正しいかの確かめにも使う。利用者の文章は送らない） */
  listModels(signal?: AbortSignal): Promise<LlmResult<LlmModel[]>>;
}

/** 失敗の理由を、利用者が次にすることと一緒に言う。無料のキー（paidKey: false）なら、時間切れと上限によくあることを添える */
export function llmErrorText(e: LlmError, paidKey = true): string {
  if (!paidKey && e.kind === 'quota') return `${llmErrorText(e)}。${FREE_QUOTA_NOTE}`;
  if (!paidKey && e.kind === 'timeout') return `${llmErrorText(e)}。${FREE_TIMEOUT_NOTE}`;
  switch (e.kind) {
    case 'auth':
      return 'キーが違うか、使えないキーです。Google AI Studio で作ったキーか確かめてください（使える API を制限していない古いキーは、Gemini に断られます）';
    case 'rate':
      return '短い間に呼びすぎました。少し待ってからやり直してください';
    case 'quota':
      return '使える量の上限に達したか、前払いの残高がありません。Google AI Studio で上限と請求先を確かめてください';
    case 'network':
      return 'つながりませんでした。ネットワークを確かめてください';
    case 'timeout':
      return 'Gemini から時間内に答えが返りませんでした。少し待ってからやり直すか、文章を短くしてください';
    case 'server':
      return 'Gemini の側でエラーが起きました。少し待ってからやり直してください';
    case 'invalid-output':
      return '答えの形が崩れていました。もう一度試すか、文章を短くしてください';
    case 'refused':
      return 'Gemini が答えを返しませんでした（安全のための制限）。言い方を変えてください';
    case 'aborted':
      return 'やめました';
  }
}

/** 無料のキーの上限（gemini-3.8-flash は 1 日 20 回、太平洋時間の 0 時に戻る。m3-llm-design.md 3章） */
const FREE_QUOTA_NOTE = '無料のキーは 1 日に呼べる回数が少なく、よく当たります（日本時間の 16〜17 時ごろに戻ります）。多く使うなら AI Studio で請求先を付けてください';
/** 無料のキーは Google 側の順番待ちで、1 回に 1〜3 分かかることがある */
const FREE_TIMEOUT_NOTE = '無料のキーは Google 側の順番待ちで遅くなりやすく、よくあります。速く使うなら AI Studio で請求先を付けてください';

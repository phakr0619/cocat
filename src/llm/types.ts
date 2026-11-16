// LLM の呼び出しの共通の口
//
// 各社の実装はこの形に合わせる。会社ごとの値は providers.ts

import { providerInfo, showFreeKeyNotes, type ProviderId } from './providers';

/** 応答の形（JSON Schema の部分集合。各社の構造化出力に渡す） */
export type JsonSchema = { [k: string]: unknown };

export type LlmErrorKind = 'auth' | 'rate' | 'quota' | 'network' | 'timeout' | 'server' | 'invalid-output' | 'refused' | 'aborted' | 'model' | 'too-large';
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
  id: ProviderId;
  /** 決まった形（JSON Schema）の答えを返させる。形が合っているかの検証は呼ぶ側で必ず行う */
  generateJson<T>(req: { system: string; user: string; images?: LlmImage[]; schema: JsonSchema; thinking?: ThinkingLevel; signal?: AbortSignal }): Promise<LlmResult<T>>;
  /** 使えるモデルの一覧（キーが正しいかの確かめにも使う。利用者の文章は送らない）。一覧を引けない会社には無い */
  listModels?(signal?: AbortSignal): Promise<LlmResult<LlmModel[]>>;
}

/** 失敗の理由を、利用者が次にすることと一緒に言う。会社ごとに変わる文（キー・上限・時間切れ・サーバー・断り）は接続の型（providers.ts）から引く。無料のキーなら、時間切れと上限によくあることを添える */
export function llmErrorText(e: LlmError, s: { provider: ProviderId; paidKey: boolean }): string {
  const info = providerInfo(s.provider);
  const free = showFreeKeyNotes(s);
  switch (e.kind) {
    case 'auth':
    case 'server':
    case 'refused':
    case 'model':
      return info.errors[e.kind];
    case 'quota':
      return free ? `${info.errors.quota}。${info.freeKeyNotes.quota}` : info.errors.quota;
    case 'timeout':
      return free ? `${info.errors.timeout}。${info.freeKeyNotes.timeout}` : info.errors.timeout;
    case 'rate':
      return '短い間に呼びすぎました。少し待ってからやり直してください';
    case 'network':
      return s.provider === 'relay' ? 'この組織の AI につながりませんでした。ネットワークを確かめるか、サイトを管理している人に伝えてください' : 'つながりませんでした。ネットワークを確かめてください';
    case 'too-large':
      return '一度に送れる大きさを超えました。画像を減らすか、範囲を狭めてください';
    case 'invalid-output':
      return '答えの形が崩れていました。もう一度試すか、文章を短くしてください';
    case 'aborted':
      return 'やめました';
  }
}

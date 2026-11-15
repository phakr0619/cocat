// 接続の型の一覧: AI の会社ごとに変わる値（名前・モデル・画像の条件・注意の文・CSP の送り先）をここに集める。
// 画面と呼び出しの側は、設定の provider でこの一覧を引き、会社の名前や文を直接は書かない。
// 会社を増やすときは、ProviderId と PROVIDERS に足す

import type { LlmErrorKind } from './types';

/** 設定の provider の種類 */
export type ProviderId = 'gemini';

export type ProviderModel = { id: string; name: string; paidOnly?: boolean };

export interface ProviderInfo {
  id: ProviderId;
  /** 会社 */
  company: string;
  /** 製品（モデルの系列） */
  product: string;
  /** 文に差し込む名前。例: 「Google（Gemini）」 */
  label: string;
  /** 無料のキーで送った内容が、会社の製品の改善に使われるか（使われるなら注意を出す） */
  freeKeyUsedForTraining: boolean;
  /** 請求先を設定した有料のキーの区別があるか（「有料のキーを使う」の選択と、有料だけのモデルの注意に関わる） */
  hasPaidKeyOption: boolean;
  /** 考える深さを選べるか */
  thinking: boolean;
  /** 考える深さ「ふつう」の選択肢の文 */
  thinkingMediumLabel: string;
  /** 設定画面で選べるモデル */
  models: ProviderModel[];
  /** 既定のモデル（models の中の 1 つ） */
  defaultModel: string;
  /** 送れる画像の形式 */
  imageTypes: string[];
  /** 受け付ける元の画像のファイルの大きさ（バイト） */
  maxImageFileBytes: number;
  /** 送れない画像のときに出す文 */
  imageTypeText: string;
  imageSizeText: string;
  /** キーの作り方 */
  keyHelp: {
    /** キーを作る場所の名前と URL */
    siteName: string;
    url: string;
    /** 「キーは…この用途のために新しく作ることをおすすめします」の文 */
    advice: string;
  };
  /** 会社ごとに言い方が変わる失敗の文（auth・quota・timeout・server・refused） */
  errors: Record<'auth' | 'quota' | 'timeout' | 'server' | 'refused', string>;
  /** 無料のキーのときに失敗の文へ添える注意 */
  freeKeyNotes: {
    quota: string;
    timeout: string;
  };
  /** 無料のキーの注意の文（それぞれ、無料のキーで使うときだけ出す） */
  freeKeyWarning: {
    /** 各パネルの短い注意 */
    short: string;
    /** 同意の確認の項目 */
    consent: string;
    /** 実験の記録の同意の確認の項目 */
    consentRun: string;
    /** 設定画面の注意 */
    settings: string;
    /** 設定画面の、遅さと回数の説明 */
    settingsLimits: string;
    /** 「言葉から作る」の、遅さと回数の説明 */
    textToSchemeLimits: string;
  };
  /** ブラウザからの送り先（CSP の connect-src に要る。infra/cloudfront.tf と揃える） */
  connectSrc: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  gemini: {
    id: 'gemini',
    company: 'Google',
    product: 'Gemini',
    label: 'Google（Gemini）',
    freeKeyUsedForTraining: true,
    hasPaidKeyOption: true,
    thinking: true,
    thinkingMediumLabel: 'ふつう・Gemini の既定',
    // 開発の間は絞る（2026-10-24 に ai.google.dev の Models と Pricing で確認）。
    // Argon は無料のキーでは使えない。Pro（gemini-3.1-pro-preview）はプレビュー版で、Argon より新しくも安くもないので入れない
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash（速い・安い）' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon（いちばん賢い）', paidOnly: true },
    ],
    // 2026-10-24 の時点の安定版の Flash（ai.google.dev の Models と Deprecations で確認。終了の予定は無い）
    defaultModel: 'gemini-3.8-flash',
    // 2026-10-25 に ai.google.dev の Image understanding で確認。HEIC・HEIF はブラウザで描けないことが多いので、そのまま送る
    imageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
    // Gemini はリクエスト全体で 20 MB まで
    maxImageFileBytes: 20 * 1024 * 1024,
    imageTypeText: '送れる画像は PNG・JPEG・WebP・HEIC・HEIF です',
    imageSizeText: '画像が大きすぎます（20 MB まで）',
    keyHelp: {
      siteName: 'Google AI Studio',
      url: 'https://aistudio.google.com/apikey',
      advice: 'キーは Google AI Studio で、この用途のために新しく作ることをおすすめします。AI Studio で作ったキーは、はじめから Gemini にしか使えません。',
    },
    errors: {
      auth: 'キーが違うか、使えないキーです。Google AI Studio で作ったキーか確かめてください（使える API を制限していない古いキーは、Gemini に断られます）',
      quota: '使える量の上限に達したか、前払いの残高がありません。Google AI Studio で上限と請求先を確かめてください',
      timeout: 'Gemini から時間内に答えが返りませんでした。少し待ってからやり直すか、文章を短くしてください',
      server: 'Gemini の側でエラーが起きました。少し待ってからやり直してください',
      refused: 'Gemini が答えを返しませんでした（安全のための制限）。言い方を変えてください',
    },
    freeKeyNotes: {
      // 無料のキーの上限（gemini-3.8-flash は 1 日 20 回、太平洋時間の 0 時に戻る。m3-llm-design.md 3章）
      quota: '無料のキーは 1 日に呼べる回数が少なく、よく当たります（日本時間の 16〜17 時ごろに戻ります）。多く使うなら AI Studio で請求先を付けてください',
      // 無料のキーは Google 側の順番待ちで、1 回に 1〜3 分かかることがある
      timeout: '無料のキーは Google 側の順番待ちで遅くなりやすく、よくあります。速く使うなら AI Studio で請求先を付けてください',
    },
    freeKeyWarning: {
      short: '無料のキーでは、送った内容が Google の製品の改善に使われます。秘密の内容は送らないでください。',
      consent: '無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。未発表の構造など秘密の内容は送らないでください。',
      consentRun: '無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。未発表の内容など秘密の内容は送らないでください。',
      settings: '無料のキーでは、送った内容が Google の製品の改善に使われ、人が読むこともあります。Gemini API の規約でそう決まっています。未発表の構造など秘密の内容は、請求先を設定したキーで使ってください。',
      settingsLimits:
        '無料のキーは遅く、回数も少なめです。下書き 1 回に 1〜3 分かかることがあり、作れる下書きは 1 日に 10〜20 回ほどです。Gemini 3.8 Flash の無料の枠は 1 日 20 回で、日本時間の 16〜17 時ごろに戻ります。速く多く使うには、AI Studio でキーのプロジェクトに請求先を付けます。有料のキーなら数秒で返ります。',
      textToSchemeLimits: '無料のキーでは、1 回に 1〜3 分かかることがあり、下書きは 1 日に 10〜20 回ほど作れます。速く多く使うには、AI Studio でキーに請求先を付けます。',
    },
    connectSrc: ['https://generativelanguage.googleapis.com'],
  },
};

/** 設定の provider から、接続の型を返す（知らない値は Gemini） */
export function providerInfo(provider: ProviderId = 'gemini'): ProviderInfo {
  return PROVIDERS[provider] ?? PROVIDERS.gemini;
}

/** 設定の provider から、送り先の名前を返す */
export const providerLabel = providerInfo;

/** 保存された値が知っている provider か */
export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/** 無料のキーの注意（送った内容が製品の改善に使われる・遅い・回数が少ない）を出すか。会社ごとに扱いが違う */
export function showFreeKeyNotes(s: { provider: ProviderId; paidKey: boolean }): boolean {
  const info = providerInfo(s.provider);
  return info.hasPaidKeyOption && !s.paidKey && info.freeKeyUsedForTraining;
}

/** 失敗の種類のうち、会社ごとに文が変わるもの */
export type ProviderErrorKind = Extract<LlmErrorKind, keyof ProviderInfo['errors']>;

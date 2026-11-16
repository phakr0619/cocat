// AI の設定（会社・モデル・キー）
//
// - キーは既定でメモリだけ（タブを閉じたら消える）。「このブラウザに覚える」を選んだときだけ localStorage に置く
// - キーは文書・プロジェクト・zip・使い方の統計には入れない（ここ以外から読まない）
// - モデル・有料のキーか・同意したか、は秘密ではないので、いつも覚える

import { createBedrock } from './bedrock';
import { createGemini } from './gemini';
import { isProviderId, providerInfo, type ProviderId, type ProviderModel } from './providers';
import { createRelay, discoverRelay, type RelayInfo } from './relay';
import type { LlmProvider, ThinkingLevel } from './types';

const PREFS_KEY = 'ai-chem-editor:llm';
const KEY_KEY = 'ai-chem-editor:llm-key';

/** 覚えたキーの置き場所。Gemini は今までの名前のまま（覚えたキーを引き継ぐため）、ほかの会社は末尾に会社の名前を付ける */
export function keyStorageName(provider: ProviderId): string {
  return provider === 'gemini' ? KEY_KEY : `${KEY_KEY}:${provider}`;
}

/** 保存する設定（会社ごとのモデルは models に持つ。古い版の model は Gemini のモデルとして読む） */
type Prefs = {
  provider?: unknown;
  models?: Record<string, unknown>;
  model?: unknown;
  paidKey?: unknown;
  consented?: unknown;
  thinking?: unknown;
};

export type LlmSettings = {
  /** 今使う会社。model・apiKey は、その会社の分 */
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** キーをこのブラウザに覚えるか */
  remember: boolean;
  /** 請求先を設定したキー（有料）か。無料のキーでは、送った内容が Google に使われる */
  paidKey: boolean;
  /** 「何を送るか」に同意したか（初めて送るときに聞く） */
  consented: boolean;
  /** 考える深さ。既定は浅い（速い）。正確さとの釣り合いは M3-3 の評価で決める */
  thinking: ThinkingLevel;
  /** このサイトの中継（見つかったときだけ。覚えない） */
  relay: RelayInfo | null;
};

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** 会社ごとに覚えたモデル（今の provider の分を state.model に持つので、ほかの会社の分はここに残す） */
let models: Partial<Record<ProviderId, string>> = {};
/** 会社ごとのキー（このページを開いている間だけ。覚えていないキーも、会社を切り替えて戻ったときに残すため） */
let keys: Partial<Record<ProviderId, string>> = {};

/** 中継を使う会社として選ぶか。まだ会社を選んだことが無い人と、前に中継を選んだ人が対象。会社を自分で切り替えたら false */
let relayPreferred = true;
/** 中継を自動で選んだ（利用者が選んだのではない）。この間は provider を覚えない */
let autoRelay = false;
/** 前に会社として中継を選んで覚えていた */
let relaySaved = false;

function load(): LlmSettings {
  const s = storage();
  let prefs: Prefs = {};
  try {
    const p: unknown = JSON.parse(s?.getItem(PREFS_KEY) ?? '{}');
    if (p && typeof p === 'object') prefs = p as Prefs;
  } catch {
    /* 壊れていれば既定に戻す */
  }
  const saved0 = isProviderId(prefs.provider) ? prefs.provider : undefined;
  // 中継は見つかってから選ぶ（discoverRelay のあと applyRelay）。それまでは Gemini
  const provider: ProviderId = saved0 && saved0 !== 'relay' ? saved0 : 'gemini';
  relayPreferred = saved0 === undefined || saved0 === 'relay';
  relaySaved = saved0 === 'relay';
  autoRelay = false;
  models = {};
  keys = {};
  const saved = prefs.models && typeof prefs.models === 'object' ? prefs.models : {};
  for (const id of Object.keys(saved)) {
    const m = saved[id];
    if (isProviderId(id) && typeof m === 'string' && m) models[id] = m;
  }
  // 古い版の model は、Gemini のモデル
  if (!models.gemini && typeof prefs.model === 'string' && prefs.model) models.gemini = prefs.model;
  const key = s?.getItem(keyStorageName(provider)) ?? '';
  return {
    provider,
    model: models[provider] ?? providerInfo(provider).defaultModel,
    apiKey: key,
    remember: !!key,
    paidKey: prefs.paidKey === true,
    consented: prefs.consented === true,
    thinking: prefs.thinking === 'medium' || prefs.thinking === 'high' ? prefs.thinking : 'low',
    relay: null,
  };
}

let state: LlmSettings = load();
const listeners = new Set<() => void>();

export function getLlmSettings(): LlmSettings {
  return state;
}

export function subscribeLlmSettings(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 会社の既定のモデル。中継は、見つかった一覧の先頭 */
function defaultModelOf(provider: ProviderId, relay: RelayInfo | null): string {
  return provider === 'relay' ? (relay?.models[0]?.id ?? '') : providerInfo(provider).defaultModel;
}

/** 会社を切り替える（今の会社のモデルとキーを残し、切り替え先の分を読む） */
function switchProvider(provider: ProviderId) {
  const s = storage();
  models = { ...models, [state.provider]: state.model };
  keys = { ...keys, [state.provider]: state.apiKey };
  const stored = s?.getItem(keyStorageName(provider)) ?? '';
  const key = keys[provider] ?? stored;
  const m = models[provider];
  // 中継のモデルは、中継が今も許しているものだけ使う
  const model = provider === 'relay' ? (m && state.relay?.models.some((x) => x.id === m) ? m : defaultModelOf(provider, state.relay)) : (m ?? defaultModelOf(provider, state.relay));
  state = { ...state, provider, model, apiKey: key, remember: !!stored };
}

function save() {
  const s = storage();
  keys = { ...keys, [state.provider]: state.apiKey };
  if (!s) return;
  models = { ...models, [state.provider]: state.model };
  // 中継を自動で選んだだけのときは、会社を覚えない（利用者が選ぶまで、次も自動で選ぶ）
  s.setItem(PREFS_KEY, JSON.stringify({ ...(autoRelay ? {} : { provider: state.provider }), models, paidKey: state.paidKey, consented: state.consented, thinking: state.thinking }));
  const name = keyStorageName(state.provider);
  if (state.remember && state.apiKey && providerInfo(state.provider).needsKey) s.setItem(name, state.apiKey);
  else s.removeItem(name);
}

export function setLlmSettings(patch: Partial<Omit<LlmSettings, 'relay'>>) {
  const { provider, ...rest } = patch;
  if (provider && isProviderId(provider)) {
    // 利用者が会社を選んだ。中継を自動では選ばなくなる
    relayPreferred = false;
    autoRelay = false;
    if (provider !== state.provider) switchProvider(provider);
  }
  state = { ...state, ...rest, apiKey: (rest.apiKey ?? state.apiKey).trim() };
  save();
  listeners.forEach((f) => f());
}

/** 中継が見つかった（null なら無い）。まだ会社を選んでいない人は、中継を選ぶ。中継が消えていたら Gemini に戻す */
export function applyRelay(found: RelayInfo | null) {
  state = { ...state, relay: found };
  if (found && relayPreferred && state.provider !== 'relay' && (relaySaved || !state.apiKey)) {
    // 前に中継を選んでいた人は、そのまま。まだ選んでいない人は自動（覚えない）
    autoRelay = !relaySaved;
    switchProvider('relay');
  } else if (found && state.provider === 'relay' && !found.models.some((m) => m.id === state.model)) {
    state = { ...state, model: found.models[0].id };
  } else if (!found && state.provider === 'relay') {
    switchProvider('gemini');
  }
  listeners.forEach((f) => f());
}

/** 起動のときに 1 回、このサイトの中継を探す。失敗は何も出さない */
export function startRelayDiscovery(f?: typeof fetch) {
  void discoverRelay(f).then(applyRelay);
}

/** 今の会社で選べるモデル（中継は、見つかった一覧） */
export function providerModels(s: Pick<LlmSettings, 'provider' | 'relay'>): ProviderModel[] {
  return s.provider === 'relay' ? (s.relay?.models ?? []) : providerInfo(s.provider).models;
}

/** AI を使える状態か。キーが要る会社はキーがあるとき、中継は見つかっているとき */
export function llmReady(s: Pick<LlmSettings, 'provider' | 'apiKey' | 'relay'> = state): boolean {
  return s.provider === 'relay' ? !!s.relay : !!s.apiKey;
}

/** キーを消す（メモリとブラウザの両方から） */
export function forgetLlmKey() {
  setLlmSettings({ apiKey: '', remember: false });
}

/** 今の設定で呼び出す口。使える状態でなければ（キーが無い・中継が無い）null */
export function llmProvider(s = state, f?: typeof fetch): LlmProvider | null {
  if (!llmReady(s)) return null;
  const model = s.model || defaultModelOf(s.provider, s.relay);
  switch (s.provider) {
    case 'relay':
      return createRelay({ model, fetch: f });
    case 'gemini':
      return createGemini({ apiKey: s.apiKey, model, fetch: f });
    case 'bedrock':
      return createBedrock({ apiKey: s.apiKey, model, fetch: f });
  }
}

/** テストで読み込み直すため */
export function reloadLlmSettings() {
  state = load();
}

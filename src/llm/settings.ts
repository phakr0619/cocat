// AI の設定（会社・モデル・キー）
//
// - キーは既定でメモリだけ（タブを閉じたら消える）。「このブラウザに覚える」を選んだときだけ localStorage に置く
// - キーは文書・プロジェクト・zip・使い方の統計には入れない（ここ以外から読まない）
// - モデル・有料のキーか・同意したか、は秘密ではないので、いつも覚える

import { createGemini } from './gemini';
import { isProviderId, providerInfo, type ProviderId } from './providers';
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

function load(): LlmSettings {
  const s = storage();
  let prefs: Prefs = {};
  try {
    const p: unknown = JSON.parse(s?.getItem(PREFS_KEY) ?? '{}');
    if (p && typeof p === 'object') prefs = p as Prefs;
  } catch {
    /* 壊れていれば既定に戻す */
  }
  const provider: ProviderId = isProviderId(prefs.provider) ? prefs.provider : 'gemini';
  models = {};
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

export function setLlmSettings(patch: Partial<Omit<LlmSettings, 'provider'>>) {
  state = { ...state, ...patch, apiKey: (patch.apiKey ?? state.apiKey).trim() };
  const s = storage();
  if (s) {
    models = { ...models, [state.provider]: state.model };
    s.setItem(PREFS_KEY, JSON.stringify({ provider: state.provider, models, paidKey: state.paidKey, consented: state.consented, thinking: state.thinking }));
    const name = keyStorageName(state.provider);
    if (state.remember && state.apiKey) s.setItem(name, state.apiKey);
    else s.removeItem(name);
  }
  listeners.forEach((f) => f());
}

/** キーを消す（メモリとブラウザの両方から） */
export function forgetLlmKey() {
  setLlmSettings({ apiKey: '', remember: false });
}

/** 今の設定で呼び出す口。キーが無ければ null */
export function llmProvider(s = state, f?: typeof fetch): LlmProvider | null {
  if (!s.apiKey) return null;
  const model = s.model || providerInfo(s.provider).defaultModel;
  switch (s.provider) {
    case 'gemini':
      return createGemini({ apiKey: s.apiKey, model, fetch: f });
  }
}

/** テストで読み込み直すため */
export function reloadLlmSettings() {
  state = load();
}

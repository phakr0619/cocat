// AI の設定（会社・モデル・キー）
//
// - キーは既定でメモリだけ（タブを閉じたら消える）。「このブラウザに覚える」を選んだときだけ localStorage に置く
// - キーは文書・プロジェクト・zip・使い方の統計には入れない（ここ以外から読まない）
// - モデル・有料のキーか・同意したか、は秘密ではないので、いつも覚える

import { createGemini, DEFAULT_GEMINI_MODEL } from './gemini';
import type { ProviderId } from './providerLabel';
import type { LlmProvider, ThinkingLevel } from './types';

const PREFS_KEY = 'ai-chem-editor:llm';
const KEY_KEY = 'ai-chem-editor:llm-key';

export type LlmSettings = {
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

function load(): LlmSettings {
  const s = storage();
  let prefs: Partial<LlmSettings> = {};
  try {
    prefs = JSON.parse(s?.getItem(PREFS_KEY) ?? '{}') as Partial<LlmSettings>;
  } catch {
    /* 壊れていれば既定に戻す */
  }
  const saved = s?.getItem(KEY_KEY) ?? '';
  return {
    provider: 'gemini',
    model: typeof prefs.model === 'string' && prefs.model ? prefs.model : DEFAULT_GEMINI_MODEL,
    apiKey: saved,
    remember: !!saved,
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
    s.setItem(PREFS_KEY, JSON.stringify({ model: state.model, paidKey: state.paidKey, consented: state.consented, thinking: state.thinking }));
    if (state.remember && state.apiKey) s.setItem(KEY_KEY, state.apiKey);
    else s.removeItem(KEY_KEY);
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
  return createGemini({ apiKey: s.apiKey, model: s.model || DEFAULT_GEMINI_MODEL, fetch: f });
}

/** テストで読み込み直すため */
export function reloadLlmSettings() {
  state = load();
}

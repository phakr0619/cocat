// 送り先の名前（利用者に見える文に差し込む）。設定の provider から決める。
// 今は Gemini だけだが、会社を増やすときはここに足す

/** 設定の provider の種類 */
export type ProviderId = 'gemini';

export interface ProviderLabel {
  /** 会社 */
  company: string;
  /** 製品（モデルの系列） */
  product: string;
  /** 文に差し込む名前。例: 「Google（Gemini）」 */
  label: string;
  /** 無料のキーで送った内容が、会社の製品の改善に使われるか（使われるなら注意を出す） */
  freeKeyUsedForTraining: boolean;
}

const LABELS: Record<ProviderId, ProviderLabel> = {
  gemini: { company: 'Google', product: 'Gemini', label: 'Google（Gemini）', freeKeyUsedForTraining: true },
};

/** 設定の provider から、送り先の名前を返す */
export function providerLabel(provider: ProviderId = 'gemini'): ProviderLabel {
  return LABELS[provider] ?? LABELS.gemini;
}

/** 無料のキーの注意（送った内容が製品の改善に使われる・遅い・回数が少ない）を出すか。会社ごとに扱いが違う */
export function showFreeKeyNotes(s: { provider: ProviderId; paidKey: boolean }): boolean {
  return !s.paidKey && providerLabel(s.provider).freeKeyUsedForTraining;
}

// 使い方の統計（個人を特定しない）。docs/hosting.md の「アクセス解析」
//
// - 送るのは「どの機能を使ったか」の名前だけ。描いた構造・文字・ファイルの中身は送らない
// - 送り先は自分のサイトの /e（CloudFront が 204 を返すだけ。infra/analytics.tf）。ログに IP アドレス・Cookie・ブラウザ名は残さない
// - 人数を数えるための番号は、ブラウザの中で作る乱数で、毎月作り直す（月をまたいで同じ人を追えない）
// - 「このツールについて」で止められる。ブラウザの「追跡しないで」（Global Privacy Control）が有効なら送らない
// - 公開のビルド（VITE_ANALYTICS=1）だけで動く。手元の開発やテストでは何も送らない

import { APP_VERSION as VERSION } from './feedback';

const ENABLED = import.meta.env.VITE_ANALYTICS === '1';
const OPT_OUT_KEY = 'ai-chem-editor:analytics-optout';
const ID_KEY = 'ai-chem-editor:analytics-id';

/** 送る名前に使える文字（機能の名前だけを送るための歯止め） */
const NAME = /^[a-z0-9][a-z0-9:_-]{0,47}$/;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function isOptedOut(): boolean {
  return storage()?.getItem(OPT_OUT_KEY) === '1';
}

export function setOptOut(out: boolean) {
  const s = storage();
  if (!s) return;
  if (out) {
    s.setItem(OPT_OUT_KEY, '1');
    s.removeItem(ID_KEY);
  } else s.removeItem(OPT_OUT_KEY);
}

/** この機能の統計を送るか（送らない理由があれば false） */
export function analyticsActive(): boolean {
  if (!ENABLED || isOptedOut()) return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return !nav.globalPrivacyControl;
}

const month = (d = new Date()) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** 毎月作り直す匿名の番号（「何人が使っているか」を数えるためだけ） */
export function monthlyId(now = new Date(), rand = () => crypto.getRandomValues(new Uint32Array(2))): string {
  const s = storage();
  const m = month(now);
  const saved = s?.getItem(ID_KEY);
  if (saved?.startsWith(`${m}-`)) return saved;
  const [a, b] = rand();
  const id = `${m}-${a.toString(36)}${b.toString(36)}`;
  s?.setItem(ID_KEY, id);
  return id;
}

/** タブごとの番号（同じ人の同じ作業のまとまりを数える。タブを閉じると消える） */
let sessionId: string | null = null;
const session = () => (sessionId ??= Math.random().toString(36).slice(2, 10));

const sent = new Set<string>();

/** 送る URL（テスト用に分けている） */
export function eventUrl(name: string, id: string, sid: string): string {
  const q = new URLSearchParams({ n: name, u: id, s: sid, v: VERSION });
  return `/e?${q.toString()}`;
}

/**
 * 機能を使ったことを送る。once なら、同じタブでは1回だけ（ツールの選択など、回数より「使ったか」を知りたいもの）
 */
export function track(name: string, opt: { once?: boolean } = {}) {
  if (!NAME.test(name)) return;
  if (opt.once) {
    if (sent.has(name)) return;
    sent.add(name);
  }
  if (!analyticsActive()) return;
  try {
    void fetch(eventUrl(name, monthlyId(), session()), { method: 'GET', keepalive: true, cache: 'no-store', credentials: 'omit' }).catch(() => {});
  } catch {
    // 送れなくても使うのには困らない
  }
}

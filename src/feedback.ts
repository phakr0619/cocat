// 感想の送り先（Google フォーム）。公開のビルドで VITE_FEEDBACK_URL に入れる。手順は docs/hosting.md の「感想の送り先」
//
// URL の中の {version} は、エディタの版に置き換える（フォームの「版」の欄に自動で入れるため。
// Google フォームの「事前入力した URL を取得」で作った URL の、版の欄の値を {version} にしておく）

export const FEEDBACK_URL = (import.meta.env.VITE_FEEDBACK_URL as string | undefined) ?? '';
export const FEEDBACK_EMAIL = (import.meta.env.VITE_FEEDBACK_EMAIL as string | undefined) ?? '';
export const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev';

/** {version} を版に置き換えた URL。http(s) でなければ使わない（空を返す） */
export function feedbackLink(url = FEEDBACK_URL, version = APP_VERSION): string {
  if (!/^https:\/\//.test(url)) return '';
  return url.replaceAll('{version}', encodeURIComponent(version));
}

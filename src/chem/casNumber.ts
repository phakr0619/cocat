// CAS 番号の形と検査数字
//
// 番号と構造の対応は外のデータベースにしか無く、利用条件が決まるまで使わない。ここでは手元で分かることだけを確かめる

export type CasCheck = { ok: true; cas: string } | { ok: false; cas: string; expected: number };

/**
 * CAS 番号の形（2〜7 桁-2 桁-1 桁）なら、検査数字を確かめる。形でなければ null。
 * 検査数字: 検査数字の前の数字を、右から 1, 2, 3… 倍して足し、10 で割った余り
 */
export function checkCasNumber(text: string): CasCheck | null {
  const m = text.normalize('NFKC').trim().replace(/[‐-―−]/g, '-').match(/^(\d{2,7})-(\d{2})-(\d)$/);
  if (!m) return null;
  const body = m[1] + m[2];
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i + 1);
  const expected = sum % 10;
  const cas = `${Number(m[1])}-${m[2]}-${m[3]}`;
  return expected === Number(m[3]) ? { ok: true, cas } : { ok: false, cas, expected };
}

// 名前 → 構造を、規則で変換する OPSIN（MIT）で引く。OPSIN は Java なので、このサイトのサーバー（Lambda、/api/opsin）で動かす。
// 送るのは名前だけ。サーバーは名前を残さない（server/opsin、docs/opsin-server.md）。
// サーバーが無いとき（手元の開発・まだ置いていないとき）は null を返し、呼んだ側は今までどおり AI に回す

export type OpsinStatus = 'SUCCESS' | 'WARNING' | 'FAILURE';

export interface OpsinAnswer {
  status: OpsinStatus;
  smiles?: string;
  /** 変換できなかった理由や、気をつけること（英語） */
  message?: string;
}

/** 名前の並びを変換する。サーバーに届かなければ null */
export type OpsinClient = (names: string[], signal?: AbortSignal) => Promise<OpsinAnswer[] | null>;

export const OPSIN_PATH = '/api/opsin';
/** サーバーの決まり（server/opsin の OpsinHandler と同じ値） */
export const OPSIN_MAX_NAMES = 50;
export const OPSIN_MAX_LENGTH = 1000;

/** 一度「無い」と分かったら、このページを開いているあいだは呼ばない */
let missing = false;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 届いた答えの形を確かめる */
export function parseOpsinAnswers(raw: unknown, count: number): OpsinAnswer[] | null {
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length !== count) return null;
  const out: OpsinAnswer[] = [];
  for (const r of results) {
    const o = r as Record<string, unknown>;
    if (o?.status !== 'SUCCESS' && o?.status !== 'WARNING' && o?.status !== 'FAILURE') return null;
    out.push({
      status: o.status,
      ...(typeof o.smiles === 'string' && o.status !== 'FAILURE' ? { smiles: o.smiles } : {}),
      ...(typeof o.message === 'string' && o.message ? { message: o.message } : {}),
    });
  }
  return out;
}

/** このサイトのサーバーの OPSIN を呼ぶ */
export const httpOpsin: OpsinClient = async (names, signal) => {
  if (missing || !names.length) return null;
  if (names.length > OPSIN_MAX_NAMES || names.some((n) => !n.trim() || n.length > OPSIN_MAX_LENGTH || /[\r\n]/.test(n))) return null;
  const body = names.map((n) => n.trim()).join('\n');
  try {
    const res = await fetch(OPSIN_PATH, {
      method: 'POST',
      // CloudFront から Lambda へは署名して渡すので、本文のハッシュを添える（AWS の決まり）
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-amz-content-sha256': await sha256Hex(body) },
      body,
      signal,
    });
    if (res.status === 404 || res.status === 405 || !(res.headers.get('content-type') ?? '').includes('json')) {
      missing = true;
      return null;
    }
    if (!res.ok) return null;
    return parseOpsinAnswers(await res.json(), names.length);
  } catch {
    return null;
  }
};

let client: OpsinClient = httpOpsin;

export const getOpsin = (): OpsinClient => client;

/** テストで差し替える（null で元に戻す） */
export function setOpsinClient(c: OpsinClient | null) {
  client = c ?? httpOpsin;
  missing = false;
}

/** 1 つの名前を引く。構造が決まれば SMILES と注意、決まらなければ null */
export async function opsinName(name: string, signal?: AbortSignal): Promise<{ smiles: string; warning?: string } | null> {
  const r = await client([name], signal);
  const a = r?.[0];
  if (!a?.smiles) return null;
  return { smiles: a.smiles, ...(a.status === 'WARNING' ? { warning: `OPSIN の注意: ${a.message ?? '名前の一部（立体など）を読み取れませんでした'}` } : {}) };
}

// 「つながるか試す」: 一覧を引ける会社は一覧で、引けない会社は短い質問を 1 回送って確かめる

import type { LlmError, LlmProvider } from './types';

export type ConnectionResult = { ok: true; /** 一覧で確かめたときの、使えるモデルの ID。質問で確かめたときは null */ modelIds: string[] | null } | { ok: false; error: LlmError };

export async function testConnection(p: LlmProvider): Promise<ConnectionResult> {
  if (p.listModels) {
    const r = await p.listModels();
    return r.ok ? { ok: true, modelIds: r.value.map((m) => m.id) } : { ok: false, error: r.error };
  }
  const r = await p.generateJson<{ ok: boolean }>({
    system: 'Reply with the JSON tool input only.',
    user: 'Return {"ok": true}.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  });
  return r.ok ? { ok: true, modelIds: null } : { ok: false, error: r.error };
}

// Amazon Bedrock の中継（Lambda）の中身。Lambda の道具（awslambda）には頼らず、出力と時計は呼ぶ側から受ける（index.ts が本物をつなぐ）
//
// 決まり（本物の AWS で確かめた）:
// - 受け付けたら、Bedrock を呼ぶ前に状態 200 と空白 1 つを書く。CloudFront は 30 秒以内に最初の 1 バイトが来ないと切り、何も書かずに閉じると 502 にする
// - 待つあいだは 10 秒ごとに空白を書く。最後に LlmResult の JSON を 1 つ書いて閉じる
// - 403 と 404 は返さない。CloudFront が index.html に置き換えてしまう
// - 記録するのは、時刻・モデル・成否・トークン数・かかった時間だけ。文章と答えは記録しない

import { buildConverseBody, classifyBedrockError, parseConverseResponse } from '../../../src/llm/bedrockConverse';
import { BEDROCK_DEFAULT_MAX_TOKENS } from '../../../src/llm/bedrock';
import { PROVIDERS } from '../../../src/llm/providers';
import type { JsonSchema, LlmError, LlmImage, LlmResult } from '../../../src/llm/types';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const HEARTBEAT_MS = 10_000;
export const MAX_IMAGES = 20;

export type RelayRequest = { method: string; body: string | null; isBase64Encoded?: boolean };

export interface RelayOut {
  /** 状態と見出しを決める。最初の write の前に 1 回だけ呼ぶ */
  start(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

/** SDK の ConverseCommand に渡す入力。画像の中身は Uint8Array */
export type ConverseInput = Omit<ReturnType<typeof buildConverseBody>, 'messages'> & { modelId: string; messages: unknown[] };

export interface RelayDeps {
  region: string;
  models: string[];
  /** Bedrock の Converse を呼ぶ。失敗は throw（SDK の例外と同じ name・$metadata を持つ） */
  converse(input: ConverseInput): Promise<unknown>;
  setInterval(f: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  now(): number;
  log(line: string): void;
}

type Parsed = { model: string; system: string; user: string; images: LlmImage[]; schema: JsonSchema };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseRequest(text: string): Parsed | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return '本文が JSON ではありません';
  }
  if (!isObj(raw)) return '本文が JSON のオブジェクトではありません';
  const { model, system, user, images, schema } = raw;
  if (typeof model !== 'string' || !model) return 'model がありません';
  if (typeof system !== 'string' || typeof user !== 'string') return 'system と user は文字列です';
  if (!isObj(schema)) return 'schema がありません';
  const imgs: LlmImage[] = [];
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) return 'images の形が違います';
    for (const i of images) {
      if (!isObj(i) || typeof i.mimeType !== 'string' || typeof i.data !== 'string') return 'images の形が違います';
      imgs.push({ mimeType: i.mimeType, data: i.data });
    }
  }
  return { model, system, user, images: imgs, schema };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

/** 1 つの要求を処理する。どの道でも、閉じる前に必ず 1 回は書く */
export async function handle(req: RelayRequest, out: RelayOut, deps: RelayDeps): Promise<void> {
  const reply = (status: number, json: unknown) => {
    out.start(status, JSON_HEADERS);
    out.write(JSON.stringify(json));
    out.end();
  };
  const fail = (status: number, kind: LlmError['kind'], message: string) => reply(status, { ok: false, error: { kind, message } });

  if (req.method === 'GET') return reply(200, { provider: 'bedrock', region: deps.region, models: deps.models });
  if (req.method !== 'POST') return fail(405, 'invalid-output', 'POST だけ受け付けます');

  const text = req.body === null ? '' : req.isBase64Encoded ? Buffer.from(req.body, 'base64').toString('utf8') : req.body;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, 'too-large', '送る内容が大きすぎます');
  const p = parseRequest(text);
  if (typeof p === 'string') return fail(400, 'invalid-output', p);
  if (!deps.models.includes(p.model)) return fail(400, 'model', 'この中継で使えるモデルではありません');

  // 受け付けた。Bedrock の答えを待つあいだ、空白を送って接続を保つ
  out.start(200, JSON_HEADERS);
  out.write(' ');
  const started = deps.now();
  const timer = deps.setInterval(() => out.write(' '), HEARTBEAT_MS);

  let result: LlmResult<unknown>;
  try {
    const body = buildConverseBody({ system: p.system, user: p.user, images: p.images, schema: p.schema, maxTokens: PROVIDERS.bedrock.models.find((m) => m.id === p.model)?.maxTokens ?? BEDROCK_DEFAULT_MAX_TOKENS });
    // SDK は画像の中身を Uint8Array で受ける
    const messages = body.messages.map((m) => ({
      ...m,
      content: m.content.map((c) => ('image' in c ? { image: { format: c.image.format, source: { bytes: Buffer.from(c.image.source.bytes, 'base64') } } } : c)),
    }));
    const res = await deps.converse({ ...body, messages, modelId: p.model });
    result = parseConverseResponse(res);
  } catch (e) {
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    result = { ok: false, error: classifyBedrockError(err.$metadata?.httpStatusCode ?? 500, { message: err.message }, err.name).error };
  } finally {
    deps.clearInterval(timer);
  }

  out.write(JSON.stringify(result));
  out.end();
  deps.log(
    JSON.stringify({
      t: new Date(started).toISOString(),
      model: p.model,
      ok: result.ok,
      ...(result.ok ? {} : { kind: result.error.kind }),
      ...(result.usage ? { input: result.usage.input, output: result.usage.output } : {}),
      ms: deps.now() - started,
    }),
  );
}

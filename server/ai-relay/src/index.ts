// Lambda の入口。関数 URL（RESPONSE_STREAM）の応答を、handler.ts の出力につなぐ。中身の決まりは handler.ts

import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { handle, type RelayRequest } from './handler';

type ResponseStream = { write(chunk: string): void; end(): void };
declare const awslambda: {
  streamifyResponse(f: (event: LambdaUrlEvent, stream: ResponseStream) => Promise<void>): unknown;
  HttpResponseStream: { from(stream: ResponseStream, meta: { statusCode: number; headers: Record<string, string> }): ResponseStream };
};
type LambdaUrlEvent = { requestContext?: { http?: { method?: string } }; body?: string; isBase64Encoded?: boolean };

const region = process.env.AI_RELAY_REGION || 'ap-northeast-1';
const models = (process.env.AI_RELAY_MODELS ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const client = new BedrockRuntimeClient({ region });

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const req: RelayRequest = { method: event.requestContext?.http?.method ?? 'GET', body: event.body ?? null, isBase64Encoded: event.isBase64Encoded };
  let stream: ResponseStream = responseStream;
  await handle(
    req,
    {
      start: (statusCode, headers) => {
        stream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers });
      },
      write: (chunk) => stream.write(chunk),
      end: () => stream.end(),
    },
    {
      region,
      models,
      converse: (input) => client.send(new ConverseCommand(input as unknown as ConverseCommandInput)),
      setInterval: (f, ms) => setInterval(f, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      now: () => Date.now(),
      log: (line) => console.log(line),
    },
  );
});

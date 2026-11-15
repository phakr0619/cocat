# Amazon Bedrock で AI の機能を使う（2026-11-15）

Cocat の AI の機能（言葉から作る・言葉で直す・実験項を書く など）は、Gemini のほかに Amazon Bedrock でも使える。ブラウザから Bedrock の Converse API を直接呼び、キーは使う人が自分の Bedrock の API キーを貼る。

## 使えるもの

| 項目 | 値 |
| --- | --- |
| リージョン | 東京（`ap-northeast-1`）だけ |
| モデル | Claude Haiku 5.5（`jp.anthropic.claude-haiku-5-5`）、Claude Opus 5.5（`jp.anthropic.claude-opus-5-5`）。一覧に無いモデルの ID も入れられる |
| キー | Bedrock の API キー（`Authorization: Bearer` で送る） |
| 画像 | PNG・JPEG・WebP。HEIC・HEIF は送れない |
| 考える深さ | 選べない（下の「答えの形」） |

モデルの ID の `jp.` は日本の中のリージョンをまたぐ推論プロファイルを指す。ブラウザが呼ぶのは東京の送り先だけで、東京と大阪のどちらで動かすかは AWS が決める。

## 使い方

1. AWS のコンソールで、Bedrock の短い期限の API キーを作る（[Amazon Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)）
2. Cocat の「AI の設定」で、会社を「AWS（Amazon Bedrock）」にする
3. モデルを選び、キーを貼る
4. 「つながるか試す」を押す。短い問いを 1 回送るので、料金が少しかかる（1 円に満たない）

短い期限のキーは長くても 12 時間で使えなくなる。切れたら作り直して貼り直す。長い期限のキーはブラウザに置く使い方には勧めない。

## うまくいかないとき

| 出る文 | 見直すこと |
| --- | --- |
| キーが違うか、期限が切れているか… | キーの期限。キーを作った IAM の主体に、そのモデルを呼ぶ権限（`bedrock:InvokeModel`）があるか |
| このモデルは、見つからないか、このアカウントではまだ使えません… | モデルの ID。`aws bedrock list-inference-profiles --region ap-northeast-1` で、`jp.` のプロファイルを調べられる。Anthropic のモデルは、コンソールで利用の申し込み（ユースケースの書式）が要ることがあり、出してから 15 分ほどで使えるようになる。新しいモデルは、申し込みとは別に、アカウントによっては使えないことがある |
| AWS の使える量の上限に達しました | Service Quotas の Bedrock の上限 |

組織の SCP でリージョンを絞っているときは、権限があっても断られることがある。`jp.` のプロファイルは東京と大阪へ回すので、大阪でも Bedrock の呼び出しを許す必要がある。

- 回す先は `aws bedrock get-inference-profile --region ap-northeast-1 --inference-profile-identifier <ID>` で調べられる
- 大阪で許すのは、Bedrock の呼び出し（`bedrock:InvokeModel`）だけでよい。リージョン全体を許す必要はない

## 送るもの

- 送るものは Gemini のときと同じ。初めて送るときに、同意の画面で確かめる
- 送り先は Bedrock の東京の送り先（`https://bedrock-runtime.ap-northeast-1.amazonaws.com`）だけ。CSP の `connect-src` で、ほかへは送れないようにしてある（`infra/cloudfront.tf`）
- キーは Bedrock の API にだけ送る。文書・プロジェクト・書き出し・使い方の統計には入れない
- AWS が送った内容をどう扱うかは、AWS の資料を見る
  - [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
  - [Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)

## 答えの形

Cocat は機能ごとに決まった形の JSON で答えを受け取る。Bedrock では、答え用のツールを 1 つ渡し、そのツールを必ず使わせる（Converse の `toolChoice`）。ツールの引数を答えとして読む。

- ツールを必ず使わせる形では、Claude の考える機能（extended thinking）を一緒に使えない。そのため、Bedrock では考える深さを選べない
- 答えの長さの上限（`maxTokens`）は 16,000 トークン
- 混んでいるとき（HTTP 503、`ModelNotReadyException`）は、少し待って 2 回までやり直す。1 回の問いを待つのは 180 秒まで

コードは `src/llm/bedrockConverse.ts`（送る形と答えの読み方）と `src/llm/bedrock.ts`（ブラウザからの呼び出し）にある。会社ごとの値は `src/llm/providers.ts`。

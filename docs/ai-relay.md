# 組織の AI の中継（Amazon Bedrock）（2026-11-16）

Cocat を組織で立てるときに、使う人がキーを持たずに AI の機能を使えるようにする中継。ブラウザは同じサイトの `/api/ai` に送り、AWS の Lambda が自分の IAM ロールで Amazon Bedrock を呼ぶ。キーは使う人のブラウザにも、Lambda にも置かない。

既定では作らない。Terraform の変数 `ai_relay_enabled` を `true` にしたときだけ作る。

## 先に読むこと

中継にはログインが無い。サイトを開ける人は誰でも `/api/ai` を呼べて、AI の料金は立てた組織に請求される。サイトそのものを守ってから作る（IP の制限・SSO など。守り方は立てる組織が決める）。誰でも開ける公開のサイトでは作らない。

## 形

```
ブラウザ ──POST /api/ai──> CloudFront ──署名（OAC）──> Lambda の関数 URL ──IAM ロール──> Bedrock の Converse
```

- 同じサイトの `/api/ai` なので、CSP の `connect-src 'self'` のままでよい
- 関数 URL は `AWS_IAM` で、この CloudFront からしか呼べない。ブラウザは本文の SHA-256 を `x-amz-content-sha256` に添える（OPSIN と同じ。`docs/opsin-server.md`）
- 画面は、開いたときに `GET /api/ai` で中継があるかを確かめる。中継があれば、AI の設定の会社に「この組織の AI（Amazon Bedrock・中継）」が出る。使う人がまだ会社を選んでいなければ、それが選ばれる。使う人は自分のキー（Gemini・Bedrock）に切り替えることもできる
- 中継は送った文章と答えを記録しない。CloudWatch Logs に残すのは、時刻・モデル・成功か失敗の種類・トークン数・かかった時間だけ

## 答え方

AI の答えには 1〜3 分かかることがある。一方で CloudFront は Lambda から何も届かないまま 30 秒たつと切る。そこで中継は答えを少しずつ返す形（関数 URL の `RESPONSE_STREAM`）にしてある。

1. 許していないモデル・形の違う本文・5 MB を超える本文は、AI を呼ばずに断る（400 か 413 と JSON）
2. 受け付けたら、AI を呼ぶ前に空白を 1 文字送る
3. AI を待つ間は、10 秒ごとに空白を 1 文字送る
4. 最後に、結果の JSON を 1 つ送って終える。AI の失敗（上限・時間切れなど）も、この JSON の中で伝える

中継は 403 と 404 を返さない。このサイトの CloudFront は、403 と 404 を `index.html` に置き換えるため。

## 立て方

1. `infra/terraform.tfvars` に書く
   ```hcl
   ai_relay_enabled = true
   # 使ってよいモデル（推論プロファイルの ID）。既定は Claude Haiku 4.5 と Claude Sonnet 4.6
   # ai_relay_models = ["jp.anthropic.claude-haiku-4-5-20251001-v1:0", "jp.anthropic.claude-sonnet-4-6"]
   ```
2. `terraform plan` で、中継の分が足されることを確かめてから `terraform apply` する
   - 足されるもの: Lambda・関数 URL・IAM ロールと 2 つのポリシー・ロググループ・CloudFront の OAC・Lambda の 2 つの許可
   - 書き換わるもの: CloudFront の配信（`/api/ai` の振り分けが足される）、GitHub Actions のロールのポリシー（中継の中身を上げる許可が足される）
3. `terraform output ai_relay_function_name` の値を、GitHub のリポジトリの Variables の `AI_RELAY_FUNCTION_NAME` に入れる
4. 中身を上げる。main へのマージで `.github/workflows/deploy-ai-relay.yml` が上げる。手で動かすこともできる（Run workflow）。GitHub Actions を使わないときは、手で上げる
   ```bash
   npm ci
   npm run build:relay
   cd server/ai-relay/dist && zip -q ../ai-relay.zip index.mjs && cd -
   aws lambda update-function-code --function-name <関数の名前> --zip-file fileb://server/ai-relay/ai-relay.zip
   ```
5. 確かめる
   - `https://<サイト>/api/ai` をブラウザで開き、使えるモデルの JSON が出ること
   - AI の設定で「この組織の AI」を選び、「つながるか試す」を押す
   - 組織のネットワークから、長い問い（論文の PDF からの下書きなど）を 1 回送る。会社のプロキシが長いつなぎっぱなしの通信を溜めたり切ったりすると、30 秒前後で切れるか、答えがまとめて届く

AWS Budgets で、請求の通知を付けておくことを勧める。

## 権限とモデル

- Lambda の IAM ロールが呼べるのは、`ai_relay_models` に書いたモデルだけ。推論プロファイルと、その回す先のリージョン（`ai_relay_profile_regions`。既定は東京と大阪）の基盤のモデルの両方に許す
- Anthropic のモデルをアカウントで初めて呼ぶと、AWS Marketplace の購読が自動で行われる。そのため、ロールには `aws-marketplace:ViewSubscriptions` と `aws-marketplace:Subscribe` も許してある。Anthropic のユースケースの書式は、先にコンソールで出しておく（`docs/ai-bedrock.md`）
- 組織の SCP でリージョンを絞っているときは、回す先のリージョンで Bedrock の呼び出しを許す（`docs/ai-bedrock.md`）。Marketplace の購読の 2 つの操作を SCP で断っていないかも確かめる
- 新しいアカウントは、Lambda の同時に動く数の上限が 10 で、取り置き（`ai_relay_reserved_concurrency`）をすると断られる。上限を上げてから使う

## 値

| 項目 | 値 | 理由 |
| --- | --- | --- |
| Lambda | Node.js 22・arm64・256 MB・300 秒 | 画面が AI を待つのは 180 秒まで。それより長くする |
| 関数 URL | `AWS_IAM`・`RESPONSE_STREAM` | CloudFront からだけ呼べるように。待つ間に空白を送るため |
| CloudFront の待つ時間 | 既定の 30 秒 | 10 秒ごとに空白を送るので足りる |
| CloudFront の圧縮 | しない | 空白が溜められて届くのを避けるため |
| 本文の上限 | 5 MB | 関数 URL が受け取れるのは 6 MB まで |
| VPC | 使わない | 少しずつ返す形は、VPC の中の Lambda では使えない |

使う人が「やめる」を押して通信を切っても、Lambda は AI の答えが返るまで動き続けることがある（AI の料金もかかる）。

コードは `server/ai-relay/`（中継）と `src/llm/relay.ts`（ブラウザからの呼び出し）にある。Converse の送る形と答えの読み方は、ブラウザから直接呼ぶときと同じ `src/llm/bedrockConverse.ts` を使う。

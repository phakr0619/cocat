# 名前 → 構造の OPSIN のサーバー（2026-10-31）

名前を規則で構造にする OPSIN（MIT License、Java）を AWS の Lambda で動かす。

## 何に使うか

- **名前から置く**: 手元の辞書・ライブラリ・SMILES で引けなければ、まず OPSIN で読む。読めれば Gemini には送らない（キーが無くても使える）。慣用名・商品名など OPSIN が読めない名前だけ、今までどおり Gemini に回す
- **構造 → 名前の確かめ**: Gemini が書いた名前を OPSIN で構造に戻し、元の構造と同じか（立体を含む InChIKey）を比べる。OPSIN が読めない名前か、OPSIN に届かないときだけ、名前を Gemini で構造に戻して比べる（前の形）
- OPSIN に届かないとき（手元の開発・まだ置いていないとき）は、今までどおり Gemini だけで動く

## 形

```
ブラウザ ──POST /api/opsin（名前を 1 行に 1 つ）──> CloudFront ──署名（OAC）──> Lambda の関数 URL ──> OPSIN
```

- 同じドメインの `/api/opsin` なので、CSP の `connect-src 'self'` のままでよい
- 関数 URL は `AWS_IAM` で、この CloudFront からしか呼べない。CloudFront は POST の本文に署名するため、ブラウザは本文の SHA-256 を `x-amz-content-sha256` に添える（`src/chem/opsin.ts`）
- Lambda: Java 21・arm64・メモリ 1024 MB・15 秒。手元では起動から 1 つ変換するまで約 0.5 秒だったので、SnapStart（版の管理が要る）は使わない
- 一度に 50 個・1 つ 1000 文字まで。キャッシュしない
- **送るのは名前だけ。Lambda は名前を記録しない**（ログは数と秒数だけ）。CloudFront のアクセスログには本文は入らない

## ファイル

| ファイル | 中身 |
| --- | --- |
| `server/opsin/` | Lambda の中身（`OpsinHandler.java` と `pom.xml`）。`mvn -B package` で `target/opsin-lambda.jar`（約 5 MB、依存を含む） |
| `infra/opsin.tf` | Lambda・関数 URL・ロール・ロググループ（14 日）・CloudFront からの許可 |
| `infra/cloudfront.tf` | `/api/opsin` の道筋（origin と ordered_cache_behavior） |
| `infra/github-oidc.tf` | デプロイのロールに、この Lambda の中身の入れ替えを許す |
| `.github/workflows/deploy-opsin.yml` | main で `server/opsin` を変えたマージで、jar を作って Lambda へ上げ、公開のサイトの `/api/opsin` で確かめる |
| `src/chem/opsin.ts` | ブラウザから呼ぶ部品 |
| `tests/opsin.test.ts` | 答えの形・確かめの流れ・（jar があれば）評価の件の名前が正しく変換されるか |

Terraform が Lambda を作るときは、空の置き物（`infra/functions/opsin-placeholder.zip`）で作る。中身はワークフローが上げ、Terraform は中身の入れ替えを見ない（`ignore_changes`）。

## 置く手順（ユーザー）

1. `infra/` で `terraform plan`。見込みは **add 8・change 2・destroy 0**
   - add: `aws_iam_role.opsin`・`aws_iam_role_policy.opsin_logs`・`aws_cloudwatch_log_group.opsin`・`aws_lambda_function.opsin`・`aws_lambda_function_url.opsin`・`aws_cloudfront_origin_access_control.opsin`・`aws_lambda_permission.opsin_url`・`aws_lambda_permission.opsin_invoke`
   - change: `aws_cloudfront_distribution.site`（origin と道筋を足す。配信は作り直さない）・`aws_iam_role_policy.deploy`（中身の入れ替えの許可を足す）
2. `terraform apply`。CloudFront の変更が行き渡るまで数分かかる
3. PR をマージする。`Deploy OPSIN` のワークフローが jar を上げ、公開のサイトで確かめる
   - apply より先にマージしたときは、ワークフローが失敗する。apply のあとで、Actions の画面から `Deploy OPSIN` を手で動かす（Run workflow）
   - 名前を変えたとき（`project_name`）は、GitHub の Variables に `OPSIN_FUNCTION_NAME`（`terraform output opsin_function_name`）を入れる

利用者から見て: マージの前でも後でも、エディタは動く。OPSIN が置かれるまでは今までどおり Gemini だけで名前を調べ、置かれたあとは、規則で読める名前は Gemini のキー無しで置け、構造 → 名前は「確かめ済み（規則）」と出る。

## 費用

- Lambda の無料枠（月 100 万回・40 万 GB 秒）に収まる見込み。1 回 0.1 秒・1 GB として、無料枠を超えても 100 万回で約 2 ドル
- 悪用の心配が出たら、`opsin_max_concurrency`（同時に動く数の上限）を入れる。アカウントの Lambda の上限が小さいうち（新しいアカウントは 10）は入れられない

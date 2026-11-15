# 公開の手順（AWS の S3・CloudFront）

Cocat を静的な Web サイトとして公開する手順。Terraform は `infra/`、デプロイは `.github/workflows/deploy.yml`。

## 公開の形

- 静的な Web サイトとして公開する。サーバーもアカウントも無い（計算は RDKit.js でブラウザの中で行う）
- 置き場所は AWS の S3（非公開のバケット）と CloudFront（配信と HTTPS）
- 利用者のデータ（描いた構造・プロジェクト）はブラウザの中だけにあり、公開する側には届かない。届くのは、使った機能の名前だけ（下の「アクセス解析」）
- 名前から構造を置く機能のために、OPSIN を Lambda で 1 つ動かす（`infra/opsin.tf`、`server/opsin/`）。送るのは化合物名だけ

## 手順

1. 公開に使う AWS アカウントと、Terraform の state を置く S3 のバケットを用意する
   - アカウントの ID は `infra/account.auto.tfvars` の `aws_account_id` に書く（秘密ではない）
   - state の置き場所は `infra/versions.tf` の `backend "s3"` に書く
2. 手元で AWS にログインし、plan を見る
   ```sh
   cd infra
   terraform init
   terraform plan
   ```
   `.terraform.lock.hcl` ができたらコミットする
3. plan の差分を、下の「plan の見込み」と突き合わせてから `terraform apply`
4. `terraform output` の値を、GitHub のリポジトリの Settings → Secrets and variables → Actions → **Variables** に入れる
   - `AWS_DEPLOY_ROLE_ARN` ← `deploy_role_arn`
   - `S3_BUCKET` ← `bucket`
   - `CLOUDFRONT_DISTRIBUTION_ID` ← `distribution_id`
   - `SITE_URL` ← `site_url`（Deploy の最後の確認に使う。無いと Deploy が失敗する）
   - `VITE_FEEDBACK_URL`（感想の送り先。任意。下の「感想の送り先」）
5. GitHub の Actions → Deploy → Run workflow（main ブランチ）で公開する。`site_url` の URL で開けることを確かめる
6. その後は main へのマージで自動で公開する。資料（`docs/`・`*.md`）と Terraform（`infra/`）だけのマージでは動かない。Variables を変えたときは、Actions → Deploy → Run workflow で手で動かす

デプロイを許すリポジトリとブランチは、`infra/variables.tf` の `github_repository` と `github_allowed_branches` で決める（GitHub Actions から AWS へは OIDC でつなぐ。`infra/github-oidc.tf`）。

## plan の見込み（新しく作るだけで、変更・削除は無い）

独自ドメインなしで、公開とアクセス解析の分は **26 to add, 0 to change, 0 to destroy**。OPSIN の Lambda の分は `infra/opsin.tf` を見る。

| リソース | 数 | 何をするか |
| --- | --- | --- |
| `aws_s3_bucket.site` ほか（公開の禁止・所有者・暗号化・バケットポリシー） | 5 | サイトのファイルを置く。CloudFront からだけ読める |
| `aws_cloudfront_origin_access_control.site` | 1 | CloudFront が S3 を読むための署名 |
| `aws_cloudfront_response_headers_policy.security` | 1 | セキュリティヘッダー（CSP など） |
| `aws_cloudfront_distribution.site` | 1 | 配信と HTTPS（作るのに 5〜10 分かかる） |
| `aws_iam_openid_connect_provider.github` | 1 | GitHub Actions を AWS につなぐ（同じアカウントに既にあれば `create_github_oidc_provider = false` で 0） |
| `aws_iam_role.deploy`・`aws_iam_role_policy.deploy` | 2 | GitHub Actions がこのバケットへ送り、キャッシュを消すためだけの権限 |
| `aws_cloudfront_function.event` | 1 | アクセス解析の受け口（`/e`）。204 を返すだけ |
| `aws_s3_bucket.logs` ほか（公開の禁止・所有者・暗号化・自動削除・バケットポリシー） | 6 | アクセスログを置く。400 日で消える |
| `aws_cloudwatch_log_delivery_source`・`_destination`・`aws_cloudwatch_log_delivery` | 3 | CloudFront のアクセスログを S3 へ送る（us-east-1 に作る） |
| `aws_glue_catalog_database`・`aws_glue_catalog_table` | 2 | Athena でログを表として読むための定義 |
| `aws_athena_workgroup.analytics` | 1 | 集計の場所。1 回に読む量を 1 GB までにして料金の上限を決める |
| `aws_athena_named_query`（週ごとの利用者・機能ごとの利用） | 2 | よく使う集計を保存しておく |

独自ドメインあり（Route 53 のホストゾーンあり）では、さらに **+5**（証明書・証明書の確認・確認用の DNS レコード・A と AAAA のレコード）。Route 53 を使わない場合は +2（証明書と確認）で、`cert_validation_records` の値を DNS に手で入れるまで apply が待つ。

組織の SCP（サービスコントロールポリシー）でリージョンを制限しているときは、us-east-1 の ACM とログの配信を許す必要がある。

## 独自ドメインを付ける

1. Route 53 でドメインを登録する。ホストゾーンは自動でできる。連絡先を隠す設定（プライバシー保護）は既定で入る。登録したメールアドレスに届く確認のリンクを押す（押さないと止められる）
2. `infra/terraform.tfvars` に書く（コミットしない）
   ```hcl
   domain_name    = "example.com"
   hosted_zone_id = "Z…"
   ```
3. `terraform plan` の見込みは **5 to add, 1 to change, 0 to destroy**
   - add: 証明書・証明書の確認・確認用の DNS レコード・A と AAAA のレコード
   - change: CloudFront（`aliases` と `viewer_certificate`）。作り直しではない
4. `terraform apply`。証明書の確認に数分かかる
5. GitHub の Variables の `SITE_URL` を新しいドメインの URL に変える
6. CloudFront の元の名前（`*.cloudfront.net`）も開けたままになる。ブラウザに保存したデータはサイトの名前（オリジン）ごとに分かれるので、新しいドメインで開くと空から始まる。利用者には、一式を書き出してから移るよう知らせる

## 公開したサイトの確認

Deploy の最後に `tools/smoke.mjs` が自動で動き、公開したサイトを確かめる。1 つでもおかしければ Deploy が失敗になる。

- ページ・JS・RDKit の wasm（`application/wasm`）が届く。新しい版の `index.html` が届くまで最大 3 分待つ
- セキュリティヘッダー（CSP・HSTS・`x-frame-options`・`nosniff`）と、`index.html` の `no-cache`
- `/e` が 204 を返す（中身の無い HEAD で確かめるので、アクセス解析の集計には入らない）
- 本物のブラウザ（Chromium）で開き、RDKit が読み込まれ、見本「条件検討の表」が反応式と表つきで開き、反応 SMILES が出て、コンソールにエラーが無い。「このツールについて」の版が今の Deploy のもの
- ブラウザで開くときは使い方の統計を止めてから開くので、本番の数字に混ざらない

手元からも動かせる: `node tools/smoke.mjs <サイトの URL> [期待する版]`

## 感想の送り先（Google フォーム、任意）

1. Google フォームで空白のフォームを作る。説明に「構造式・化合物名など、秘密の情報は書かないでください。返信がほしいときだけメールアドレスを書いてください。」と書く
2. 質問を 4 つ作る

   | 質問 | 形式 | 必須 |
   | --- | --- | --- |
   | 種類 | ラジオボタン（感想 / 要望 / 不具合 / その他） | はい |
   | 内容 | 段落 | はい |
   | 返信がほしいときのメールアドレス | 記述式 | いいえ |
   | 版（自動で入ります） | 記述式 | いいえ |

3. 設定 → 回答 → 「メールアドレスを収集する」は収集しない。「回答を 1 回に制限する」はオフ（ログインを求めないため）
4. 「事前入力した URL を取得」で、版の欄に `VERSION` と入れて URL を取り、末尾の `entry.数字=VERSION` の `VERSION` を `{version}` に書き換える
5. その URL を GitHub の Variables の `VITE_FEEDBACK_URL` に入れる。メールの窓口も出すなら `VITE_FEEDBACK_EMAIL` に入れる
6. 次の Deploy から、「このツールについて」に送り先が出る。版の欄には `0.1.0+9f8fb30` のような値が自動で入る

## アクセス解析（個人を特定しない）

- アプリ（`src/analytics.ts`）が、機能を使ったときに `/e?n=<機能の名前>&u=<匿名の番号>&s=<タブの番号>&v=<版>` を送る。例: `n=table:create-conditions`、`n=export:cdxml`、`n=tool:ring6`（ツールはタブごとに 1 回だけ）
- 描いた構造・文字・ファイルの名前と中身は送らない。機能の名前の形（英小文字・数字・`:_-`）でないものは送らない作り
- 匿名の番号はブラウザの中の乱数で、毎月作り直す。月をまたいで同じ人を追えない
- ログに残すのは 日時・パス・クエリ・応答のコード・国 だけ。IP アドレス・Cookie・ブラウザ名・参照元は残さない（`infra/analytics.tf` の `record_fields`）
- 「このツールについて」で止められる。ブラウザの Global Privacy Control が有効なら送らない。手元の開発とテストでは送らない（公開のビルドの `VITE_ANALYTICS=1` のときだけ）
- 見方: AWS のコンソールの Athena → ワークグループ `<project_name>-analytics`（`project_name` の既定は `ai-chem-editor`） → 保存したクエリ「週ごとの利用者の数」「直近30日の機能ごとの利用」を実行する。ログは CloudFront から数分〜数十分遅れて届く
- 料金の目安: 利用が少ないうちは月数円〜数十円（S3 の保管と、Athena の読んだ量）

## 気をつけること

- CSP の `connect-src` は、自分のサイトと、Gemini の API（`https://generativelanguage.googleapis.com`）と、Bedrock の東京の API（`https://bedrock-runtime.ap-northeast-1.amazonaws.com`）だけ。OPSIN の Lambda は CloudFront の同じサイトの道筋から呼ぶ（`infra/cloudfront.tf`）。AI の機能は、利用者が自分で作った API キーで、ブラウザから Gemini か Bedrock を直接呼ぶ（Bedrock は `docs/ai-bedrock.md`）
- CSP に `'unsafe-eval'` が入っている。RDKit.js（Emscripten の embind）が文字列から関数を作るためで、外すと RDKit を読み込めない。外部のスクリプトは読まない（`script-src 'self'`）ので、影響は限られる
- `index.html` は毎回確かめさせ（`no-cache`）、`assets/` は名前にハッシュが付くので 1 年持たせる。RDKit の `.wasm` は `application/wasm` で送る
- 料金の目安: 利用が少ないうちは月数十円〜数百円（S3 と CloudFront の転送量。RDKit の wasm が約 7 MB あり、初回の読み込みごとにかかる）

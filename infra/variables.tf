variable "aws_account_id" {
  description = "公開に使う AWS アカウントの ID。別のアカウントのプロファイルで apply しないための確認に使う"
  type        = string
}

variable "aws_region" {
  description = "S3 バケットを置くリージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "リソースの名前の頭に付ける"
  type        = string
  default     = "ai-chem-editor"
}

variable "domain_name" {
  description = "独自ドメイン（例: editor.example.com）。空なら CloudFront の *.cloudfront.net で公開する"
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "domain_name の Route 53 のホストゾーン。空なら、証明書の確認用の DNS レコードは手で入れる"
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "デプロイを許す GitHub のリポジトリ（owner/repo）"
  type        = string
  default     = "phakr0619/cocat"
}

variable "github_allowed_branches" {
  description = "デプロイを許すブランチ"
  type        = list(string)
  default     = ["main"]
}

variable "create_github_oidc_provider" {
  description = "GitHub の OIDC プロバイダを作るか。同じアカウントに既にあれば false（1つのアカウントに1つしか作れない）"
  type        = bool
  default     = true
}

variable "opsin_max_concurrency" {
  description = "名前 → 構造（OPSIN）の Lambda が同時に動く数の上限。-1 は上限なし（アカウントの Lambda の上限が小さいうちは -1 のまま）"
  type        = number
  default     = -1
}

# 組織の中継（Amazon Bedrock）。docs/ai-relay.md
variable "ai_relay_enabled" {
  description = "AI の中継（ブラウザ → このサイトの /api/ai → Lambda → Amazon Bedrock）を作るか。中継にはログインが無く、サイトを開ける人は誰でも、この組織の費用で AI を使える。そのため、サイト自体が IP 制限や SSO などで守られているときだけ true にする"
  type        = bool
  default     = false
}

variable "ai_relay_region" {
  description = "中継が Bedrock を呼ぶリージョン（Lambda もここに置く）"
  type        = string
  default     = "ap-northeast-1"
}

variable "ai_relay_models" {
  description = "中継が使ってよいモデルの ID（推論プロファイルの ID）。ここに無いモデルは、中継が断る。ブラウザの選択肢にもなる"
  type        = list(string)
  default     = ["jp.anthropic.claude-haiku-4-5-20251001-v1:0", "jp.anthropic.claude-sonnet-4-6"]
}

variable "ai_relay_profile_regions" {
  description = "ai_relay_models の推論プロファイルが振り分ける先のリージョン。jp. のプロファイルは東京と大阪。Lambda の権限に、そのリージョンのモデルも入れる"
  type        = list(string)
  default     = ["ap-northeast-1", "ap-northeast-3"]
}

variable "ai_relay_reserved_concurrency" {
  description = "中継の Lambda が同時に動く数の上限。null は上限なし（作ったばかりのアカウントは Lambda の上限が 10 で、予約を付けると失敗する）。悪用で費用が増えるのを抑えたいときに入れる"
  type        = number
  default     = null
}

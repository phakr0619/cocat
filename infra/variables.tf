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

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # 状態ファイルは、公開のアカウント（896448596447）の中の state のバケットに置く（2026-10-24 に作った）。
  # 自分のアカウントで公開するときは、bucket と key を自分のものに書き換える（docs/hosting.md）
  backend "s3" {
    bucket       = "hp-tfstate-896448596447"
    key          = "ai-chem-editor/terraform.tfstate"
    region       = "ap-northeast-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

# CloudFront で使う証明書（ACM）は us-east-1 で発行する決まり
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

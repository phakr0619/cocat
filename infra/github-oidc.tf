# GitHub Actions が長期のアクセスキーを持たずにデプロイできるようにする（main ブランチからだけ）
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  repo_owner      = split("/", var.github_repository)[0]
  repo_name       = split("/", var.github_repository)[1]
  # sub は ID なしの旧形式と、owner・repo に数値 ID が付いた形式の両方を許す
  allowed_subjects = flatten([
    for b in var.github_allowed_branches : [
      "repo:${var.github_repository}:ref:refs/heads/${b}",
      "repo:${local.repo_owner}@*/${local.repo_name}@*:ref:refs/heads/${b}",
    ]
  ])
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.allowed_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.project_name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "SyncSite"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }
  statement {
    sid       = "ListSite"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }
  # 名前 → 構造の OPSIN の中身を入れ替える（.github/workflows/deploy-opsin.yml）
  statement {
    sid       = "UpdateOpsin"
    actions   = ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]
    resources = [aws_lambda_function.opsin.arn]
  }
  # AI の中継の中身を入れ替える（.github/workflows/deploy-ai-relay.yml）。中継を作ったときだけ
  dynamic "statement" {
    for_each = var.ai_relay_enabled ? [1] : []
    content {
      sid       = "UpdateAiRelay"
      actions   = ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]
      resources = [aws_lambda_function.ai_relay[0].arn]
    }
  }
  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-site"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# 組織の AI の中継（Amazon Bedrock）。var.ai_relay_enabled が true のときだけ作る（既定は作らない。plan に差は出ない）。
# ブラウザは同じドメインの /api/ai に POST し、CloudFront が署名して（OAC）Lambda の関数 URL へ渡す。
# Lambda は、自分の IAM ロールで Bedrock の Converse を呼ぶ。ブラウザにキーは要らない。
#
# 注意: 中継にはログインが無い。サイトを開ける人は誰でも /api/ai を呼べて、費用はこの組織に付く。
# サイト自体が IP 制限や SSO などで守られているときだけ有効にする（variables.tf の ai_relay_enabled）。
#
# 中身（server/ai-relay）は、main へのマージで .github/workflows/deploy-ai-relay.yml が上げる。
# Terraform が作るときは置き物（functions/ai-relay-placeholder.zip）で作り、そのあとの中身の入れ替えは見ない（ignore_changes）。
# opsin.tf と同じ作りだが、答えを待つあいだ空白を流すので、関数 URL は RESPONSE_STREAM にしてある

locals {
  ai_relay_name      = "${var.project_name}-ai-relay"
  ai_relay_origin_id = "lambda-${var.project_name}-ai-relay"
  # 推論プロファイルの ID（jp.・us.・apac.・eu. などの頭を除くと、基盤のモデルの ID になる）
  ai_relay_foundation_models = [for m in var.ai_relay_models : replace(m, "/^(jp|us|us-gov|apac|eu|global)\\./", "")]
}

data "aws_iam_policy_document" "ai_relay_trust" {
  count = var.ai_relay_enabled ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ai_relay" {
  count              = var.ai_relay_enabled ? 1 : 0
  name               = "${local.ai_relay_name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.ai_relay_trust[0].json
}

# ログは自分のロググループにだけ書ける
data "aws_iam_policy_document" "ai_relay_logs" {
  count = var.ai_relay_enabled ? 1 : 0
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ai_relay[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "ai_relay_logs" {
  count  = var.ai_relay_enabled ? 1 : 0
  name   = "write-logs"
  role   = aws_iam_role.ai_relay[0].id
  policy = data.aws_iam_policy_document.ai_relay_logs[0].json
}

# Bedrock は、許したモデルだけ呼べる。推論プロファイルと、そのプロファイルが振り分ける先のリージョンの基盤モデルの両方に許可が要る
data "aws_iam_policy_document" "ai_relay_bedrock" {
  count = var.ai_relay_enabled ? 1 : 0
  statement {
    sid     = "InvokeAllowedModels"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = concat(
      [for m in var.ai_relay_models : "arn:aws:bedrock:${var.ai_relay_region}:${var.aws_account_id}:inference-profile/${m}"],
      [for p in setproduct(var.ai_relay_profile_regions, local.ai_relay_foundation_models) : "arn:aws:bedrock:${p[0]}::foundation-model/${p[1]}"],
    )
  }
  # Anthropic のモデルは、アカウントで最初に呼ぶとき、呼んだ側の権限で AWS Marketplace の購読が自動で行われる。
  # この 2 つが無いと、その最初の 1 回が AccessDenied になる（購読のあとは使われない）
  statement {
    sid       = "MarketplaceAutoSubscribe"
    actions   = ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ai_relay_bedrock" {
  count  = var.ai_relay_enabled ? 1 : 0
  name   = "invoke-bedrock"
  role   = aws_iam_role.ai_relay[0].id
  policy = data.aws_iam_policy_document.ai_relay_bedrock[0].json
}

resource "aws_cloudwatch_log_group" "ai_relay" {
  count             = var.ai_relay_enabled ? 1 : 0
  name              = "/aws/lambda/${local.ai_relay_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "ai_relay" {
  count         = var.ai_relay_enabled ? 1 : 0
  function_name = local.ai_relay_name
  description   = "Amazon Bedrock の中継。CloudFront の /api/ai から呼ぶ"
  role          = aws_iam_role.ai_relay[0].arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  # Bedrock の答えを待つ時間。ブラウザは 180 秒で諦める
  timeout = 300
  # null は上限なし。悪用で費用が増えるのを抑えたいときに、同時に動く数の上限を入れる（作ったばかりのアカウントは上限が 10 で、予約できない）
  reserved_concurrent_executions = var.ai_relay_reserved_concurrency

  filename = "${path.module}/functions/ai-relay-placeholder.zip"

  environment {
    variables = {
      AI_RELAY_REGION = var.ai_relay_region
      AI_RELAY_MODELS = join(",", var.ai_relay_models)
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.ai_relay[0].name
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_iam_role_policy.ai_relay_logs]
}

# RESPONSE_STREAM: 答えを待つあいだ空白を流し、CloudFront の「最初の 1 バイトまで 30 秒」に間に合わせる
resource "aws_lambda_function_url" "ai_relay" {
  count              = var.ai_relay_enabled ? 1 : 0
  function_name      = aws_lambda_function.ai_relay[0].function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_cloudfront_origin_access_control" "ai_relay" {
  count                             = var.ai_relay_enabled ? 1 : 0
  name                              = "${local.ai_relay_name}-oac"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront（この配信だけ）から関数 URL を呼んでよい。関数 URL には、両方の許可が要る
resource "aws_lambda_permission" "ai_relay_url" {
  count                  = var.ai_relay_enabled ? 1 : 0
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.ai_relay[0].function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "ai_relay_invoke" {
  count         = var.ai_relay_enabled ? 1 : 0
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ai_relay[0].function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}

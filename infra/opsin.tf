# 名前 → 構造の OPSIN（規則で変換する、MIT）を動かす Lambda。docs/opsin-server.md
# ブラウザは同じドメインの /api/opsin に POST し、CloudFront が署名して（OAC）Lambda の関数 URL へ渡す。
# 関数 URL は CloudFront からしか呼べない（AWS_IAM）。送られるのは名前だけで、Lambda は名前を記録しない（数と秒数だけ）。
#
# 中身（server/opsin の jar）は、main へのマージで .github/workflows/deploy-opsin.yml が上げる。
# Terraform が作るときは空の置き物（functions/opsin-placeholder.zip）で作り、そのあとの中身の入れ替えは見ない（ignore_changes）

locals {
  opsin_name      = "${var.project_name}-opsin"
  opsin_origin_id = "lambda-${var.project_name}-opsin"
}

data "aws_iam_policy_document" "opsin_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "opsin" {
  name               = "${local.opsin_name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.opsin_trust.json
}

# ログは自分のロググループにだけ書ける（ほかの権限は持たない）
data "aws_iam_policy_document" "opsin_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.opsin.arn}:*"]
  }
}

resource "aws_iam_role_policy" "opsin_logs" {
  name   = "write-logs"
  role   = aws_iam_role.opsin.id
  policy = data.aws_iam_policy_document.opsin_logs.json
}

resource "aws_cloudwatch_log_group" "opsin" {
  name              = "/aws/lambda/${local.opsin_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "opsin" {
  function_name = local.opsin_name
  description   = "名前 → 構造（OPSIN）。CloudFront の /api/opsin から呼ぶ"
  role          = aws_iam_role.opsin.arn
  runtime       = "java21"
  handler       = "aichem.opsin.OpsinHandler::handleRequest"
  architectures = ["arm64"]
  # メモリを増やすと CPU も増え、Java の起動（初回の呼び出し）が速くなる
  memory_size = 1024
  timeout     = 15
  # -1 は上限なし。悪用で費用が増えるのを抑えたいときに、同時に動く数の上限を入れる（アカウントの上限が小さいと付けられない）
  reserved_concurrent_executions = var.opsin_max_concurrency

  filename = "${path.module}/functions/opsin-placeholder.zip"

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.opsin.name
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_iam_role_policy.opsin_logs]
}

resource "aws_lambda_function_url" "opsin" {
  function_name      = aws_lambda_function.opsin.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_cloudfront_origin_access_control" "opsin" {
  name                              = "${local.opsin_name}-oac"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront（この配信だけ）から関数 URL を呼んでよい。関数 URL には、両方の許可が要る
resource "aws_lambda_permission" "opsin_url" {
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.opsin.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "opsin_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.opsin.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}

# 名前は本文で送るので、キャッシュしない。Host 以外のヘッダー（本文のハッシュ x-amz-content-sha256 を含む）を Lambda へ渡す
data "aws_cloudfront_origin_request_policy" "all_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

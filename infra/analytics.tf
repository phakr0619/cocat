# 使い方の統計（個人を特定しない）。サーバー（Lambda など）は増やさず、
# アプリが /e?n=<機能の名前>&u=<毎月作り直す番号>&s=<タブの番号>&v=<版> を送り、
# CloudFront Function が 204 を返すだけ。CloudFront のアクセスログを S3 に積み、Athena で数える。
# ログには IP アドレス・Cookie・ブラウザ名・参照元を残さない（record_fields）。
# Cookie と地域は使わない

resource "aws_cloudfront_function" "event" {
  name    = "${var.project_name}-event"
  runtime = "cloudfront-js-2.0"
  comment = "/e: 使い方の統計の受け口。204 を返すだけ"
  publish = true
  code    = file("${path.module}/functions/e.js")
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# ---------------------------------------------------------------------------
# ログのバケット（アクセスログと Athena の結果）
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "logs" {
  bucket = "${var.project_name}-logs-${var.aws_account_id}"
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 生のログは400日（前の年と比べられる長さ）、Athena の結果は7日で消す
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {
      prefix = "AWSLogs/"
    }
    expiration {
      days = 400
    }
  }

  rule {
    id     = "expire-athena-results"
    status = "Enabled"
    filter {
      prefix = "athena-results/"
    }
    expiration {
      days = 7
    }
  }
}

# CloudFront のログの配信（standard logging v2）からの書き込みを許す
data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "AWSLogsDeliveryWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:us-east-1:${var.aws_account_id}:delivery-source:*"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json
}

# ---------------------------------------------------------------------------
# CloudFront のアクセスログ（standard logging v2。配信の設定は us-east-1 に作る決まり）
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_delivery_source" "access_logs" {
  provider     = aws.us_east_1
  name         = "${var.project_name}-access-logs"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
}

resource "aws_cloudwatch_log_delivery_destination" "access_logs" {
  provider                  = aws.us_east_1
  name                      = "${var.project_name}-access-logs-dest"
  output_format             = "parquet"
  delivery_destination_type = "S3"

  delivery_destination_configuration {
    destination_resource_arn = aws_s3_bucket.logs.arn
  }
}

resource "aws_cloudwatch_log_delivery" "access_logs" {
  provider                 = aws.us_east_1
  delivery_source_name     = aws_cloudwatch_log_delivery_source.access_logs.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.access_logs.arn

  s3_delivery_configuration {
    suffix_path                 = "/{yyyy}/{MM}/{dd}"
    enable_hive_compatible_path = true
  }

  # 残すのはこれだけ。c-ip（IP アドレス）・cs(Cookie)・cs(User-Agent)・cs(Referer) は入れない
  record_fields = [
    "date",
    "time",
    "cs-uri-stem",
    "cs-uri-query",
    "sc-status",
    "c-country",
  ]
}

# ---------------------------------------------------------------------------
# Athena で数える（ログのテーブルと、よく使う集計）
# ---------------------------------------------------------------------------

resource "aws_glue_catalog_database" "analytics" {
  name = "${replace(var.project_name, "-", "_")}_analytics"
}

locals {
  log_prefix = "s3://${aws_s3_bucket.logs.id}/AWSLogs/aws-account-id=${var.aws_account_id}/CloudFront/"
  log_columns = {
    date         = "string"
    time         = "string"
    cs_uri_stem  = "string"
    cs_uri_query = "string"
    sc_status    = "string"
    c_country    = "string"
  }
}

resource "aws_glue_catalog_table" "access_logs" {
  name          = "access_logs"
  database_name = aws_glue_catalog_database.analytics.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    "classification"            = "parquet"
    "projection.enabled"        = "true"
    "projection.year.type"      = "integer"
    "projection.year.range"     = "2026,2100"
    "projection.month.type"     = "integer"
    "projection.month.range"    = "1,12"
    "projection.month.digits"   = "2"
    "projection.day.type"       = "integer"
    "projection.day.range"      = "1,31"
    "projection.day.digits"     = "2"
    "storage.location.template" = "${local.log_prefix}year=$${year}/month=$${month}/day=$${day}"
  }

  storage_descriptor {
    location      = local.log_prefix
    input_format  = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"

    ser_de_info {
      serialization_library = "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"
    }

    dynamic "columns" {
      for_each = local.log_columns
      content {
        name = columns.key
        type = columns.value
      }
    }
  }

  partition_keys {
    name = "year"
    type = "string"
  }
  partition_keys {
    name = "month"
    type = "string"
  }
  partition_keys {
    name = "day"
    type = "string"
  }
}

# 1回の集計で読む量を 1 GB までにして、料金の上限を決めておく
resource "aws_athena_workgroup" "analytics" {
  name = "${var.project_name}-analytics"

  configuration {
    enforce_workgroup_configuration = true
    bytes_scanned_cutoff_per_query  = 1073741824

    result_configuration {
      output_location = "s3://${aws_s3_bucket.logs.id}/athena-results/"
    }
  }
}

locals {
  # /e のクエリから値を取り出す（url_extract_parameter は完全な URL が要るので頭を付ける）
  event_select = <<-SQL
    SELECT date,
           url_extract_parameter('https://x/e?' || cs_uri_query, 'n') AS name,
           url_extract_parameter('https://x/e?' || cs_uri_query, 'u') AS uid,
           url_extract_parameter('https://x/e?' || cs_uri_query, 'v') AS version
    FROM ${aws_glue_catalog_database.analytics.name}.access_logs
    WHERE cs_uri_stem = '/e'
      -- Deploy の確かめ（tools/smoke.mjs）は中身の無い HEAD で来るので数えない
      AND strpos(cs_uri_query, 'n=') > 0
  SQL
}

resource "aws_athena_named_query" "weekly_users" {
  name      = "週ごとの利用者の数（匿名の番号の数）"
  workgroup = aws_athena_workgroup.analytics.id
  database  = aws_glue_catalog_database.analytics.name
  query     = <<-SQL
    WITH e AS (${local.event_select})
    SELECT date_trunc('week', date(date)) AS week, count(DISTINCT uid) AS users, count(*) AS events
    FROM e
    GROUP BY 1
    ORDER BY 1 DESC
  SQL
}

resource "aws_athena_named_query" "feature_usage" {
  name      = "直近30日の機能ごとの利用（回数と人数）"
  workgroup = aws_athena_workgroup.analytics.id
  database  = aws_glue_catalog_database.analytics.name
  query     = <<-SQL
    WITH e AS (${local.event_select})
    SELECT name, count(*) AS times, count(DISTINCT uid) AS users
    FROM e
    WHERE date(date) >= current_date - INTERVAL '30' DAY
    GROUP BY 1
    ORDER BY 2 DESC
  SQL
}

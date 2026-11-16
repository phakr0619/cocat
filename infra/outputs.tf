output "site_url" {
  description = "公開の URL"
  value       = local.use_custom_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "bucket" {
  description = "GitHub の Variables の S3_BUCKET に入れる"
  value       = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  description = "GitHub の Variables の CLOUDFRONT_DISTRIBUTION_ID に入れる"
  value       = aws_cloudfront_distribution.site.id
}

output "deploy_role_arn" {
  description = "GitHub の Variables の AWS_DEPLOY_ROLE_ARN に入れる"
  value       = aws_iam_role.deploy.arn
}

output "cert_validation_records" {
  description = "Route 53 を使わないとき、DNS に手で入れる証明書の確認用のレコード"
  value       = local.use_custom_domain ? [for o in aws_acm_certificate.site[0].domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }] : []
}

output "opsin_function_name" {
  description = "名前 → 構造（OPSIN）の Lambda の名前。GitHub の Variables の OPSIN_FUNCTION_NAME に入れる"
  value       = aws_lambda_function.opsin.function_name
}

output "ai_relay_function_name" {
  description = "AI の中継の Lambda の名前（ai_relay_enabled が true のときだけ）。GitHub の Variables の AI_RELAY_FUNCTION_NAME に入れる"
  value       = one(aws_lambda_function.ai_relay[*].function_name)
}

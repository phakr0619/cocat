# 独自ドメイン（var.domain_name が空なら何も作らない）
resource "aws_acm_certificate" "site" {
  count             = local.use_custom_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# 証明書の確認用の DNS レコード。Route 53 のホストゾーンが無ければ、outputs の値を手で DNS に入れる
resource "aws_route53_record" "cert_validation" {
  for_each = local.use_custom_domain && var.hosted_zone_id != "" ? {
    for o in aws_acm_certificate.site[0].domain_validation_options : o.domain_name => o
  } : {}
  zone_id = var.hosted_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "site" {
  count                   = local.use_custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = var.hosted_zone_id != "" ? [for r in aws_route53_record.cert_validation : r.fqdn] : null
}

resource "aws_route53_record" "site" {
  for_each = local.use_custom_domain && var.hosted_zone_id != "" ? toset(["A", "AAAA"]) : toset([])
  zone_id  = var.hosted_zone_id
  name     = var.domain_name
  type     = each.value
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

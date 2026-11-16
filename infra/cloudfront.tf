locals {
  use_custom_domain = var.domain_name != ""
  origin_id         = "s3-${var.project_name}-site"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.project_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# セキュリティヘッダー。エディタは外部へ何も送らないので、接続先は自分のオリジンだけにする。
# RDKit.js は WebAssembly（'wasm-unsafe-eval'）で、さらに Emscripten の embind が文字列から関数を作る（'unsafe-eval'）。
# どちらも無いと RDKit を読み込めない（dist/ を同じ CSP で配って確かめた）。React の style 属性のため style-src に 'unsafe-inline'
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.project_name}-security-headers"

  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        # LLM の機能（M3）: 利用者のキーで、ブラウザから Gemini と Amazon Bedrock（東京）の API を直接呼ぶ（src/llm/gemini.ts・bedrock.ts）
        "connect-src 'self' https://generativelanguage.googleapis.com https://bedrock-runtime.ap-northeast-1.amazonaws.com",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ])
      override = true
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project_name} (free beta)"
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  aliases             = local.use_custom_domain ? [var.domain_name] : []

  # 名前 → 構造の OPSIN（opsin.tf）
  origin {
    domain_name              = split("/", aws_lambda_function_url.opsin.function_url)[2]
    origin_id                = local.opsin_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.opsin.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # AI の中継（ai-relay.tf。ai_relay_enabled が true のときだけ）
  dynamic "origin" {
    for_each = var.ai_relay_enabled ? [1] : []
    content {
      domain_name              = split("/", aws_lambda_function_url.ai_relay[0].function_url)[2]
      origin_id                = local.ai_relay_origin_id
      origin_access_control_id = aws_cloudfront_origin_access_control.ai_relay[0].id

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = local.origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = local.origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # 使い方の統計の受け口（analytics.tf）。CloudFront Function が 204 を返し、S3 には届かない
  ordered_cache_behavior {
    path_pattern           = "/e"
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.disabled.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.event.arn
    }
  }

  # 名前 → 構造の OPSIN（opsin.tf）。POST を Lambda へ渡し、キャッシュしない
  ordered_cache_behavior {
    path_pattern               = "/api/opsin"
    target_origin_id           = local.opsin_origin_id
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # AI の中継（ai-relay.tf）。POST を Lambda へ渡し、キャッシュしない。圧縮もしない（空白を流して接続を保つため）
  dynamic "ordered_cache_behavior" {
    for_each = var.ai_relay_enabled ? [1] : []
    content {
      path_pattern               = "/api/ai"
      target_origin_id           = local.ai_relay_origin_id
      viewer_protocol_policy     = "https-only"
      allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = false
      cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_except_host.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    }
  }

  # 1ページのアプリなので、無いパスは index.html を返す
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.use_custom_domain
    acm_certificate_arn            = local.use_custom_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : null
  }
}

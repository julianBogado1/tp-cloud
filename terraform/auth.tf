# Dashboard login with Cognito, through an HTTPS bridge.
#
# Cognito only redirects to HTTPS URLs (http://localhost aside), and the
# dashboard is an S3 website, HTTP only. So the Hosted UI redirects to
# /callback on this HTTP API, which runs the auth-callback Lambda: it
# exchanges the code for tokens (with the client secret, which never reaches
# the browser) and redirects to the dashboard with the tokens in the URL
# fragment. /logout is the HTTPS landing page after the Hosted UI logout,
# bouncing the user back to the dashboard they came from.
#
#   dashboard ──▶ Hosted UI ──▶ GET /callback ──▶ Lambda ──(code → tokens)──▶ Cognito /oauth2/token
#       ▲                                           │
#       └──────────── 302 http://<dashboard>/#access_token=… ◀──┘

locals {
  # The domain prefix only takes lowercase letters, digits and hyphens.
  cognito_domain_prefix = "snowball-${replace(lower(var.bucket_suffix), ".", "-")}"
  # One Cognito demo account per seeded user; the role lives in the seed row.
  demo_user_emails = toset([for u in jsondecode(file(var.seed_data_path)).users : u.item.email.S])
  # Where the Lambda may send tokens: the dashboard, its replica and the local
  # dev servers. Anything else in `state` is refused (no open redirect).
  auth_allowed_origins = compact(concat(
    ["http://${aws_s3_bucket_website_configuration.dashboard.website_endpoint}"],
    [for w in aws_s3_bucket_website_configuration.dashboard_replica : "http://${w.website_endpoint}"],
    var.auth_local_dev_origins,
  ))
}

resource "aws_apigatewayv2_api" "auth" {
  name          = "snowball-auth"
  protocol_type = "HTTP"
  description   = "HTTPS bridge between the Cognito Hosted UI and the HTTP dashboard."
}

module "cognito" {
  source             = "./modules/cognito"
  name               = "snowball-users"
  domain_prefix      = local.cognito_domain_prefix
  callback_url       = "${aws_apigatewayv2_api.auth.api_endpoint}/callback"
  logout_url         = "${aws_apigatewayv2_api.auth.api_endpoint}/logout"
  demo_users         = local.demo_user_emails
  demo_user_password = var.demo_user_password
}

# Its own module instance and not an entry of local.lambdas: the environment
# carries the client secret, and a sensitive value inside local.lambdas would
# make the for_each of module.lambda sensitive, which Terraform rejects.
module "auth_callback" {
  source        = "./modules/lambda-function"
  function_name = "snowball-auth-callback"
  zip_path      = var.auth_callback_lambda_zip_path
  timeout       = 10
  memory_size   = 128
  lab_role_arn  = data.aws_iam_role.lab.arn
  kms_key_arn   = aws_kms_key.main.arn
  environment = {
    COGNITO_DOMAIN        = module.cognito.domain_url
    COGNITO_CLIENT_ID     = module.cognito.client_id
    COGNITO_CLIENT_SECRET = module.cognito.client_secret
    CALLBACK_URL          = "${aws_apigatewayv2_api.auth.api_endpoint}/callback"
    ALLOWED_ORIGINS       = join(",", local.auth_allowed_origins)
  }
}

resource "aws_apigatewayv2_integration" "auth_callback" {
  api_id                 = aws_apigatewayv2_api.auth.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.auth_callback.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "auth" {
  for_each  = toset(["GET /callback", "GET /logout"])
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.auth_callback.id}"
}

resource "aws_cloudwatch_log_group" "auth_api" {
  name              = "/aws/apigateway/snowball-auth"
  retention_in_days = 14
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_apigatewayv2_stage" "auth" {
  api_id      = aws_apigatewayv2_api.auth.id
  name        = "$default"
  auto_deploy = true
  # Only people logging in hit this API: a low limit is plenty and caps abuse.
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
  # No query string in the log: /callback carries the authorization code.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.auth_api.arn
    format = jsonencode({
      requestId = "$context.requestId"
      ip        = "$context.identity.sourceIp"
      time      = "$context.requestTime"
      route     = "$context.routeKey"
      status    = "$context.status"
      latency   = "$context.integrationLatency"
      error     = "$context.integrationErrorMessage"
    })
  }
}

# API Gateway invokes through the function's resource policy, not through
# LabRole: this is a Lambda permission, not an IAM resource.
resource "aws_lambda_permission" "auth_api" {
  statement_id  = "AllowAuthApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.auth_callback.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.auth.execution_arn}/*/*"
}

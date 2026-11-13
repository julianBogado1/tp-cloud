data "aws_region" "current" {}

# User pool for the people who use the dashboard. Cognito authenticates; the
# role, the client scope and the active flag stay in snowball-users (DynamoDB),
# looked up by email on every request. The Cognito username IS the email, so
# the access token's `username` claim is the key into that table.
resource "aws_cognito_user_pool" "this" {
  name = var.name

  # Accounts are created by an admin (dashboard Users panel or the demo seed):
  # self sign-up would create people with no row, and so no role, in snowball-users.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  username_configuration {
    case_sensitive = false
  }
  auto_verified_attributes = ["email"]
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_uppercase                = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }
  # The Learner Lab is torn down and rebuilt every session.
  deletion_protection = "INACTIVE"
}

# Prefix domain for the Hosted UI (https://<prefix>.auth.<region>.amazoncognito.com).
# managed_login_version = 1 is the classic Hosted UI, which needs no branding resource.
resource "aws_cognito_user_pool_domain" "this" {
  domain                = var.domain_prefix
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 1
}

# Confidential client: the secret lives only in the auth-callback Lambda, which
# exchanges the authorization code. The browser never sees it.
resource "aws_cognito_user_pool_client" "dashboard" {
  name            = "${var.name}-dashboard"
  user_pool_id    = aws_cognito_user_pool.this.id
  generate_secret = true

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  # Both are HTTPS endpoints of the API Gateway bridge: Cognito rejects the
  # plain-HTTP S3 website URLs, which is the whole reason the bridge exists.
  callback_urls = [var.callback_url]
  logout_urls   = [var.logout_url]

  # No refresh token reaches the browser, so the access token has to cover a
  # working session: 8 h, the lifetime the API's own JWTs used to have.
  access_token_validity  = 8
  id_token_validity      = 8
  refresh_token_validity = 1
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}

# Demo accounts, one per seeded row in snowball-users (same emails). They share
# var.demo_user_password, set as permanent so the first login does not ask
# for a new one.
resource "aws_cognito_user" "demo" {
  for_each     = var.demo_users
  user_pool_id = aws_cognito_user_pool.this.id
  username     = each.value
  password     = var.demo_user_password
  attributes = {
    email          = each.value
    email_verified = "true"
  }
  message_action = "SUPPRESS"
}

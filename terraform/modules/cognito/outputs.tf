output "user_pool_id" {
  description = "User pool id (COGNITO_USER_POOL_ID for the API)."
  value       = aws_cognito_user_pool.this.id
}
output "user_pool_arn" {
  description = "User pool ARN."
  value       = aws_cognito_user_pool.this.arn
}
output "client_id" {
  description = "Dashboard app client id (public: it goes into the dashboard build)."
  value       = aws_cognito_user_pool_client.dashboard.id
}
output "client_secret" {
  description = "Dashboard app client secret, only for the auth-callback Lambda."
  value       = aws_cognito_user_pool_client.dashboard.client_secret
  sensitive   = true
}
output "domain_url" {
  description = "Hosted UI base URL."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

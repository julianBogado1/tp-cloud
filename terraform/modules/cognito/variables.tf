variable "name" {
  type        = string
  description = "User pool name; the app client is named <name>-dashboard."
}
variable "domain_prefix" {
  type        = string
  description = "Hosted UI domain prefix. Unique per region; may not contain aws, amazon or cognito."
}
variable "callback_url" {
  type        = string
  description = "HTTPS redirect URI after login: the /callback route of the API Gateway bridge."
}
variable "logout_url" {
  type        = string
  description = "HTTPS URL Cognito returns to after logout: the /logout route of the API Gateway bridge."
}
variable "demo_users" {
  type        = set(string)
  description = "Emails of the demo accounts. Each must match a seeded row in snowball-users, which holds its role."
}
variable "demo_user_password" {
  type        = string
  description = "Permanent password shared by the demo accounts."
  sensitive   = true
}

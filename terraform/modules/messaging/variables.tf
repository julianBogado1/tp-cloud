variable "names" { type = map(string) }
variable "subscription_email" {
  type     = string
  default  = null
  nullable = true
}

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "state_bucket_name" {
  type        = string
  description = "Globally unique remote state bucket name."
}
variable "tags" {
  type    = map(string)
  default = {}
}

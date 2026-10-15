output "state_bucket_name" {
  value = var.state_bucket_name
}
output "state_bucket_arn" {
  value = "arn:aws:s3:::${var.state_bucket_name}"
}

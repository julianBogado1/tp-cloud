output "vpc_id" {
  value = module.network.vpc_id
}
output "alb_dns_name" {
  value = module.compute.alb_dns_name
}
output "artifact_bucket" {
  value = local.bucket_names.artifacts
}
output "dashboard_bucket" {
  value = local.bucket_names.dashboard
}
output "dashboard_replica_bucket" {
  description = "Replicated dashboard bucket name; empty when the replica is disabled."
  value       = var.dashboard_replica_region == "" ? "" : local.bucket_names.dashboard_replica
}
output "dashboard_replica_region" {
  description = "Region of the replicated dashboard bucket; empty when the replica is disabled."
  value       = var.dashboard_replica_region
}
# The URLs come from website_endpoint: the S3 website host format varies per
# region (dash vs dot), so the provider resolves it instead of the repo.
output "dashboard_url" {
  description = "Main static site URL (S3 Website, HTTP only)."
  value       = "http://${aws_s3_bucket_website_configuration.dashboard.website_endpoint}"
}
# A `for` over the count list yields [] when the replica is off, so join()
# returns "" without ever indexing [0] on an empty resource list.
output "dashboard_replica_url" {
  description = "Replicated static site URL; empty when the replica is disabled."
  value       = join("", [for w in aws_s3_bucket_website_configuration.dashboard_replica : "http://${w.website_endpoint}"])
}
output "archive_bucket" {
  value = local.bucket_names.archive
}
output "iot_endpoint" {
  value = module.iot_ingest.iot_endpoint
}
output "iot_certificates" {
  value     = module.iot_ingest.certificates
  sensitive = true
}
output "iot_private_keys" {
  value     = module.iot_ingest.private_keys
  sensitive = true
}
output "iot_certificate_arns" {
  value     = module.iot_ingest.certificate_arns
  sensitive = true
}
output "table_names" {
  value = module.data.table_names
}
output "queue_url" {
  value = module.messaging.queue_url
}
output "dlq_url" {
  value = module.messaging.dlq_url
}
output "sns_topic_arns" {
  description = "SNS topics: thermal (alert-processor), signal (no-signal alarm), battery (reserved, no publisher yet)."
  value       = module.messaging.topic_arns
}
output "lambda_function_names" {
  value = { for key, fn in module.lambda : key => fn.function_name }
}
output "lambda_function_arns" {
  value = { for key, fn in module.lambda : key => fn.arn }
}
output "telemetry_export_schedule_arn" {
  value = aws_scheduler_schedule.telemetry_export.arn
}
output "no_signal_schedule_arn" {
  value = aws_scheduler_schedule.no_signal_monitor.arn
}

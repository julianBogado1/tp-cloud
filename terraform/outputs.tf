output "vpc_id" {
  description = "VPC holding the public and application subnets."
  value       = module.network.vpc_id
}
output "alb_dns_name" {
  description = "Public DNS name of the ALB: the base URL of the API (VITE_API_BASE for the dashboard build)."
  value       = module.compute.alb_dns_name
}
output "artifact_bucket" {
  description = "Private bucket holding api.bundle.js, downloaded by the instances at boot."
  value       = local.bucket_names.artifacts
}
output "dashboard_bucket" {
  description = "Bucket serving the dashboard static site."
  value       = local.bucket_names.dashboard
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
  description = "Bucket where the daily telemetry export lands before transitioning to Glacier."
  value       = local.bucket_names.archive
}
output "iot_endpoint" {
  description = "IoT Core data endpoint (iot:Data-ATS) used by the simulator, the API and sync-shadows."
  value       = module.iot_ingest.iot_endpoint
}
output "iot_certificates" {
  description = "Device certificate (PEM) per unit; written to disk by scripts/export-certs.sh."
  value       = module.iot_ingest.certificates
  sensitive   = true
}
output "iot_private_keys" {
  description = "Device private key per unit."
  value       = module.iot_ingest.private_keys
  sensitive   = true
}
output "iot_certificate_arns" {
  description = "Certificate ARN per unit (thing and policy attachment target)."
  value       = module.iot_ingest.certificate_arns
  sensitive   = true
}
output "table_names" {
  description = "The 7 DynamoDB table names, keyed as in modules/data (telemetry, state, users, clients, units, alerts, config)."
  value       = module.data.table_names
}
output "queue_url" {
  description = "URL of the readings queue the IoT rule publishes to."
  value       = module.messaging.queue_url
}
output "dlq_url" {
  description = "URL of the dead-letter queue (5 failed receives)."
  value       = module.messaging.dlq_url
}
output "sns_topic_arns" {
  description = "SNS topics: thermal (alert-processor), signal (no-signal alarm), battery (reserved, no publisher yet)."
  value       = module.messaging.topic_arns
}
output "lambda_function_names" {
  description = "Function name per key of local.lambdas."
  value       = { for key, fn in module.lambda : key => fn.function_name }
}
output "lambda_function_arns" {
  description = "Function ARN per key of local.lambdas, as targeted by the schedules and the event source mapping."
  value       = { for key, fn in module.lambda : key => fn.arn }
}
output "telemetry_export_schedule_arn" {
  description = "EventBridge Scheduler schedule for the daily telemetry export."
  value       = aws_scheduler_schedule.telemetry_export.arn
}
output "no_signal_schedule_arn" {
  description = "EventBridge Scheduler schedule for the per-unit no-signal sweep."
  value       = aws_scheduler_schedule.no_signal_monitor.arn
}

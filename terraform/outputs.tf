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

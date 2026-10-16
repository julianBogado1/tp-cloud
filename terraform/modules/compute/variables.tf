variable "project" { type = string }
variable "instance_type" { type = string }
variable "ami_id" {
  type     = string
  default  = null
  nullable = true
}
variable "key_name" { type = string }
variable "enable_bastion" { type = bool }
variable "alb_security_group_id" { type = string }
variable "app_security_group_id" { type = string }
variable "bastion_security_group_id" { type = string }
variable "lab_instance_profile" { type = string }
variable "subnet_ids" { type = list(string) }
variable "public_subnet_ids" { type = list(string) }
variable "vpc_id" { type = string }
variable "artifact_bucket" { type = string }
variable "api_bundle_path" { type = string }
variable "alert_bundle_path" { type = string }
variable "names" { type = map(string) }
variable "table_names" { type = map(string) }
variable "queue_url" { type = string }
variable "thermal_topic_arn" { type = string }
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "iot_endpoint" { type = string }

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "project" {
  type    = string
  default = "snowball"
}
variable "bucket_suffix" {
  type        = string
  description = "Globally unique suffix for S3 buckets."
}
variable "state_bucket_name" {
  type        = string
  description = "Remote state bucket created by bootstrap."
}
variable "lab_role_name" {
  type    = string
  default = "LabRole"
}
variable "lab_instance_profile_name" {
  type    = string
  default = "LabInstanceProfile"
}
variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}
variable "availability_zones" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
}
variable "enable_bastion" {
  type    = bool
  default = false
}
variable "bastion_allowed_cidr" {
  type        = string
  description = "Fixed public CIDR allowed to SSH to the bastion."
}
variable "key_name" {
  type        = string
  description = "Existing EC2 key pair name."
}
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "sns_subscription_email" {
  type        = string
  description = "Email subscription for thermal excursion notifications."
}
variable "instance_type" {
  type    = string
  default = "t3.small"
}
variable "ami_id" {
  type     = string
  default  = null
  nullable = true
}
variable "api_bundle_path" {
  type    = string
  default = "../packages/api/dist/api.bundle.js"
}
variable "alert_bundle_path" {
  type    = string
  default = "../packages/alert-processor/dist/alert-processor.bundle.js"
}
variable "lambda_zip_path" {
  type    = string
  default = "../packages/telemetry-export/dist/telemetry-export.zip"
}
variable "seed_data_path" {
  type    = string
  default = "../scripts/seed-data.json"
}
variable "schedule_expression" {
  type    = string
  default = "cron(15 0 * * ? *)"
}

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
variable "table_names" { type = map(string) }
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "cors_origin" { type = string }
variable "iot_endpoint" { type = string }
variable "asg_min_size" { type = number }
variable "asg_max_size" { type = number }
variable "asg_desired_capacity" { type = number }
variable "tags" { type = map(string) }

variable "instance_type" {
  type        = string
  description = "EC2 instance type for the API Auto Scaling group."
}
variable "ami_id" {
  type        = string
  description = "AMI override; null uses the latest Amazon Linux 2023 from the aws_ami data source."
  default     = null
  nullable    = true
}
variable "key_name" {
  type        = string
  description = "Existing EC2 key pair name, used by the instances and the bastion."
}
variable "enable_bastion" {
  type        = bool
  description = "Create the optional SSH bastion in the first public subnet (count)."
}
variable "alb_security_group_id" {
  type        = string
  description = "Security group attached to the load balancer."
}
variable "app_security_group_id" {
  type        = string
  description = "Security group attached to the instances launched by the ASG."
}
variable "bastion_security_group_id" {
  type        = string
  description = "Security group attached to the optional bastion."
}
variable "lab_instance_profile" {
  type        = string
  description = "Learner Lab instance profile name granting the instances their AWS access."
}
variable "subnet_ids" {
  type        = list(string)
  description = "Application (private) subnets where the ASG launches the instances."
}
variable "public_subnet_ids" {
  type        = list(string)
  description = "Public subnets for the load balancer; the bastion uses the first one."
}
variable "vpc_id" {
  type        = string
  description = "VPC of the target group."
}
variable "artifact_bucket" {
  type        = string
  description = "Private bucket the API bundle is uploaded to and the user data downloads it from."
}
variable "api_bundle_path" {
  type        = string
  description = "Local path to the bundled API; its filemd5 drives a new launch template version."
}
variable "table_names" {
  type        = map(string)
  description = "DynamoDB table names rendered into the user data environment file."
}
variable "jwt_secret" {
  type        = string
  description = "Secret the API signs its JWTs with, rendered into the user data."
  sensitive   = true
}
variable "cors_origin" {
  type        = string
  description = "Allowed CORS origin for the API (CORS_ORIGIN)."
}
variable "iot_endpoint" {
  type        = string
  description = "IoT data endpoint the API uses for the Device Shadow routes."
}
variable "asg_min_size" {
  type        = number
  description = "Minimum number of API instances."
}
variable "asg_max_size" {
  type        = number
  description = "Maximum number of API instances."
}
variable "asg_desired_capacity" {
  type        = number
  description = "Desired number of API instances."
}
variable "tags" {
  type        = map(string)
  description = "Common tags merged into the instance and volume tag specifications: default_tags do not reach instances launched by the ASG."
}

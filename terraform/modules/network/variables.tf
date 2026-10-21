variable "project" {
  type        = string
  description = "Project name, used as a prefix for the VPC and security group names."
}
variable "vpc_cidr" {
  type        = string
  description = "CIDR block of the VPC; the four subnets are carved out of it with cidrsubnet."
}
variable "availability_zones" {
  type        = list(string)
  description = "Two availability zones: one public and one application subnet in each."
}
variable "bastion_allowed_cidr" {
  type        = string
  description = "Public CIDR allowed to SSH to the bastion security group."
}

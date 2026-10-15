variable "project" { type = string }
variable "vpc_cidr" { type = string }
variable "availability_zones" { type = list(string) }
variable "bastion_allowed_cidr" { type = string }

provider "aws" {
  region = var.region
  default_tags { tags = local.common_tags }
}

data "aws_iam_role" "lab" { name = var.lab_role_name }
data "aws_iam_instance_profile" "lab" { name = var.lab_instance_profile_name }

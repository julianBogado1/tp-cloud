variable "region" {
  type        = string
  description = "AWS region to deploy into."
  default     = "us-east-1"
}
variable "dashboard_replica_region" {
  type        = string
  description = "Region for the replicated dashboard website bucket. Empty disables the replica. The Learner Lab only allows us-east-1 and us-west-2."
  default     = "us-west-2"
  validation {
    condition     = contains(["", "us-east-1", "us-west-2"], var.dashboard_replica_region)
    error_message = "dashboard_replica_region must be \"\" (disabled), us-east-1 or us-west-2: the Learner Lab denies access to other regions."
  }
}
variable "project" {
  type        = string
  description = "Project name, used for tags and resource names."
  default     = "snowball"
}
variable "bucket_suffix" {
  type        = string
  description = "Globally unique suffix for S3 buckets."
}
variable "lab_role_name" {
  type        = string
  description = "Pre-existing Learner Lab IAM role used by IoT, Lambda and Scheduler."
  default     = "LabRole"
}
variable "lab_instance_profile_name" {
  type        = string
  description = "Pre-existing Learner Lab instance profile for the EC2 instances."
  default     = "LabInstanceProfile"
}
variable "vpc_cidr" {
  type        = string
  description = "CIDR block of the VPC (subnets are carved with cidrsubnet)."
  default     = "10.0.0.0/16"
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block, e.g. 10.0.0.0/16."
  }
}
variable "availability_zones" {
  type        = list(string)
  description = "Two availability zones for the public and application subnets."
  default     = ["us-east-1a", "us-east-1b"]
}
variable "enable_bastion" {
  type        = bool
  description = "Create the optional SSH bastion in the first public subnet."
  default     = false
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
  type        = string
  description = "Secret used by the API to sign JWTs."
  sensitive   = true
}
variable "sns_subscription_email" {
  type        = string
  description = "Email subscription for thermal excursion notifications."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.sns_subscription_email))
    error_message = "sns_subscription_email must be a valid email address."
  }
}
variable "cors_origin" {
  type        = string
  description = "Allowed CORS origin for the API (CORS_ORIGIN). Use * for graders on localhost."
  default     = "*"
}
variable "instance_type" {
  type        = string
  description = "EC2 instance type for the API Auto Scaling group."
  default     = "t3.small"
}
variable "asg_min_size" {
  type        = number
  description = "Minimum number of API instances."
  default     = 2
}
variable "asg_max_size" {
  type        = number
  description = "Maximum number of API instances."
  default     = 4
}
variable "asg_desired_capacity" {
  type        = number
  description = "Desired number of API instances."
  default     = 2
}
variable "ami_id" {
  type        = string
  description = "Optional AMI override; null uses the latest Amazon Linux 2023."
  default     = null
  nullable    = true
}
variable "api_bundle_path" {
  type        = string
  description = "Path to the bundled API (uploaded to the artifacts bucket)."
  default     = "../packages/api/dist/api.bundle.js"
}
variable "alert_lambda_zip_path" {
  type        = string
  description = "Path to the alert-processor Lambda zip."
  default     = "../packages/alert-processor/dist/alert-processor.zip"
}
variable "no_signal_lambda_zip_path" {
  type        = string
  description = "Path to the no-signal-monitor Lambda zip (second bundle of the alert-processor package)."
  default     = "../packages/alert-processor/dist/no-signal-monitor.zip"
}
variable "lambda_zip_path" {
  type        = string
  description = "Path to the telemetry-export Lambda zip."
  default     = "../packages/telemetry-export/dist/telemetry-export.zip"
}
variable "seed_data_path" {
  type        = string
  description = "JSON file with the seed items for the DynamoDB tables."
  default     = "../scripts/seed-data.json"
}
variable "schedule_expression" {
  type        = string
  description = "EventBridge Scheduler expression for the daily telemetry export."
  default     = "cron(15 0 * * ? *)"
}
variable "no_signal_schedule_expression" {
  type        = string
  description = "EventBridge Scheduler expression for the per-unit no-signal sweep."
  default     = "rate(1 minute)"
}
variable "no_signal_timeout_min" {
  type        = number
  description = "Default minutes of silence before a unit is reported as no-signal (per-unit override: signal_timeout_min in snowball-device-config)."
  default     = 10
  validation {
    condition     = var.no_signal_timeout_min >= 1
    error_message = "no_signal_timeout_min must be at least 1."
  }
}
variable "archive_glacier_days" {
  type        = number
  description = "Days before archived telemetry transitions to S3 Glacier."
  default     = 90
  validation {
    condition     = var.archive_glacier_days >= 30
    error_message = "archive_glacier_days must be at least 30."
  }
}
variable "unit_ids" {
  type        = list(string)
  description = "Cold-chain units (IoT things + certificates) to provision."
  default     = ["SB-001", "SB-002", "SB-003"]
}

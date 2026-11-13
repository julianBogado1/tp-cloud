module "network" {
  source               = "./modules/network"
  project              = var.project
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  bastion_allowed_cidr = var.bastion_allowed_cidr
}

module "data" {
  source      = "./modules/data"
  table_names = local.names
  seed_path   = var.seed_data_path
}

module "messaging" {
  source             = "./modules/messaging"
  names              = local.names
  subscription_email = var.sns_subscription_email
  kms_key_arn        = aws_kms_key.main.arn
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = local.bucket_names.artifacts
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = local.bucket_names.artifacts
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  for_each = toset([local.bucket_names.artifacts, local.bucket_names.archive])
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = local.bucket_names.archive
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = local.bucket_names.archive
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = local.bucket_names.archive
  rule {
    id     = "telemetry-to-glacier"
    status = "Enabled"
    filter { prefix = "telemetry/" }
    transition {
      days          = var.archive_glacier_days
      storage_class = "GLACIER"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dashboard" {
  bucket = local.bucket_names.dashboard
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "dashboard" {
  bucket                  = local.bucket_names.dashboard
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "dashboard" {
  bucket = local.bucket_names.dashboard
  index_document { suffix = "index.html" }
}

resource "aws_s3_bucket_policy" "dashboard" {
  bucket = local.bucket_names.dashboard
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::${local.bucket_names.dashboard}/*"
    }]
  })
  # S3 enables Block Public Access on every new bucket, and BlockPublicPolicy
  # rejects a PutBucketPolicy with Principal "*". The PAB must be opened first.
  depends_on = [
    aws_s3_bucket_public_access_block.dashboard,
    aws_s3_bucket_website_configuration.dashboard,
  ]
}

# Replicated dashboard website, same configuration as above in a second region.
# The bucket itself is created by scripts/bootstrap-buckets.sh (the Learner Lab
# SCP denies s3:GetBucketObjectLockConfiguration, so aws_s3_bucket is unusable);
# DASHBOARD_REPLICA_REGION in that script must match var.dashboard_replica_region.
# The top-level `region` argument (AWS provider v6 enhanced region support)
# replaces an aliased provider: a single provider keeps default_tags in one
# place and makes it explicit that the IAM data sources are global.
# var.dashboard_replica_region = "" disables all four resources.
resource "aws_s3_bucket_server_side_encryption_configuration" "dashboard_replica" {
  count  = var.dashboard_replica_region == "" ? 0 : 1
  region = var.dashboard_replica_region
  bucket = local.bucket_names.dashboard_replica
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "dashboard_replica" {
  count                   = var.dashboard_replica_region == "" ? 0 : 1
  region                  = var.dashboard_replica_region
  bucket                  = local.bucket_names.dashboard_replica
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "dashboard_replica" {
  count  = var.dashboard_replica_region == "" ? 0 : 1
  region = var.dashboard_replica_region
  bucket = local.bucket_names.dashboard_replica
  index_document { suffix = "index.html" }
}

resource "aws_s3_bucket_policy" "dashboard_replica" {
  count  = var.dashboard_replica_region == "" ? 0 : 1
  region = var.dashboard_replica_region
  bucket = local.bucket_names.dashboard_replica
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::${local.bucket_names.dashboard_replica}/*"
    }]
  })
  depends_on = [
    aws_s3_bucket_public_access_block.dashboard_replica,
    aws_s3_bucket_website_configuration.dashboard_replica,
  ]
}

module "iot_ingest" {
  source               = "./modules/iot-ingest"
  names                = local.names
  units                = local.units
  lab_role_arn         = data.aws_iam_role.lab.arn
  telemetry_table_name = module.data.table_names.telemetry
  state_table_name     = module.data.table_names.state
  queue_url            = module.messaging.queue_url
  kms_key_arn          = aws_kms_key.main.arn
}

# No module-level depends_on here: it would defer data.aws_ami / data.aws_region
# inside the module and churn the launch template. Dependencies are implicit
# through table_names and iot_endpoint.
module "compute" {
  source                    = "./modules/compute"
  instance_type             = var.instance_type
  ami_id                    = var.ami_id
  key_name                  = var.key_name
  enable_bastion            = var.enable_bastion
  alb_security_group_id     = module.network.alb_security_group_id
  app_security_group_id     = module.network.app_security_group_id
  bastion_security_group_id = module.network.bastion_security_group_id
  lab_instance_profile      = data.aws_iam_instance_profile.lab.name
  subnet_ids                = module.network.app_subnet_ids
  public_subnet_ids         = module.network.public_subnet_ids
  vpc_id                    = module.network.vpc_id
  artifact_bucket           = local.bucket_names.artifacts
  api_bundle_path           = var.api_bundle_path
  jwt_secret                = var.jwt_secret
  cors_origin               = var.cors_origin
  table_names               = module.data.table_names
  iot_endpoint              = module.iot_ingest.iot_endpoint
  asg_min_size              = var.asg_min_size
  asg_max_size              = var.asg_max_size
  asg_desired_capacity      = var.asg_desired_capacity
  tags                      = local.common_tags
}

# Both Lambdas run outside the VPC with LabRole. Table names come from module.data
# outputs (implicit dependency); the archive bucket is read from the lifecycle
# resource so the function is created after the bucket is configured.
module "lambda" {
  source   = "./modules/lambda-function"
  for_each = local.lambdas

  function_name = each.value.function_name
  zip_path      = each.value.zip_path
  timeout       = each.value.timeout
  memory_size   = each.value.memory_size
  environment   = each.value.environment
  lab_role_arn  = data.aws_iam_role.lab.arn
  kms_key_arn   = aws_kms_key.main.arn
}

resource "aws_scheduler_schedule" "telemetry_export" {
  name                = "snowball-telemetry-export"
  schedule_expression = var.schedule_expression
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = module.lambda["telemetry-export"].arn
    role_arn = data.aws_iam_role.lab.arn
    input    = "{}"
  }
}

# Per-unit "no signal" sweep. The schedule granularity is the detection error,
# so rate(1 minute) keeps the latency inside the <60 s requirement. No
# aws_lambda_permission: the Scheduler invokes by assuming LabRole.
resource "aws_scheduler_schedule" "no_signal_monitor" {
  name                = "snowball-no-signal-monitor"
  schedule_expression = var.no_signal_schedule_expression
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = module.lambda["no-signal-monitor"].arn
    role_arn = data.aws_iam_role.lab.arn
    input    = "{}"
  }
}

# SQS -> alert-processor. Partial batch responses keep successful messages from
# being retried; maximum_concurrency = 2 (the minimum) limits concurrent state writes.
resource "aws_lambda_event_source_mapping" "alert_processor" {
  event_source_arn        = module.messaging.queue_arn
  function_name           = module.lambda["alert-processor"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2
  }
}

moved {
  from = module.export.aws_lambda_function.this
  to   = module.lambda["telemetry-export"].aws_lambda_function.this
}
moved {
  from = module.export.aws_cloudwatch_log_group.lambda
  to   = module.lambda["telemetry-export"].aws_cloudwatch_log_group.this
}
moved {
  from = module.export.aws_scheduler_schedule.daily
  to   = aws_scheduler_schedule.telemetry_export
}

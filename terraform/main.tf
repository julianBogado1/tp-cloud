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
}

module "dashboard_bucket" {
  source                  = "terraform-aws-modules/s3-bucket/aws"
  version                 = "4.2.2"
  bucket                  = local.bucket_names.dashboard
  website                 = { index_document = "index.html" }
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}
resource "aws_s3_bucket" "artifacts" {
  bucket        = local.bucket_names.artifacts
  force_destroy = false
}
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket" "archive" {
  bucket        = local.bucket_names.archive
  force_destroy = var.archive_prevent_destroy ? false : true
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    id     = "telemetry-to-glacier"
    status = "Enabled"
    filter { prefix = "telemetry/" }
    transition {
      days          = 30
      storage_class = "GLACIER"
    }
  }
}

module "iot_ingest" {
  source              = "./modules/iot-ingest"
  names               = local.names
  units               = local.units
  lab_role_arn        = data.aws_iam_role.lab.arn
  telemetry_table_arn = module.data.table_arns.telemetry
  state_table_arn     = module.data.table_arns.state
  queue_url           = module.messaging.queue_url
}

module "compute" {
  source               = "./modules/compute"
  project              = var.project
  instance_type        = var.instance_type
  ami_id               = var.ami_id
  key_name             = var.key_name
  enable_bastion       = var.enable_bastion
  bastion_allowed_cidr = var.bastion_allowed_cidr
  lab_instance_profile = data.aws_iam_instance_profile.lab.name
  subnet_ids           = module.network.app_subnet_ids
  public_subnet_ids    = module.network.public_subnet_ids
  vpc_id               = module.network.vpc_id
  artifact_bucket      = aws_s3_bucket.artifacts.id
  api_bundle_path      = var.api_bundle_path
  alert_bundle_path    = var.alert_bundle_path
  names                = local.names
  queue_url            = module.messaging.queue_url
  thermal_topic_arn    = module.messaging.thermal_topic_arn
  jwt_secret           = var.jwt_secret
  table_names          = module.data.table_names
  depends_on           = [module.data, module.messaging]
}

module "export" {
  source              = "./modules/export"
  function_name       = "snowball-telemetry-export"
  lambda_zip_path     = var.lambda_zip_path
  archive_bucket      = aws_s3_bucket.archive.id
  telemetry_table     = local.names.telemetry_table
  state_table         = local.names.state_table
  lab_role_arn        = data.aws_iam_role.lab.arn
  schedule_expression = var.schedule_expression
  depends_on          = [module.data, aws_s3_bucket.archive]
}

resource "aws_s3_bucket_policy" "dashboard" {
  bucket     = module.dashboard_bucket.s3_bucket_id
  policy     = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "${module.dashboard_bucket.s3_bucket_arn}/*" }] })
  depends_on = [module.dashboard_bucket]
}

# Project-wide customer-managed key: the two SQS queues, the three SNS topics
# and every CloudWatch log group.
#
# Customer-managed and not alias/aws/sns because the "no signal" alarm publishes
# to its topic as cloudwatch.amazonaws.com, and that principal cannot use the
# AWS-managed keys: their key policy is fixed and names no service. Encrypting
# the topic with alias/aws/sns would bring back the exact failure that
# subscribing an email to it just fixed, the alarm firing and reaching nobody.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_kms_key" "main" {
  description             = "snowball: SQS queues, SNS topics and CloudWatch log groups"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  # A key policy stands on its own: a principal named here needs no matching
  # IAM policy, which is what makes this work with LabRole, a role the Learner
  # Lab does not let us edit.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # Everything that runs as LabRole: the API on EC2, both Lambdas, and the
        # IoT topic rule writing each reading into the queue.
        Sid       = "LabRoleUse"
        Effect    = "Allow"
        Principal = { AWS = data.aws_iam_role.lab.arn }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.current.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
          }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/snowball"
  target_key_id = aws_kms_key.main.key_id
}

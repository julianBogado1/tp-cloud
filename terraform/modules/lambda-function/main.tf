# Generic Lambda function (zip package, LabRole, outside the VPC) plus its
# CloudWatch log group. Used for telemetry-export and alert-processor.
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}
resource "aws_lambda_function" "this" {
  function_name    = var.function_name
  filename         = var.zip_path
  source_code_hash = filebase64sha256(var.zip_path)
  handler          = var.handler
  runtime          = var.runtime
  role             = var.lab_role_arn
  timeout          = var.timeout
  memory_size      = var.memory_size
  environment {
    variables = var.environment
  }
  tracing_config {
    mode = "Active"
  }
  # The function only references the log group by naming convention; without this
  # an early invocation could auto-create the group with infinite retention.
  depends_on = [aws_cloudwatch_log_group.this]
}

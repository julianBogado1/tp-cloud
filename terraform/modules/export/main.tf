resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = 14
}
resource "aws_lambda_function" "this" {
  function_name    = var.function_name
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  role             = var.lab_role_arn
  timeout          = 300
  memory_size      = 512
  environment {
    variables = {
      ARCHIVE_BUCKET  = var.archive_bucket
      DDB_TABLE       = var.telemetry_table
      DDB_STATE_TABLE = var.state_table
    }
  }
}
resource "aws_scheduler_schedule" "daily" {
  name                = "snowball-telemetry-export"
  schedule_expression = var.schedule_expression
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.this.arn
    role_arn = var.lab_role_arn
    input    = "{}"
  }
}

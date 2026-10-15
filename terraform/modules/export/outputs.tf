output "lambda_arn" { value = aws_lambda_function.this.arn }
output "schedule_arn" { value = aws_scheduler_schedule.daily.arn }

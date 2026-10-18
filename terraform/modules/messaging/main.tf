resource "aws_sqs_queue" "dlq" {
  name                      = var.names.readings_dlq
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "readings" {
  name                       = var.names.readings_queue
  visibility_timeout_seconds = 180 # >= 6x the alert-processor Lambda timeout (30 s)
  receive_wait_time_seconds  = 20
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5 })
}
# battery ("snowball-low-battery") is reserved: no publisher yet.
resource "aws_sns_topic" "topics" {
  for_each = { thermal = var.names.thermal_topic, battery = var.names.battery_topic, signal = var.names.signal_topic }
  name     = each.value
}
resource "aws_sns_topic_subscription" "thermal_email" {
  count     = var.subscription_email == null ? 0 : 1
  topic_arn = aws_sns_topic.topics["thermal"].arn
  protocol  = "email"
  endpoint  = var.subscription_email
}

# External registry module: fleet-level "no signal" alarm. If the readings queue
# receives nothing for 15 minutes (or CloudWatch has no datapoints at all) the
# alarm publishes to the no-signal SNS topic.
module "no_signal_alarm" {
  source  = "terraform-aws-modules/cloudwatch/aws//modules/metric-alarm"
  version = "~> 5.0"

  alarm_name          = format("%s-alarm", var.names.signal_topic)
  alarm_description   = "No telemetry reached the readings queue in the last 15 minutes."
  namespace           = "AWS/SQS"
  metric_name         = "NumberOfMessagesSent"
  dimensions          = { QueueName = aws_sqs_queue.readings.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.topics["signal"].arn]
}

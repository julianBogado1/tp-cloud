resource "aws_sqs_queue" "dlq" {
  name                      = var.names.readings_dlq
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "readings" {
  name                       = var.names.readings_queue
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 3 })
}
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

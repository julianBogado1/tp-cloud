output "queue_url" { value = aws_sqs_queue.readings.url }
output "queue_arn" { value = aws_sqs_queue.readings.arn }
output "dlq_url" { value = aws_sqs_queue.dlq.url }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
output "thermal_topic_arn" { value = aws_sns_topic.topics["thermal"].arn }
output "no_signal_topic_arn" { value = aws_sns_topic.topics["signal"].arn }
output "topic_arns" { value = { for key, topic in aws_sns_topic.topics : key => topic.arn } }
output "no_signal_alarm_arn" { value = module.no_signal_alarm.cloudwatch_metric_alarm_arn }

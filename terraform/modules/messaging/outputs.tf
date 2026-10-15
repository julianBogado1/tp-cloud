output "queue_url" { value = aws_sqs_queue.readings.url }
output "queue_arn" { value = aws_sqs_queue.readings.arn }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
output "thermal_topic_arn" { value = aws_sns_topic.topics["thermal"].arn }
output "topic_arns" { value = { for key, topic in aws_sns_topic.topics : key => topic.arn } }

variable "names" {
  type        = map(string)
  description = "Queue, DLQ and SNS topic names from local.names."
}
variable "kms_key_arn" {
  type        = string
  description = "Customer-managed key encrypting the queues and the topics. A CMK and not alias/aws/sns: CloudWatch alarms cannot publish to a topic encrypted with an AWS-managed key."
}
variable "subscription_email" {
  type        = string
  description = "Email subscribed to the thermal and no-signal topics. null creates no subscription."
  default     = null
  nullable    = true
}

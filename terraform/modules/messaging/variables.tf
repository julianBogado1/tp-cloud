variable "names" {
  type        = map(string)
  description = "Queue, DLQ and SNS topic names from local.names."
}
variable "subscription_email" {
  type        = string
  description = "Email subscribed to the thermal and no-signal topics. null creates no subscription."
  default     = null
  nullable    = true
}

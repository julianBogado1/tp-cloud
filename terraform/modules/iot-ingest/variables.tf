variable "names" {
  type        = map(string)
  description = "Resource names from local.names; this module uses iot_rule."
}
variable "units" {
  type        = set(string)
  description = "Cold-chain units: one IoT thing, certificate and pair of attachments per element."
}
variable "lab_role_arn" {
  type        = string
  description = "Learner Lab LabRole ARN assumed by the topic rule actions (DynamoDB, SQS and the error action)."
}
variable "telemetry_table_name" {
  type        = string
  description = "DynamoDB table receiving every reading (first dynamodbv2 action)."
}
variable "state_table_name" {
  type        = string
  description = "DynamoDB table holding the last reading per unit (second dynamodbv2 action)."
}
variable "kms_key_arn" {
  type        = string
  description = "Customer-managed key encrypting the rule error log group."
}
variable "queue_url" {
  type        = string
  description = "URL of the readings queue the rule publishes to, consumed by the alert-processor."
}

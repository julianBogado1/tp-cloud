variable "function_name" {
  type        = string
  description = "Lambda function name (also used for the /aws/lambda/<name> log group)."
}
variable "zip_path" {
  type        = string
  description = "Path to the deployment zip."
}
variable "handler" {
  type        = string
  description = "Handler entry point, e.g. index.handler."
  default     = "index.handler"
}
variable "runtime" {
  type        = string
  description = "Lambda runtime identifier."
  default     = "nodejs22.x"
}
variable "timeout" {
  type        = number
  description = "Function timeout in seconds."
}
variable "memory_size" {
  type        = number
  description = "Function memory in MB."
}
variable "environment" {
  type        = map(string)
  description = "Environment variables for the function."
  default     = {}
}
variable "lab_role_arn" {
  type        = string
  description = "Execution role ARN (Learner Lab LabRole)."
}
variable "kms_key_arn" {
  type        = string
  description = "Customer-managed key encrypting the function log group."
}
variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the function log group."
  default     = 14
}

variable "names" { type = map(string) }
variable "units" { type = set(string) }
variable "lab_role_arn" { type = string }
variable "telemetry_table_name" { type = string }
variable "state_table_name" { type = string }
variable "queue_url" { type = string }

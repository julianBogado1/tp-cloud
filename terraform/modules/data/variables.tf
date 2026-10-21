variable "table_names" {
  type        = map(string)
  description = "Table names from local.names; the keys ending in _table select the DynamoDB tables to create."
}
variable "seed_path" {
  type        = string
  description = "JSON file with the demo items loaded into the clients, units, users and device-config tables."
}

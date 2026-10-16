locals {
  definitions = {
    telemetry = { name = var.table_names.telemetry_table, hash = "unit_id", hash_type = "S", range = "ts", range_type = "S", ttl = "expires_at", gsis = [] }
    state     = { name = var.table_names.state_table, hash = "unit_id", hash_type = "S", range = null, range_type = null, ttl = null, gsis = [] }
    users     = { name = var.table_names.users_table, hash = "id", hash_type = "N", range = null, range_type = null, ttl = null, gsis = [{ name = "email-index", hash = "email_lower", type = "S", projection = "ALL" }] }
    clients   = { name = var.table_names.clients_table, hash = "id", hash_type = "N", range = null, range_type = null, ttl = null, gsis = [] }
    units     = { name = var.table_names.units_table, hash = "unit_id", hash_type = "S", range = null, range_type = null, ttl = null, gsis = [{ name = "client_id-index", hash = "client_id", type = "N", projection = "ALL" }] }
    alerts    = { name = var.table_names.alerts_table, hash = "id", hash_type = "N", range = null, range_type = null, ttl = null, gsis = [{ name = "client_id-emitted_at-index", hash = "client_id", type = "N", range = "emitted_at", range_type = "S", projection = "ALL" }] }
    config    = { name = var.table_names.config_table, hash = "unit_id", hash_type = "S", range = null, range_type = null, ttl = null, gsis = [] }
  }
  seed = jsondecode(file(var.seed_path))
  seed_items = merge(
    { for item in local.seed.clients : item.key => { table = "clients", item = item.item } },
    { for item in local.seed.units : item.key => { table = "units", item = item.item } },
    { for item in local.seed["device-config"] : item.key => { table = "config", item = item.item } },
    { for item in local.seed.users : item.key => { table = "users", item = item.item } }
  )
}
resource "aws_dynamodb_table" "this" {
  for_each     = local.definitions
  name         = each.value.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = each.value.hash
  range_key    = each.value.range
  attribute {
    name = each.value.hash
    type = each.value.hash_type
  }
  dynamic "attribute" {
    for_each = each.value.range == null ? [] : [each.value.range]
    content {
      name = attribute.value
      type = each.value.range_type
    }
  }
  dynamic "attribute" {
    for_each = each.value.gsis
    content {
      name = attribute.value.hash
      type = attribute.value.type
    }
  }
  dynamic "attribute" {
    for_each = [for gsi in each.value.gsis : gsi.range if try(gsi.range, null) != null]
    content {
      name = attribute.value
      type = "S"
    }
  }
  dynamic "global_secondary_index" {
    for_each = each.value.gsis
    content {
      name            = global_secondary_index.value.name
      hash_key        = global_secondary_index.value.hash
      range_key       = try(global_secondary_index.value.range, null)
      projection_type = global_secondary_index.value.projection
    }
  }
  dynamic "ttl" {
    for_each = each.value.ttl == null ? [] : [each.value.ttl]
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
}
resource "aws_dynamodb_table_item" "seed" {
  for_each   = local.seed_items
  table_name = aws_dynamodb_table.this[each.value.table].name
  hash_key   = local.definitions[each.value.table].hash
  range_key  = lookup(local.definitions[each.value.table], "range", null)
  item       = jsonencode(each.value.item)
  depends_on = [aws_dynamodb_table.this]
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_iot_endpoint" "this" {
  endpoint_type = "iot:Data-ATS"
}
resource "aws_iot_policy" "device" {
  name = "snowball-device-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:client/$${iot:Connection.Thing.ThingName}"
      },
      {
        Effect = "Allow"
        Action = "iot:Publish"
        Resource = [
          "arn:aws:iot:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:topic/snowball/$${iot:Connection.Thing.ThingName}/*",
          "arn:aws:iot:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:topic/$aws/things/$${iot:Connection.Thing.ThingName}/shadow/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "iot:Subscribe"
        Resource = "arn:aws:iot:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:topicfilter/$aws/things/$${iot:Connection.Thing.ThingName}/shadow/*"
      },
      {
        Effect   = "Allow"
        Action   = "iot:Receive"
        Resource = "arn:aws:iot:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:topic/$aws/things/$${iot:Connection.Thing.ThingName}/shadow/*"
      }
    ]
  })
}
resource "aws_iot_thing" "this" {
  for_each = var.units
  name     = each.value
}
resource "aws_iot_certificate" "this" {
  for_each = var.units
  active   = true
}
resource "aws_iot_thing_principal_attachment" "this" {
  for_each  = var.units
  thing     = aws_iot_thing.this[each.key].name
  principal = aws_iot_certificate.this[each.key].arn
}
resource "aws_iot_policy_attachment" "this" {
  for_each = var.units
  policy   = aws_iot_policy.device.name
  target   = aws_iot_certificate.this[each.key].arn
}
resource "aws_cloudwatch_log_group" "errors" {
  name              = "/aws/iot/snowball-iot-errors"
  retention_in_days = 14
  kms_key_id        = var.kms_key_arn
}
resource "aws_iot_topic_rule" "telemetry" {
  name        = var.names.iot_rule
  enabled     = true
  sql         = "SELECT *, topic(2) AS unit_id, floor(timestamp() / 1000) + 2592000 AS expires_at FROM 'snowball/+/telemetry'"
  sql_version = "2016-03-23"
  dynamodbv2 {
    role_arn = var.lab_role_arn
    put_item {
      table_name = var.telemetry_table_name
    }
  }
  dynamodbv2 {
    role_arn = var.lab_role_arn
    put_item {
      table_name = var.state_table_name
    }
  }
  sqs {
    queue_url  = var.queue_url
    role_arn   = var.lab_role_arn
    use_base64 = false
  }
  error_action {
    cloudwatch_logs {
      log_group_name = aws_cloudwatch_log_group.errors.name
      role_arn       = var.lab_role_arn
    }
  }
}

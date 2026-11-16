# Operational monitoring: infrastructure health, as opposed to the business
# alerts (thermal excursion, per-unit no signal) that the Lambdas publish
# themselves because their thresholds are per unit and live in DynamoDB.
#
# Everything here goes to one ops topic so infra failures do not mix with the
# cold-chain alerts. The topic is encrypted with the project CMK, whose key
# policy already lets cloudwatch.amazonaws.com publish.

resource "aws_sns_topic" "ops" {
  name              = "snowball-ops-alerts"
  kms_master_key_id = aws_kms_key.main.arn
}

resource "aws_sns_topic_subscription" "ops_email" {
  count     = var.sns_subscription_email == null ? 0 : 1
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.sns_subscription_email
}

# Failed IoT rule actions land in this log group (error_action). One matching
# event is one failed action, so it becomes a counter an alarm can watch.
resource "aws_cloudwatch_log_metric_filter" "iot_rule_failures" {
  name           = "snowball-iot-rule-failures"
  log_group_name = module.iot_ingest.errors_log_group_name
  pattern        = ""
  metric_transformation {
    name          = "IotRuleActionFailures"
    namespace     = "Snowball"
    value         = "1"
    default_value = "0"
  }
}

locals {
  # Every Lambda in the stack: the three pipeline functions and the login bridge.
  monitored_lambdas = merge(
    { for key, fn in module.lambda : key => fn.function_name },
    { "auth-callback" = module.auth_callback.function_name },
  )

  alb_dimensions = tomap({
    LoadBalancer = module.compute.alb_arn_suffix
    TargetGroup  = module.compute.target_group_arn_suffix
  })

  ops_alarms = merge(
    {
      "dlq-not-empty" = {
        description = "Readings failed 5 times and landed in the dead-letter queue."
        namespace   = "AWS/SQS"
        metric      = "ApproximateNumberOfMessagesVisible"
        dimensions  = tomap({ QueueName = local.names.readings_dlq })
        statistic   = "Maximum"
        period      = 60
        periods     = 1
        threshold   = 0
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
      "queue-backlog" = {
        description = "The oldest reading has waited more than 2 minutes: alert-processor is falling behind."
        namespace   = "AWS/SQS"
        metric      = "ApproximateAgeOfOldestMessage"
        dimensions  = tomap({ QueueName = local.names.readings_queue })
        statistic   = "Maximum"
        period      = 60
        periods     = 3
        threshold   = 120
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
      "alb-unhealthy-hosts" = {
        description = "At least one API instance is failing the ALB health check."
        namespace   = "AWS/ApplicationELB"
        metric      = "UnHealthyHostCount"
        dimensions  = local.alb_dimensions
        statistic   = "Maximum"
        period      = 60
        periods     = 3
        threshold   = 0
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
      "alb-no-healthy-hosts" = {
        description = "No healthy API instance behind the ALB: the dashboard has no backend."
        namespace   = "AWS/ApplicationELB"
        metric      = "HealthyHostCount"
        dimensions  = local.alb_dimensions
        statistic   = "Minimum"
        period      = 60
        periods     = 3
        threshold   = 1
        operator    = "LessThanThreshold"
        missing     = "breaching"
      }
      "alb-5xx" = {
        description = "The API answered more than 5 server errors in 5 minutes."
        namespace   = "AWS/ApplicationELB"
        metric      = "HTTPCode_Target_5XX_Count"
        dimensions  = tomap({ LoadBalancer = module.compute.alb_arn_suffix })
        statistic   = "Sum"
        period      = 300
        periods     = 1
        threshold   = 5
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
      "auth-api-5xx" = {
        description = "The Cognito login bridge (API Gateway) returned server errors."
        namespace   = "AWS/ApiGateway"
        metric      = "5xx"
        dimensions  = tomap({ ApiId = aws_apigatewayv2_api.auth.id })
        statistic   = "Sum"
        period      = 300
        periods     = 1
        threshold   = 0
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
      "iot-rule-failures" = {
        description = "An IoT topic rule action (DynamoDB or SQS) failed: readings arrive but are not stored."
        namespace   = "Snowball"
        metric      = "IotRuleActionFailures"
        dimensions  = tomap({})
        statistic   = "Sum"
        period      = 300
        periods     = 1
        threshold   = 0
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
      "scheduler-target-errors" = {
        description = "EventBridge Scheduler could not invoke the no-signal monitor or the telemetry export."
        namespace   = "AWS/Scheduler"
        metric      = "TargetErrorCount"
        dimensions  = tomap({ ScheduleGroup = "default" })
        statistic   = "Sum"
        period      = 300
        periods     = 1
        threshold   = 0
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
      }
    },
    { for key, name in local.monitored_lambdas : "lambda-errors-${key}" => {
      description = "Lambda ${name} finished with errors."
      namespace   = "AWS/Lambda"
      metric      = "Errors"
      dimensions  = tomap({ FunctionName = name })
      statistic   = "Sum"
      period      = 300
      periods     = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
    } },
    { for key, table in { telemetry = local.names.telemetry_table, state = local.names.state_table } :
      "dynamodb-throttles-${key}" => {
        description = "DynamoDB rejected writes to ${table} (throttling)."
        namespace   = "AWS/DynamoDB"
        metric      = "WriteThrottleEvents"
        dimensions  = tomap({ TableName = table })
        statistic   = "Sum"
        period      = 300
        periods     = 1
        threshold   = 0
        operator    = "GreaterThanThreshold"
        missing     = "notBreaching"
    } },
  )
}

module "ops_alarm" {
  source   = "terraform-aws-modules/cloudwatch/aws//modules/metric-alarm"
  version  = "~> 5.0"
  for_each = local.ops_alarms

  alarm_name          = "snowball-ops-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = each.value.operator
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.iot_rule_failures]
}

# One screen for a demo: the whole path from the device to the dashboard.
resource "aws_cloudwatch_dashboard" "ops" {
  dashboard_name = "snowball"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "Readings entering the queue"
          region = data.aws_region.current.region
          view   = "timeSeries"
          stat   = "Sum"
          period = 60
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", local.names.readings_queue],
            ["AWS/SQS", "NumberOfMessagesDeleted", "QueueName", local.names.readings_queue],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "Backlog and dead-letter queue"
          region = data.aws_region.current.region
          view   = "timeSeries"
          stat   = "Maximum"
          period = 60
          metrics = [
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", local.names.readings_queue],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.names.readings_dlq, { label = "DLQ messages" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title   = "Lambda invocations"
          region  = data.aws_region.current.region
          view    = "timeSeries"
          stat    = "Sum"
          period  = 60
          metrics = [for key, name in local.monitored_lambdas : ["AWS/Lambda", "Invocations", "FunctionName", name, { label = key }]]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title   = "Lambda errors"
          region  = data.aws_region.current.region
          view    = "timeSeries"
          stat    = "Sum"
          period  = 300
          metrics = [for key, name in local.monitored_lambdas : ["AWS/Lambda", "Errors", "FunctionName", name, { label = key }]]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "API behind the ALB"
          region = data.aws_region.current.region
          view   = "timeSeries"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", module.compute.alb_arn_suffix, { stat = "Sum" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", module.compute.alb_arn_suffix, { stat = "Sum" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", module.compute.alb_arn_suffix, "TargetGroup", module.compute.target_group_arn_suffix, { stat = "Minimum" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title  = "DynamoDB writes (telemetry and state)"
          region = data.aws_region.current.region
          view   = "timeSeries"
          stat   = "Sum"
          period = 60
          metrics = [
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", local.names.telemetry_table],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", local.names.state_table],
          ]
        }
      },
      {
        type = "alarm", x = 0, y = 18, width = 24, height = 6
        properties = {
          title  = "Alarms"
          alarms = concat([module.messaging.no_signal_alarm_arn], [for a in module.ops_alarm : a.cloudwatch_metric_alarm_arn])
        }
      },
    ]
  })
}

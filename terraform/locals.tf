locals {
  common_tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Phase     = "delivery-3"
  }
  names = {
    telemetry_table = "snowball-telemetry"
    state_table     = "snowball-unit-state"
    users_table     = "snowball-users"
    clients_table   = "snowball-clients"
    units_table     = "snowball-units"
    alerts_table    = "snowball-alerts"
    config_table    = "snowball-device-config"
    readings_queue  = "snowball-readings"
    readings_dlq    = "snowball-readings-dlq"
    thermal_topic   = "snowball-thermal-excursion"
    battery_topic   = "snowball-low-battery"
    signal_topic    = "snowball-no-signal"
    iot_rule        = "snowball_telemetry"
  }
  units = toset(var.unit_ids)
  bucket_names = {
    dashboard = "snowball-dashboard-${var.bucket_suffix}"
    artifacts = "snowball-artifacts-${var.bucket_suffix}"
    archive   = "snowball-archive-${var.bucket_suffix}"
  }
  lambdas = {
    "telemetry-export" = {
      function_name = "snowball-telemetry-export"
      zip_path      = var.lambda_zip_path
      timeout       = 300
      memory_size   = 512
      environment = {
        ARCHIVE_BUCKET  = aws_s3_bucket_lifecycle_configuration.archive.bucket
        DDB_TABLE       = module.data.table_names.telemetry
        DDB_STATE_TABLE = module.data.table_names.state
      }
    }
    "alert-processor" = {
      function_name = "snowball-alert-processor"
      zip_path      = var.alert_lambda_zip_path
      timeout       = 30 # SQS visibility timeout (180 s) must stay >= 6x this value
      memory_size   = 256
      environment = {
        SNS_THERMAL_EXCURSION_TOPIC_ARN = module.messaging.thermal_topic_arn
        DDB_TABLE                       = module.data.table_names.telemetry
        DDB_DEVICE_CONFIG_TABLE         = module.data.table_names.config
        DDB_UNITS_TABLE                 = module.data.table_names.units
        DDB_ALERTS_TABLE                = module.data.table_names.alerts
      }
    }
  }
}

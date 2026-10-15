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
  units = toset(["SB-001", "SB-002", "SB-003"])
  bucket_names = {
    dashboard = "snowball-dashboard-${var.bucket_suffix}"
    artifacts = "snowball-artifacts-${var.bucket_suffix}"
    archive   = "snowball-archive-${var.bucket_suffix}"
  }
}

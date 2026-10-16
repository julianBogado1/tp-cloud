output "iot_endpoint" {
  value = data.aws_iot_endpoint.this.endpoint_address
}
output "certificates" {
  value     = { for unit, cert in aws_iot_certificate.this : unit => cert.certificate_pem }
  sensitive = true
}
output "private_keys" {
  value     = { for unit, cert in aws_iot_certificate.this : unit => cert.private_key }
  sensitive = true
}
output "certificate_arns" {
  value     = { for unit, cert in aws_iot_certificate.this : unit => cert.arn }
  sensitive = true
}

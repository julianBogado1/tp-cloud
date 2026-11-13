data "aws_region" "current" {}
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["137112412989"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
locals {
  ami = var.ami_id != null ? var.ami_id : data.aws_ami.al2023.id
}
resource "aws_s3_object" "api" {
  bucket       = var.artifact_bucket
  key          = "api.bundle.js"
  source       = var.api_bundle_path
  source_hash  = filemd5(var.api_bundle_path)
  content_type = "application/javascript"
}
resource "aws_lb_target_group" "app" {
  name     = "snowball-app-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = var.vpc_id
  health_check {
    path     = "/health"
    protocol = "HTTP"
    port     = "3000"
  }
}
# Internet-facing on purpose: this is the public entry point of the API. The
# listener below is plain HTTP for the same reason it has always been: the
# Learner Lab gives us no domain and no ACM certificate to terminate TLS on,
# and ACM will not issue one for the *.elb.amazonaws.com name of the balancer.
#tfsec:ignore:aws-elb-alb-not-public
#tfsec:ignore:AVD-AWS-0053
resource "aws_lb" "app" {
  name                       = "snowball-alb"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
}
#tfsec:ignore:aws-elb-http-not-used
#tfsec:ignore:AVD-AWS-0054
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
resource "aws_launch_template" "app" {
  name                   = "snowball-app-lt"
  image_id               = local.ami
  instance_type          = var.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [var.app_security_group_id]
  iam_instance_profile {
    name = var.lab_instance_profile
  }
  # IMDSv2 only. One hop is enough: the API runs on the instance itself, so
  # nothing nested has to reach the credentials endpoint.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  # api_bundle_md5 is rendered as a comment so a new bundle creates a new launch
  # template version, which triggers the ASG instance refresh.
  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    region          = data.aws_region.current.region
    artifact_bucket = var.artifact_bucket
    api_bundle_md5  = filemd5(var.api_bundle_path)
    jwt_secret      = var.jwt_secret
    cors_origin     = var.cors_origin
    telemetry_table = var.table_names.telemetry
    state_table     = var.table_names.state
    users_table     = var.table_names.users
    clients_table   = var.table_names.clients
    units_table     = var.table_names.units
    alerts_table    = var.table_names.alerts
    config_table    = var.table_names.config
    iot_endpoint    = var.iot_endpoint
  }))
  # default_tags do not reach instances launched by the ASG.
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "snowball-app" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "snowball-app" })
  }
  lifecycle {
    create_before_destroy = true
  }
  depends_on = [aws_s3_object.api]
}
resource "aws_autoscaling_group" "app" {
  name                = "snowball-app-asg"
  min_size            = var.asg_min_size
  max_size            = var.asg_max_size
  desired_capacity    = var.asg_desired_capacity
  vpc_zone_identifier = var.subnet_ids
  target_group_arns   = [aws_lb_target_group.app.arn]
  health_check_type   = "ELB"
  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
  }
  # No `instance_refresh`: the Learner Lab SCP denies autoscaling:StartInstanceRefresh,
  # which the provider calls on every change to this group, so the block made each
  # apply end with AccessDenied even though the group itself was created fine.
  # The cost is that a new launch template version does not roll out by itself:
  # after changing the API bundle or the user data, replace the instances by hand
  # (terminate them and let the group bring them back on the latest version).
}
resource "aws_instance" "bastion" {
  count                       = var.enable_bastion ? 1 : 0
  ami                         = local.ami
  instance_type               = "t3.micro"
  key_name                    = var.key_name
  subnet_id                   = var.public_subnet_ids[0]
  vpc_security_group_ids      = [var.bastion_security_group_id]
  associate_public_ip_address = true
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }
  tags = { Name = "snowball-bastion" }
}

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
resource "aws_s3_object" "alert" {
  bucket       = var.artifact_bucket
  key          = "alert-processor.bundle.js"
  source       = var.alert_bundle_path
  source_hash  = filemd5(var.alert_bundle_path)
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
resource "aws_lb" "app" {
  name               = "snowball-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids
}
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
  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    region            = data.aws_region.current.region
    artifact_bucket   = var.artifact_bucket
    queue_url         = var.queue_url
    thermal_topic_arn = var.thermal_topic_arn
    jwt_secret        = var.jwt_secret
    telemetry_table   = var.table_names.telemetry
    state_table       = var.table_names.state
    users_table       = var.table_names.users
    clients_table     = var.table_names.clients
    units_table       = var.table_names.units
    alerts_table      = var.table_names.alerts
    config_table      = var.table_names.config
  }))
  lifecycle {
    create_before_destroy = true
  }
  depends_on = [aws_s3_object.api, aws_s3_object.alert]
}
resource "aws_autoscaling_group" "app" {
  name                = "snowball-app-asg"
  min_size            = 2
  max_size            = 4
  desired_capacity    = 2
  vpc_zone_identifier = var.subnet_ids
  target_group_arns   = [aws_lb_target_group.app.arn]
  health_check_type   = "ELB"
  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }
}
resource "aws_instance" "bastion" {
  count                       = var.enable_bastion ? 1 : 0
  ami                         = local.ami
  instance_type               = "t3.micro"
  key_name                    = var.key_name
  subnet_id                   = var.public_subnet_ids[0]
  vpc_security_group_ids      = [var.bastion_security_group_id]
  associate_public_ip_address = true
  tags                        = { Name = "snowball-bastion" }
}

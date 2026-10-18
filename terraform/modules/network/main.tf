locals {
  subnets = {
    public_a = { name = "snowball-public-a", cidr = cidrsubnet(var.vpc_cidr, 8, 1), az = var.availability_zones[0], public = true }
    public_b = { name = "snowball-public-b", cidr = cidrsubnet(var.vpc_cidr, 8, 2), az = var.availability_zones[1], public = true }
    app_a    = { name = "snowball-app-a", cidr = cidrsubnet(var.vpc_cidr, 8, 11), az = var.availability_zones[0], public = false }
    app_b    = { name = "snowball-app-b", cidr = cidrsubnet(var.vpc_cidr, 8, 12), az = var.availability_zones[1], public = false }
  }
}
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}
resource "aws_subnet" "this" {
  for_each                = local.subnets
  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value.cidr
  availability_zone       = each.value.az
  map_public_ip_on_launch = each.value.public
  tags                    = { Name = each.value.name, Tier = each.value.public ? "public" : "application" }
}
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "igw-snowball" }
}
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat-snowball-a" }
}
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.this["public_a"].id
  depends_on    = [aws_internet_gateway.this]
  tags          = { Name = "nat-snowball-a" }
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "rt-public" }
}
resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}
resource "aws_route_table_association" "public" {
  for_each       = toset(["public_a", "public_b"])
  subnet_id      = aws_subnet.this[each.key].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "app" {
  for_each = { app_a = "rt-app-a", app_b = "rt-app-b" }
  vpc_id   = aws_vpc.this.id
  tags     = { Name = each.value }
}
resource "aws_route" "app_default" {
  for_each               = aws_route_table.app
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}
resource "aws_route_table_association" "app" {
  for_each       = toset(["app_a", "app_b"])
  subnet_id      = aws_subnet.this[each.key].id
  route_table_id = aws_route_table.app[each.key].id
}
data "aws_region" "current" {}
resource "aws_vpc_endpoint" "gateway" {
  for_each          = { s3 = "com.amazonaws.${data.aws_region.current.region}.s3", dynamodb = "com.amazonaws.${data.aws_region.current.region}.dynamodb" }
  vpc_id            = aws_vpc.this.id
  service_name      = each.value
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for route_table in aws_route_table.app : route_table.id]
  tags              = { Name = each.key == "s3" ? "vpce-s3" : "vpce-ddb" }
}
resource "aws_security_group" "alb" {
  name        = "${var.project}-sg-alb"
  description = "ALB ingress"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "sg-alb" }
}
resource "aws_security_group_rule" "alb_http" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  protocol          = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_blocks       = ["0.0.0.0/0"]
}
resource "aws_security_group_rule" "alb_egress" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 3000
  to_port                  = 3000
  source_security_group_id = aws_security_group.app.id
}
resource "aws_security_group" "app" {
  name        = "${var.project}-sg-app"
  description = "Private application instances"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "sg-app" }
}
resource "aws_security_group_rule" "app_http" {
  type                     = "ingress"
  security_group_id        = aws_security_group.app.id
  protocol                 = "tcp"
  from_port                = 3000
  to_port                  = 3000
  source_security_group_id = aws_security_group.alb.id
}
resource "aws_security_group_rule" "app_ssh" {
  type                     = "ingress"
  security_group_id        = aws_security_group.app.id
  protocol                 = "tcp"
  from_port                = 22
  to_port                  = 22
  source_security_group_id = aws_security_group.bastion.id
}
resource "aws_security_group_rule" "app_https" {
  type              = "egress"
  security_group_id = aws_security_group.app.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = ["0.0.0.0/0"]
}
resource "aws_security_group" "bastion" {
  name        = "${var.project}-sg-bastion"
  description = "Optional administration bastion"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "sg-bastion" }
}
resource "aws_security_group_rule" "bastion_ssh_in" {
  type              = "ingress"
  security_group_id = aws_security_group.bastion.id
  protocol          = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_blocks       = [var.bastion_allowed_cidr]
}
resource "aws_security_group_rule" "bastion_ssh_out" {
  type                     = "egress"
  security_group_id        = aws_security_group.bastion.id
  protocol                 = "tcp"
  from_port                = 22
  to_port                  = 22
  source_security_group_id = aws_security_group.app.id
}

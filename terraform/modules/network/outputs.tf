output "vpc_id" { value = aws_vpc.this.id }
output "public_subnet_ids" { value = [for key in ["public_a", "public_b"] : aws_subnet.this[key].id] }
output "app_subnet_ids" { value = [for key in ["app_a", "app_b"] : aws_subnet.this[key].id] }
output "alb_security_group_id" { value = aws_security_group.alb.id }
output "app_security_group_id" { value = aws_security_group.app.id }
output "bastion_security_group_id" { value = aws_security_group.bastion.id }

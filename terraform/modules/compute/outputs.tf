output "alb_dns_name" { value = aws_lb.app.dns_name }
output "target_group_arn" { value = aws_lb_target_group.app.arn }
output "launch_template_id" { value = aws_launch_template.app.id }
output "bastion_instance_id" { value = try(aws_instance.bastion[0].id, null) }

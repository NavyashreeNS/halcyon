output "vpc_id" {
  description = "VPC hosting the Halcyon fleet."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnets for cluster workloads and the database."
  value       = aws_subnet.private[*].id
}

output "database_endpoint" {
  description = "Postgres endpoint for the control plane."
  value       = aws_db_instance.main.endpoint
}

output "database_secret_arn" {
  description = <<-EOT
    Secrets Manager ARN holding the master credentials. Deliberately the ARN and not the
    secret: an output is stored in plaintext in state and printed by `terraform output`.
  EOT
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "ecr_repository_urls" {
  description = "Container registry URLs, keyed by service."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}

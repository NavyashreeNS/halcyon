variable "region" {
  description = "AWS region. Defaults to Mumbai for latency to Indian users."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment. Drives HA, backup retention and deletion protection."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "gpu_instance_types" {
  description = <<-EOT
    Instance types for the GPU node group, in preference order. Several are listed because
    accelerator capacity is genuinely scarce in most regions — a node group pinned to one
    type will simply fail to scale when that type is unavailable.
  EOT
  type        = list(string)
  default     = ["g5.2xlarge", "g5.4xlarge", "g6.2xlarge"]
}

/**
 * Halcyon infrastructure.
 *
 * Scoped to the pieces that are genuinely stateful or security-relevant — the network, the
 * database, the GPU node group, the registry. Application workloads are deliberately *not*
 * defined here: Terraform's plan/apply cycle is a poor fit for something that redeploys many
 * times a day, and splitting slow-moving infrastructure from fast-moving workloads is what
 * keeps a routine deploy from ever needing to touch the VPC.
 */

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Remote state with locking. Local state in a repository is how two engineers end up
  # applying conflicting plans and one of them silently destroys the other's resources.
  backend "s3" {
    key          = "halcyon/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "halcyon"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "halcyon-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 3)
}

# --- Network --------------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = local.name }
}

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = local.azs[count.index]

  tags = {
    Name                              = "${local.name}-private-${local.azs[count.index]}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index + length(local.azs))
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${local.name}-public-${local.azs[count.index]}"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# One NAT gateway per AZ in production. A single shared NAT is cheaper, but it is also a
# zonal single point of failure for every private subnet — and cross-AZ NAT traffic is
# billed, so the saving is smaller than it looks.
resource "aws_eip" "nat" {
  count  = var.environment == "prod" ? length(local.azs) : 1
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count = var.environment == "prod" ? length(local.azs) : 1

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = "${local.name}-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  count  = length(local.azs)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[var.environment == "prod" ? count.index : 0].id
  }

  tags = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_route_table_association" "public" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# --- Database -------------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "Postgres access from within the VPC only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Postgres from cluster workloads"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "17.2"
  instance_class = var.database_instance_class

  allocated_storage     = 50
  max_allocated_storage = 500
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "halcyon"
  username = "halcyon"
  # Credentials are generated and rotated by Secrets Manager rather than being passed in as
  # a variable, which would place them in plan output and in state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  multi_az               = var.environment == "prod"

  backup_retention_period = var.environment == "prod" ? 30 : 7
  backup_window           = "17:00-18:00" # Off-peak for IST-centric traffic.
  maintenance_window      = "Sun:18:30-Sun:19:30"

  performance_insights_enabled = true
  deletion_protection          = var.environment == "prod"
  skip_final_snapshot          = var.environment != "prod"
  final_snapshot_identifier    = var.environment == "prod" ? "${local.name}-final" : null

  # The control plane writes request logs continuously; auto-minor-version upgrades during
  # a traffic peak are a self-inflicted incident.
  auto_minor_version_upgrade = false
  apply_immediately          = false
}

# --- Container registry -----------------------------------------------------------------------

resource "aws_ecr_repository" "this" {
  for_each = toset(["gateway", "worker", "web"])

  name                 = "halcyon/${each.key}"
  image_tag_mutability = "IMMUTABLE" # A deployed tag must always mean the same bytes.

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the 30 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

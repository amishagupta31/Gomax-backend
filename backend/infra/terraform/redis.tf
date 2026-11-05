# Memorystore (Redis 7): shared rate-limit counters across Cloud Run
# instances. Private IP only, password (AUTH) on. Cloud Run reaches it with
# Direct VPC egress (run.tf); Supabase traffic still goes out to the internet.
data "google_compute_network" "vpc" {
  name       = var.network
  depends_on = [google_project_service.apis]
}

resource "google_redis_instance" "cache" {
  name               = "gomax-${var.env}"
  tier               = var.redis_tier
  memory_size_gb     = 1
  region             = var.region
  redis_version      = "REDIS_7_2"
  authorized_network = data.google_compute_network.vpc.id
  connect_mode       = "DIRECT_PEERING"
  auth_enabled       = true

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours   = 21 # 2:30 am IST
        minutes = 0
      }
    }
  }

  depends_on = [google_project_service.apis]
}

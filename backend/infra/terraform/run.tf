# Cloud Run service (the API) and job (database migrations). Cloud Build
# swaps the image on each release; Terraform owns everything else.
locals {
  bootstrap_image = "us-docker.pkg.dev/cloudrun/container/hello" # replaced by the first Cloud Build run
  behind_lb       = var.api_domain != ""
  public_url      = local.behind_lb ? "https://${var.api_domain}" : google_cloud_run_v2_service.api.uri

  plain_env = {
    NODE_ENV            = "production"
    APP_ENV             = var.env
    DB_POOL_MAX         = tostring(var.db_pool_per_instance)
    STORAGE_DRIVER      = "gcs"
    STORAGE_BUCKET      = google_storage_bucket.files.name
    WHATSAPP_DRIVER     = var.whatsapp_driver
    WA_PHONE_NUMBER_ID  = var.wa_phone_number_id
    JOBS_AUDIENCE       = var.jobs_audience
    JOBS_INVOKER_EMAIL  = google_service_account.scheduler.email
    CORS_ORIGINS        = var.cors_origins
    APP_LINK_BASE       = var.app_link_base
    FIREBASE_PROJECT_ID = var.firebase_project_id
    PAYOUT_MODE         = var.payout_mode
    KYC_DRIVER          = var.kyc_driver
  }

  # Razorpay env only when it is switched on (its secrets hold "unset" until filled).
  razorpay_on    = var.payout_mode == "razorpayx" || var.kyc_driver == "razorpay"
  razorpay_plain = local.razorpay_on ? { RAZORPAYX_ACCOUNT_NUMBER = var.razorpayx_account_number } : {}
  razorpay_secret = local.razorpay_on ? {
    RAZORPAY_KEY_ID         = "gomax-razorpay-key-id"
    RAZORPAY_KEY_SECRET     = "gomax-razorpay-key-secret"
    RAZORPAY_WEBHOOK_SECRET = "gomax-razorpay-webhook-secret"
  } : {}
  static_egress = coalesce(var.static_egress_ip, local.razorpay_on)

  secret_env = {
    DATABASE_URL    = "gomax-database-url"
    DIRECT_URL      = "gomax-direct-url"
    DB_CA_CERT      = "gomax-db-ca-cert"
    REDIS_URL       = "gomax-redis-url"
    JWT_SECRET      = "gomax-jwt-secret"
    PAN_KEY         = "gomax-pan-key"
    WA_VERIFY_TOKEN = "gomax-wa-verify-token"
    WA_TOKEN        = "gomax-wa-token"
    WA_APP_SECRET   = "gomax-wa-app-secret"
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = local.name
  location = var.region
  # With a domain, traffic must come through the load balancer (Cloud Armor);
  # the *.run.app URL stops answering.
  ingress             = local.behind_lb ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.api.email
    timeout                          = "30s"
    max_instance_request_concurrency = 80
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    # Direct VPC egress: private ranges (Memorystore) via the VPC, everything
    # else (Supabase, WhatsApp, Google APIs) straight out — or, with a static
    # egress IP (nat.tf), everything through the VPC and Cloud NAT.
    vpc_access {
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
      egress = local.static_egress ? "ALL_TRAFFIC" : "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.bootstrap_image
      ports {
        container_port = 8080
      }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = merge(local.plain_env, local.razorpay_plain)
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = merge(local.secret_env, local.razorpay_secret)
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      # A new revision only gets traffic once it can reach Supabase and Redis.
      startup_probe {
        http_get {
          path = "/readyz"
        }
        initial_delay_seconds = 2
        period_seconds        = 3
        timeout_seconds       = 3
        failure_threshold     = 10
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, template[0].revision, traffic, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.api_reads]
}

# The app and admin site authenticate every request themselves (JWT), so the
# service accepts unauthenticated HTTPS — from the load balancer only, when one is set.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_job" "migrate" {
  name                = "gomax-migrate"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.api.email
      max_retries     = 0
      timeout         = "600s"
      containers {
        image   = local.bootstrap_image
        command = ["node"]
        args    = ["dist/db/migrate.js"]
        dynamic "env" {
          for_each = { for k, v in local.plain_env : k => v if contains(["NODE_ENV", "STORAGE_DRIVER", "JOBS_AUDIENCE"], k) }
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = { for k, v in local.secret_env : k => v if contains(["DATABASE_URL", "DIRECT_URL", "DB_CA_CERT", "REDIS_URL", "JWT_SECRET", "PAN_KEY"], k) }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, template[0].template[0].containers[0].args, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.api_reads]
}

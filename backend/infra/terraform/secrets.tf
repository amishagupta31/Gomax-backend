# Secrets the API reads as env vars.
#  - generated: created here.
#  - manual: Terraform creates them with the value "unset"; paste the real
#    values once (README → Deploy, step 3), e.g.
#      echo -n "<value>" | gcloud secrets versions add gomax-database-url --data-file=-
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_id" "pan_key" {
  byte_length = 32 # AES-256 key for PAN numbers at rest
}

resource "random_password" "wa_verify" {
  length  = 32
  special = false
}

locals {
  generated = {
    "gomax-jwt-secret"      = random_password.jwt.result
    "gomax-pan-key"         = random_id.pan_key.b64_std
    "gomax-wa-verify-token" = random_password.wa_verify.result
    "gomax-redis-url"       = "redis://:${google_redis_instance.cache.auth_string}@${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
  }
  manual = [
    "gomax-database-url",            # Supabase → Connect → Transaction pooler (port 6543)
    "gomax-direct-url",              # Supabase → Connect → Session pooler (port 5432) — migrations
    "gomax-db-ca-cert",              # Supabase → Database settings → SSL → Download certificate
    "gomax-wa-token",                # Meta WhatsApp permanent token
    "gomax-wa-app-secret",           # Meta app secret (webhook signatures)
    "gomax-razorpay-key-id",         # Razorpay → Account & Settings → API Keys (rzp_live_…)
    "gomax-razorpay-key-secret",     # shown once when the key is generated
    "gomax-razorpay-webhook-secret", # RazorpayX → Settings → Webhooks → the secret you set
  ]
}

resource "google_secret_manager_secret" "generated" {
  for_each  = local.generated
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated
  secret      = google_secret_manager_secret.generated[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret" "manual" {
  for_each  = toset(local.manual)
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "manual_placeholder" {
  for_each    = toset(local.manual)
  secret      = google_secret_manager_secret.manual[each.key].id
  secret_data = "unset"
  lifecycle {
    ignore_changes = [secret_data, enabled]
  }
}

resource "google_secret_manager_secret_iam_member" "api_reads" {
  for_each  = merge(google_secret_manager_secret.generated, google_secret_manager_secret.manual)
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

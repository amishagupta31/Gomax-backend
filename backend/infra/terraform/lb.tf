# HTTPS load balancer + Cloud Armor in front of Cloud Run. Created only when
# var.api_domain is set (e.g. api.gomax.app); point the domain's A record at
# the `api_ip` output and Google issues the TLS certificate.
locals {
  lb = local.behind_lb ? 1 : 0
}

resource "google_compute_region_network_endpoint_group" "api" {
  count                 = local.lb
  name                  = "gomax-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_security_policy" "api" {
  count = local.lb
  name  = "gomax-api-armor"
  type  = "CLOUD_ARMOR"

  # Per-IP throttle at the edge (the API has its own, finer limits in Redis).
  rule {
    priority = 1000
    action   = "throttle"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = var.armor_requests_per_minute
        interval_sec = 60
      }
    }
    description = "Per-IP request cap"
  }

  # OWASP rules — start at sensitivity 1 to avoid blocking real app traffic.
  rule {
    priority = 2000
    action   = "deny(403)"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "SQL injection"
  }

  rule {
    priority = 2001
    action   = "deny(403)"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "Cross-site scripting"
  }

  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = true
    }
  }
}

resource "google_compute_backend_service" "api" {
  count                 = local.lb
  name                  = "gomax-api-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.api[0].id
  backend {
    group = google_compute_region_network_endpoint_group.api[0].id
  }
  log_config {
    enable      = true
    sample_rate = 0.2
  }
}

resource "google_compute_url_map" "api" {
  count           = local.lb
  name            = "gomax-api"
  default_service = google_compute_backend_service.api[0].id
}

resource "google_compute_managed_ssl_certificate" "api" {
  count = local.lb
  name  = "gomax-api-cert"
  managed {
    domains = [var.api_domain]
  }
}

resource "google_compute_target_https_proxy" "api" {
  count            = local.lb
  name             = "gomax-api-https"
  url_map          = google_compute_url_map.api[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.api[0].id]
}

resource "google_compute_global_address" "api" {
  count = local.lb
  name  = "gomax-api-ip"
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = local.lb
  name                  = "gomax-api-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.api[0].id
  ip_address            = google_compute_global_address.api[0].id
  port_range            = "443"
}

# http:// → https://
resource "google_compute_url_map" "redirect" {
  count = local.lb
  name  = "gomax-api-redirect"
  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  count   = local.lb
  name    = "gomax-api-http"
  url_map = google_compute_url_map.redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count                 = local.lb
  name                  = "gomax-api-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.redirect[0].id
  ip_address            = google_compute_global_address.api[0].id
  port_range            = "80"
}

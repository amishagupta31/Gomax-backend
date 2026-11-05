# Alerts (emailed to var.alert_email): uptime of /readyz, 5xx rate, p99 latency.
resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "GoMax on-call"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

locals {
  channels   = google_monitoring_notification_channel.email[*].id
  run_filter = "monitored_resource=\"cloud_run_revision\",service_name=\"${local.name}\""
}

resource "google_monitoring_uptime_check_config" "ready" {
  display_name = "gomax-api /readyz"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimprefix(local.public_url, "https://")
    }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name          = "GoMax API down (/readyz failing)"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.ready.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "120s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "errors" {
  display_name          = "GoMax API 5xx above 1%"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "5xx ratio > 1% for 5 min"
    condition_prometheus_query_language {
      query    = "sum(rate(run_googleapis_com:request_count{${local.run_filter},response_code_class=\"5xx\"}[5m])) / sum(rate(run_googleapis_com:request_count{${local.run_filter}}[5m])) > 0.01"
      duration = "300s"
    }
  }
}

resource "google_monitoring_alert_policy" "latency" {
  display_name          = "GoMax API slow (p99 > 1 s)"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "p99 latency > 1000 ms for 10 min"
    condition_prometheus_query_language {
      query    = "histogram_quantile(0.99, sum by (le) (rate(run_googleapis_com:request_latencies_bucket{${local.run_filter}}[5m]))) > 1000"
      duration = "600s"
    }
  }
}

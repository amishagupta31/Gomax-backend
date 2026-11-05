# Cloud Scheduler → POST /internal/jobs/<name> with an OIDC token signed for
# the gomax-scheduler account. The API checks audience + email.
locals {
  jobs = {
    outbox          = { schedule = "* * * * *", description = "Send queued WhatsApp messages" }
    "daily-summary" = { schedule = "0 21 * * *", description = "9 pm: today's coupon summary on WhatsApp" }
    "streak-check"  = { schedule = "5 0 * * *", description = "Tell people whose photo streak broke" }
    housekeeping    = { schedule = "15 * * * *", description = "Expire scratch cards, release payout locks" }
    "kyc-reminder"  = { schedule = "0 10 * * 1", description = "Monday 10 am: add UPI to get your cash" }
  }
  payout_jobs = var.payout_mode == "razorpayx" ? {
    payouts = { schedule = var.payouts_schedule, description = "Send approved withdrawals to RazorpayX; check ones in flight" }
  } : {}
}

resource "google_cloud_scheduler_job" "jobs" {
  for_each         = merge(local.jobs, local.payout_jobs)
  name             = "gomax-${each.key}"
  description      = each.value.description
  schedule         = each.value.schedule
  time_zone        = "Asia/Kolkata"
  region           = var.region
  attempt_deadline = "120s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "${local.public_url}/internal/jobs/${each.key}"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.jobs_audience
    }
  }

  depends_on = [google_project_service.apis]
}

output "api_url" {
  description = "Set this as EXPO_PUBLIC_API_URL in the app"
  value       = local.public_url
}

output "api_ip" {
  description = "Point the api_domain A record here (only when api_domain is set)"
  value       = local.behind_lb ? google_compute_global_address.api[0].address : null
}

output "image" {
  description = "Image path Cloud Build pushes to"
  value       = local.image
}

output "files_bucket" {
  value = google_storage_bucket.files.name
}

output "redis_host" {
  value = google_redis_instance.cache.host
}

output "whatsapp_webhook" {
  description = "Paste into Meta → WhatsApp → Configuration → Webhook (verify token is secret gomax-wa-verify-token)"
  value       = "${local.public_url}/webhooks/whatsapp"
}

output "egress_ip" {
  description = "Fixed outbound IP to whitelist in RazorpayX (empty when static egress is off)"
  value       = local.static_egress ? google_compute_address.egress[0].address : ""
}

output "razorpay_webhook_url" {
  description = "Paste into RazorpayX → Settings → Webhooks (events: payout.*)"
  value       = "${local.public_url}/webhooks/razorpay"
}

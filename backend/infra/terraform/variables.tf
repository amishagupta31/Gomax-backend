variable "project_id" {
  description = "GCP project for this environment, e.g. gomax-prod"
  type        = string
}

variable "env" {
  description = "staging | prod"
  type        = string
}

variable "region" {
  description = "Mumbai — close to users in Punjab"
  type        = string
  default     = "asia-south1"
}

variable "db_pool_per_instance" {
  description = "Postgres connections per Cloud Run instance. Keep max_instances × this under the Supabase pooler's client limit for your plan."
  type        = number
  default     = 5
}

variable "network" {
  description = "VPC for Memorystore + Cloud Run Direct VPC egress (the project's default VPC works)"
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnet in var.region used by Cloud Run egress"
  type        = string
  default     = "default"
}

variable "redis_tier" {
  description = "BASIC for staging; STANDARD_HA (replica + failover) for prod"
  type        = string
  default     = "BASIC"
}

variable "api_domain" {
  description = "e.g. api.gomax.app. When set: HTTPS load balancer + Cloud Armor in front, and the *.run.app URL is closed. Empty = use the run.app URL."
  type        = string
  default     = ""
}

variable "armor_requests_per_minute" {
  description = "Cloud Armor per-IP cap at the edge"
  type        = number
  default     = 600
}

variable "alert_email" {
  description = "Where alerts go (uptime, 5xx, latency). Empty = alerts show in the console only."
  type        = string
  default     = ""
}

variable "min_instances" {
  description = "Always-on instances: 2 in prod (no cold starts, survives one instance failing), 0 for staging."
  type        = number
  default     = 0
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "cors_origins" {
  description = "Comma-separated origins for the Admin website, e.g. https://admin.gomax.in"
  type        = string
  default     = "https://admin.gomax.in"
}

variable "app_link_base" {
  description = "Base URL for links sent on WhatsApp (password reset deep link)"
  type        = string
  default     = "https://gomax.app"
}

variable "whatsapp_driver" {
  description = "log until the WhatsApp Business number + templates are approved, then meta"
  type        = string
  default     = "log"
}

variable "wa_phone_number_id" {
  description = "Meta WhatsApp Cloud API phone number id (not secret)"
  type        = string
  default     = ""
}

variable "firebase_project_id" {
  description = "Firebase project for the sign-up SMS OTP (Firebase Phone Auth). Empty = sign-up without OTP."
  type        = string
  default     = ""
}

variable "payout_mode" {
  description = "How approved withdrawals are paid: manual (staff pay in the UPI app) or razorpayx (automatic RazorpayX payouts)"
  type        = string
  default     = "manual"
  validation {
    condition     = contains(["manual", "razorpayx"], var.payout_mode)
    error_message = "payout_mode must be manual or razorpayx."
  }
}

variable "kyc_driver" {
  description = "UPI name check: mock or razorpay (RazorpayX fund account validation)"
  type        = string
  default     = "mock"
  validation {
    condition     = contains(["mock", "razorpay"], var.kyc_driver)
    error_message = "kyc_driver must be mock or razorpay."
  }
}

variable "razorpayx_account_number" {
  description = "RazorpayX business account number payouts are made from (not secret)"
  type        = string
  default     = ""
}

variable "payouts_schedule" {
  description = "Cron (IST) for sending approved RazorpayX payouts and checking ones in flight"
  type        = string
  default     = "*/10 * * * *"
}

variable "static_egress_ip" {
  description = "Send all outbound traffic through Cloud NAT with one fixed IP (RazorpayX IP whitelist). null = on whenever Razorpay is used."
  type        = bool
  default     = null
  nullable    = true
}

variable "jobs_audience" {
  description = "OIDC audience Cloud Scheduler puts in its token; the API checks it"
  type        = string
  default     = "gomax-api-jobs"
}

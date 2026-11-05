# GoMax API on GCP, database on Supabase. One Terraform state per environment
# (staging, prod), each in its own GCP project and its own Supabase project.
# See ../../README.md → "Deploy".

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State lives in a GCS bucket you create once (README step 2):
  #   terraform init -backend-config="bucket=<project>-tfstate"
  backend "gcs" {
    prefix = "gomax-api"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}

locals {
  name = "gomax-api"
  apis = [
    "run.googleapis.com",
    "redis.googleapis.com",
    "compute.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "storage.googleapis.com",
  ]
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.api.repository_id}/${local.name}"
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "api" {
  repository_id = "gomax"
  format        = "DOCKER"
  location      = var.region
  description   = "GoMax container images"
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 20 }
  }
  depends_on = [google_project_service.apis]
}

# ── Service accounts (least privilege) ─────────────────────────────────────
resource "google_service_account" "api" {
  account_id   = "gomax-api"
  display_name = "GoMax API (Cloud Run runtime)"
}

resource "google_service_account" "scheduler" {
  account_id   = "gomax-scheduler"
  display_name = "GoMax Cloud Scheduler (calls /internal/jobs)"
}

# Signed URLs on Cloud Run use IAM signBlob on the runtime account itself.
resource "google_service_account_iam_member" "api_sign_self" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# Cloud Build deploys the service/job and runs as the API account.
locals {
  cloudbuild_sa = "serviceAccount:${data.google_project.this.number}@cloudbuild.gserviceaccount.com"
}

resource "google_project_iam_member" "build_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = local.cloudbuild_sa
}

resource "google_service_account_iam_member" "build_act_as_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.cloudbuild_sa
}

resource "google_artifact_registry_repository_iam_member" "build_push" {
  repository = google_artifact_registry_repository.api.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = local.cloudbuild_sa
}

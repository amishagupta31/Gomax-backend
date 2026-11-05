# One private bucket for streak photos, UPI QR images, payment proofs,
# delivery photos and TDS PDFs. Nothing is public; access is by signed URL.
resource "google_storage_bucket" "files" {
  name                        = "${var.project_id}-gomax-files"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true # payment proofs and TDS PDFs keep old versions
  }

  # Streak photos are only needed for review and disputes.
  lifecycle_rule {
    condition {
      age            = 400
      matches_prefix = ["streak/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 3
    }
    action {
      type = "Delete"
    }
  }

  # The Admin website uploads straight to the bucket with signed PUT URLs.
  cors {
    origin          = split(",", var.cors_origins)
    method          = ["PUT", "GET"]
    response_header = ["Content-Type", "x-goog-content-length-range"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "api_objects" {
  bucket = google_storage_bucket.files.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

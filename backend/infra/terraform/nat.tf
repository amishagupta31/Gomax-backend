# One fixed outbound IP: RazorpayX only accepts payout API calls from
# whitelisted IPs. Cloud Run sends ALL traffic into the VPC (run.tf) and
# Cloud NAT takes it out through this address. Give it to Razorpay:
#   terraform output egress_ip → RazorpayX → Settings → Developer Controls → IP whitelist
resource "google_compute_address" "egress" {
  count        = local.static_egress ? 1 : 0
  name         = "gomax-${var.env}-egress"
  region       = var.region
  address_type = "EXTERNAL"
  depends_on   = [google_project_service.apis]
}

resource "google_compute_router" "egress" {
  count   = local.static_egress ? 1 : 0
  name    = "gomax-${var.env}-router"
  region  = var.region
  network = data.google_compute_network.vpc.id
}

resource "google_compute_router_nat" "egress" {
  count                              = local.static_egress ? 1 : 0
  name                               = "gomax-${var.env}-nat"
  region                             = var.region
  router                             = google_compute_router.egress[0].name
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.egress[0].self_link]
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = var.subnetwork
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  # Many Cloud Run instances × outbound connections (Supabase, Razorpay, Meta).
  enable_dynamic_port_allocation      = true
  enable_endpoint_independent_mapping = false
  min_ports_per_vm                    = 64
  max_ports_per_vm                    = 4096

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

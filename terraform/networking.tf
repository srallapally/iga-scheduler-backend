resource "google_project_service" "servicenetworking" {
  project            = var.project_id
  service            = "servicenetworking.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "vpcaccess" {
  project            = var.project_id
  service            = "vpcaccess.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_network" "main" {
  project                 = var.project_id
  name                    = var.vpc_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "connector" {
  project       = var.project_id
  name          = "${var.vpc_name}-connector-subnet"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = var.vpc_connector_cidr
}

resource "google_compute_global_address" "private_service_range" {
  project       = var.project_id
  name          = "${var.vpc_name}-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_range.name]
  depends_on              = [google_project_service.servicenetworking]
}

resource "google_vpc_access_connector" "scheduler" {
  project  = var.project_id
  name     = var.vpc_connector_name
  region   = var.region
  subnet {
    name = google_compute_subnetwork.connector.name
  }
  min_instances = 2
  max_instances = 3
  depends_on    = [google_project_service.vpcaccess]
}

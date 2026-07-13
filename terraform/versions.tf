terraform {
  required_version = ">= 1.5.0"

  backend "gcs" {
    # terraform init -backend-config="bucket=<your-tfstate-bucket>" -backend-config="prefix=iga-scheduler"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

import { Storage } from "@google-cloud/storage";

export function createStorageClient() {
  return new Storage({
    projectId: process.env.GCP_PROJECT_ID
  });
}

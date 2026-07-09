import { Storage } from "@google-cloud/storage";
import { getConfig } from "../config/index.js";

export function createStorageClient() {
  return new Storage({
    projectId: getConfig().gcpProjectId
  });
}

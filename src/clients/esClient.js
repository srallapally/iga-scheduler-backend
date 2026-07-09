import { Client } from "@elastic/elasticsearch";
import { getConfig } from "../config/index.js";

export function createEsClient() {
  const config = getConfig();

  return new Client({
    node: config.esEndpoint,
    auth: {
      apiKey: config.esApiKey
    }
  });
}

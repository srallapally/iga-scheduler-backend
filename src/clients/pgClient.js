import pg from "pg";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const ENGINES = new Set(["cloud-sql", "direct"]);

export async function createPgPool({ env = process.env, secretManagerClient, connector } = {}) {
  const engine = env.DB_ENGINE || "direct";
  if (!ENGINES.has(engine)) throw new Error(`unsupported DB_ENGINE: ${engine}`);

  if (engine === "direct") {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required when DB_ENGINE=direct");
    return new pg.Pool({ connectionString: env.DATABASE_URL });
  }

  // cloud-sql — validate all required vars before fetching the password or importing the connector
  const instanceConnectionName = required(env, "DB_INSTANCE_CONNECTION_NAME");
  const user = required(env, "DB_USER");
  const database = required(env, "DB_NAME");
  const password = await resolveCloudSqlPassword({ env, client: secretManagerClient });
  const activeConnector = connector || new (await import("@google-cloud/cloud-sql-connector")).Connector();
  const clientOpts = await activeConnector.getOptions({
    instanceConnectionName,
    ipType: env.DB_IP_TYPE || "PRIVATE"
  });
  return new pg.Pool({ ...clientOpts, user, database, password });
}

// Fetches the Cloud SQL password from Secret Manager rather than reading it
// from the process environment (SEC-4): a same-uid job subprocess can read
// the server's /proc/<pid>/environ, so the password must never be an env var.
// Returns undefined (no password) when DB_PASSWORD_SECRET is unset, preserving
// the IAM-database-auth deployment mode.
export async function resolveCloudSqlPassword({ env, client }) {
  if (!env.DB_PASSWORD_SECRET) return undefined;

  const secretVersionName = toSecretVersionName(env.DB_PASSWORD_SECRET, env);
  const activeClient = client || new SecretManagerServiceClient();
  const [version] = await activeClient.accessSecretVersion({ name: secretVersionName });
  const data = version.payload?.data;
  return data ? Buffer.from(data).toString("utf8") : undefined;
}

function toSecretVersionName(secretRef, env) {
  if (secretRef.startsWith("projects/")) {
    return secretRef.includes("/versions/") ? secretRef : `${secretRef}/versions/latest`;
  }
  if (!env.GCP_PROJECT_ID) throw new Error("GCP_PROJECT_ID is required to resolve a bare DB_PASSWORD_SECRET id");
  return `projects/${env.GCP_PROJECT_ID}/secrets/${secretRef}/versions/latest`;
}

function required(env, name) {
  if (!env[name]) throw new Error(`${name} is required for DB_ENGINE=${env.DB_ENGINE}`);
  return env[name];
}

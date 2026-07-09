import pg from "pg";

const ENGINES = new Set(["cloud-sql", "direct"]);

export async function createPgPool({ env = process.env } = {}) {
  const engine = env.DB_ENGINE || "direct";
  if (!ENGINES.has(engine)) throw new Error(`unsupported DB_ENGINE: ${engine}`);

  if (engine === "direct") {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required when DB_ENGINE=direct");
    return new pg.Pool({ connectionString: env.DATABASE_URL });
  }

  // cloud-sql — validate all required vars before importing the connector
  const instanceConnectionName = required(env, "DB_INSTANCE_CONNECTION_NAME");
  const user = required(env, "DB_USER");
  const database = required(env, "DB_NAME");
  const { Connector } = await import("@google-cloud/cloud-sql-connector");
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName,
    ipType: env.DB_IP_TYPE || "PRIVATE"
  });
  return new pg.Pool({ ...clientOpts, user, database, password: env.DB_PASSWORD });
}

function required(env, name) {
  if (!env[name]) throw new Error(`${name} is required for DB_ENGINE=${env.DB_ENGINE}`);
  return env[name];
}

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { createPgPool, resolveCloudSqlPassword } from "../src/clients/pgClient.js";
import { validateProductionStartupConfig } from "../src/config/productionValidation.js";
import { pgAvailable, TEST_DATABASE_URL, createTestPool, applyMigrations, revertMigrations } from "./helpers/pg.js";

function createSecretManagerClient(value = "fetched-secret") {
  return {
    accessSecretVersion: vi.fn(async () => [{
      payload: { data: Buffer.from(value, "utf8") }
    }])
  };
}

function fakeConnector(clientOpts = {}) {
  return { getOptions: vi.fn(async () => clientOpts) };
}

// ---------------------------------------------------------------------------
// pgClient — engine validation (no PG required)
// ---------------------------------------------------------------------------

describe("createPgPool — engine validation", () => {
  it("throws on unknown engine", async () => {
    await expect(createPgPool({ env: { DB_ENGINE: "bogus" } })).rejects.toThrow("unsupported DB_ENGINE: bogus");
  });

  it("throws when DB_ENGINE=direct and DATABASE_URL is missing", async () => {
    await expect(createPgPool({ env: { DB_ENGINE: "direct" } })).rejects.toThrow("DATABASE_URL is required when DB_ENGINE=direct");
  });

  it("throws when DB_ENGINE=cloud-sql and DB_INSTANCE_CONNECTION_NAME is missing", async () => {
    // Connector import will succeed but getOptions requires the connection name
    // We verify the required() guard fires before any connector call
    await expect(
      createPgPool({ env: { DB_ENGINE: "cloud-sql", DB_USER: "u", DB_NAME: "d" } })
    ).rejects.toThrow("DB_INSTANCE_CONNECTION_NAME is required for DB_ENGINE=cloud-sql");
  });

  it("throws when DB_ENGINE=cloud-sql and DB_USER is missing", async () => {
    await expect(
      createPgPool({ env: { DB_ENGINE: "cloud-sql", DB_INSTANCE_CONNECTION_NAME: "proj:region:inst", DB_NAME: "d" } })
    ).rejects.toThrow("DB_USER is required for DB_ENGINE=cloud-sql");
  });

  it("throws when DB_ENGINE=cloud-sql and DB_NAME is missing", async () => {
    await expect(
      createPgPool({ env: { DB_ENGINE: "cloud-sql", DB_INSTANCE_CONNECTION_NAME: "proj:region:inst", DB_USER: "u" } })
    ).rejects.toThrow("DB_NAME is required for DB_ENGINE=cloud-sql");
  });
});

// ---------------------------------------------------------------------------
// resolveCloudSqlPassword — Secret Manager fetch, not process.env (SEC-4)
// ---------------------------------------------------------------------------

describe("resolveCloudSqlPassword", () => {
  it("returns undefined when DB_PASSWORD_SECRET is unset (IAM auth mode)", async () => {
    const client = createSecretManagerClient();
    const result = await resolveCloudSqlPassword({ env: { DB_PASSWORD: "should-be-ignored" }, client });
    expect(result).toBeUndefined();
    expect(client.accessSecretVersion).not.toHaveBeenCalled();
  });

  it("fetches a bare secret id using GCP_PROJECT_ID", async () => {
    const client = createSecretManagerClient("db-secret-value");
    const result = await resolveCloudSqlPassword({
      env: { GCP_PROJECT_ID: "proj-1", DB_PASSWORD_SECRET: "iga-scheduler-db-password" },
      client
    });
    expect(result).toBe("db-secret-value");
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/proj-1/secrets/iga-scheduler-db-password/versions/latest"
    });
  });

  it("throws when a bare secret id is used without GCP_PROJECT_ID", async () => {
    const client = createSecretManagerClient();
    await expect(resolveCloudSqlPassword({ env: { DB_PASSWORD_SECRET: "iga-scheduler-db-password" }, client }))
      .rejects.toThrow("GCP_PROJECT_ID is required to resolve a bare DB_PASSWORD_SECRET id");
  });

  it("uses a fully qualified secret ref unchanged", async () => {
    const client = createSecretManagerClient("db-secret-value");
    const result = await resolveCloudSqlPassword({
      env: { DB_PASSWORD_SECRET: "projects/proj-1/secrets/db-pw/versions/5" },
      client
    });
    expect(result).toBe("db-secret-value");
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/proj-1/secrets/db-pw/versions/5"
    });
  });

  it("adds /versions/latest to a fully qualified ref without a version", async () => {
    const client = createSecretManagerClient("db-secret-value");
    await resolveCloudSqlPassword({ env: { DB_PASSWORD_SECRET: "projects/proj-1/secrets/db-pw" }, client });
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/proj-1/secrets/db-pw/versions/latest"
    });
  });
});

// ---------------------------------------------------------------------------
// createPgPool — cloud-sql password comes from Secret Manager, not env.DB_PASSWORD
// ---------------------------------------------------------------------------

describe("createPgPool — cloud-sql password sourcing (SEC-4)", () => {
  it("uses the fetched Secret Manager value as the pool password, ignoring env.DB_PASSWORD", async () => {
    const secretManagerClient = createSecretManagerClient("fetched-db-password");
    const connector = fakeConnector({ host: "127.0.0.1", port: 5432 });

    const pool = await createPgPool({
      env: {
        DB_ENGINE: "cloud-sql",
        DB_INSTANCE_CONNECTION_NAME: "proj:region:inst",
        DB_USER: "app",
        DB_NAME: "scheduler",
        DB_PASSWORD_SECRET: "iga-scheduler-db-password",
        GCP_PROJECT_ID: "proj-1",
        DB_PASSWORD: "leaked-if-used"
      },
      secretManagerClient,
      connector
    });

    try {
      expect(pool.options.password).toBe("fetched-db-password");
      expect(secretManagerClient.accessSecretVersion).toHaveBeenCalledWith({
        name: "projects/proj-1/secrets/iga-scheduler-db-password/versions/latest"
      });
    } finally {
      await pool.end();
    }
  });

  it("creates a pool with no password when DB_PASSWORD_SECRET is unset (IAM auth mode)", async () => {
    const secretManagerClient = createSecretManagerClient();
    const connector = fakeConnector({ host: "127.0.0.1", port: 5432 });

    const pool = await createPgPool({
      env: {
        DB_ENGINE: "cloud-sql",
        DB_INSTANCE_CONNECTION_NAME: "proj:region:inst",
        DB_USER: "app",
        DB_NAME: "scheduler"
      },
      secretManagerClient,
      connector
    });

    try {
      expect(pool.options.password).toBeUndefined();
      expect(secretManagerClient.accessSecretVersion).not.toHaveBeenCalled();
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// productionValidation — DB engine rules
// ---------------------------------------------------------------------------

function baseProductionEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    GCP_PROJECT_ID: "proj",
    JOB_ZIP_BUCKET: "bucket",
    ES_ENDPOINT: "https://es.test",
    ES_API_KEY: "key",
    WORKER_OIDC_AUDIENCE: "https://worker.test",
    WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL: "worker@proj.iam.gserviceaccount.com",
    SCHEDULER_OIDC_AUDIENCE: "https://sched.test",
    SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL: "sched@proj.iam.gserviceaccount.com",
    WORKER_EXECUTION_MODE: "isolated",
    RUNTIME_WORKER_URL: "https://worker.test",
    RUNTIME_SERVICE_ACCOUNT_EMAIL: "runtime@proj.iam.gserviceaccount.com",
    RUNTIME_BROKER_URL: "https://worker.test/internal/runtime-broker",
    IGA_TOKEN_ENDPOINT: "https://iga.test/token",
    IGA_CLIENT_ID: "id",
    IGA_CLIENT_SECRET: "secret",
    IGA_BASE_URL: "https://iga.test",
    PUBLIC_API_ISSUER: "https://auth.pingone.example.test/env1/as",
    PUBLIC_API_AUDIENCE: "https://scheduler.example.test",
    ...overrides
  };
}

describe("validateProductionStartupConfig — DB engine", () => {
  it("rejects missing DB_ENGINE in production", () => {
    expect(() => validateProductionStartupConfig({ env: baseProductionEnv() })).toThrow("Missing required production environment variables: DB_ENGINE");
  });

  it("accepts cloud-sql with full connection vars", () => {
    const env = baseProductionEnv({
      DB_ENGINE: "cloud-sql",
      DB_INSTANCE_CONNECTION_NAME: "proj:us-central1:inst",
      DB_USER: "app",
      DB_NAME: "scheduler"
    });
    expect(validateProductionStartupConfig({ env })).toEqual({ status: "ok" });
  });

  it("rejects cloud-sql with missing DB_INSTANCE_CONNECTION_NAME", () => {
    const env = baseProductionEnv({ DB_ENGINE: "cloud-sql", DB_USER: "app", DB_NAME: "scheduler" });
    expect(() => validateProductionStartupConfig({ env })).toThrow("DB_INSTANCE_CONNECTION_NAME");
  });

  it("rejects cloud-sql with missing DB_USER", () => {
    const env = baseProductionEnv({ DB_ENGINE: "cloud-sql", DB_INSTANCE_CONNECTION_NAME: "proj:us-central1:inst", DB_NAME: "scheduler" });
    expect(() => validateProductionStartupConfig({ env })).toThrow("DB_USER");
  });

  it("rejects cloud-sql with missing DB_NAME", () => {
    const env = baseProductionEnv({ DB_ENGINE: "cloud-sql", DB_INSTANCE_CONNECTION_NAME: "proj:us-central1:inst", DB_USER: "app" });
    expect(() => validateProductionStartupConfig({ env })).toThrow("DB_NAME");
  });

  it("rejects direct in production without DB_ALLOW_DIRECT", () => {
    const env = baseProductionEnv({ DB_ENGINE: "direct", DATABASE_URL: "postgresql://localhost/test" });
    expect(() => validateProductionStartupConfig({ env })).toThrow("DB_ALLOW_DIRECT=true");
  });

  it("accepts direct in production when DB_ALLOW_DIRECT=true (AlloyDB auth-proxy pattern)", () => {
    const env = baseProductionEnv({
      DB_ENGINE: "direct",
      DATABASE_URL: "postgresql://app@127.0.0.1:5432/scheduler",
      DB_ALLOW_DIRECT: "true"
    });
    expect(validateProductionStartupConfig({ env })).toEqual({ status: "ok" });
  });

  it("rejects direct in production without DATABASE_URL even when DB_ALLOW_DIRECT is set", () => {
    const env = baseProductionEnv({ DB_ENGINE: "direct", DB_ALLOW_DIRECT: "true" });
    expect(() => validateProductionStartupConfig({ env })).toThrow("DATABASE_URL");
  });

  it("rejects unknown DB_ENGINE", () => {
    const env = baseProductionEnv({ DB_ENGINE: "bogus" });
    expect(() => validateProductionStartupConfig({ env })).toThrow("unsupported DB_ENGINE: bogus");
  });
});

// ---------------------------------------------------------------------------
// Migration round-trip (requires TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

describe.skipIf(!pgAvailable())("migration round-trip", () => {
  let pool;

  beforeAll(async () => {
    pool = await createTestPool();
    // Ensure clean slate — revert any existing migrations
    try {
      await revertMigrations(pool);
    } catch {
      // Ignore if no migrations table exists yet
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("applies migrations: both tables and indexes exist", async () => {
    await applyMigrations(pool);

    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('job_instances', 'job_runs')
      ORDER BY tablename
    `);
    expect(rows.map((r) => r.tablename)).toEqual(["job_instances", "job_runs"]);

    const { rows: idxRows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_job_instances_due', 'idx_job_runs_queued', 'idx_job_runs_instance')
      ORDER BY indexname
    `);
    expect(idxRows.map((r) => r.indexname)).toEqual([
      "idx_job_instances_due",
      "idx_job_runs_instance",
      "idx_job_runs_queued"
    ]);
  });

  it("reverts migrations: tables are gone", async () => {
    await revertMigrations(pool);

    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('job_instances', 'job_runs')
    `);
    expect(rows).toHaveLength(0);
  });

  it("direct pool executes a query", async () => {
    const directPool = await createPgPool({ env: { DB_ENGINE: "direct", DATABASE_URL: TEST_DATABASE_URL } });
    try {
      const { rows } = await directPool.query("SELECT 1 AS val");
      expect(rows[0].val).toBe(1);
    } finally {
      await directPool.end();
    }
  });
});

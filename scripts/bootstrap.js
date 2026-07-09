#!/usr/bin/env node
// Idempotent bootstrap script. Safe to run multiple times.
// Runs both ES index creation and Postgres migrations in the correct order.
//
// Usage:
//   node scripts/bootstrap.js              # auto-detects mode from APP_MODE / env
//   node scripts/bootstrap.js --es-only    # only create ES indices
//   node scripts/bootstrap.js --pg-only    # only run Postgres migrations
//   node scripts/bootstrap.js --dry-run    # print what would happen, no writes
//
// In production mode, ES_ENDPOINT / ES_API_KEY / GCP_PROJECT_ID can be supplied
// as CLI flags if they are not already in the environment:
//   --es-endpoint <url>   seeds ES_ENDPOINT
//   --es-api-key  <key>   seeds ES_API_KEY
//   --gcp-project <id>    seeds GCP_PROJECT_ID

import { createEsClient } from "../src/clients/esClient.js";
import { createPgPool } from "../src/clients/pgClient.js";
import { getSchedulerIndexDefinitions } from "../src/elasticsearch/schedulerIndexMappings.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ES_ONLY = args.includes("--es-only");
const PG_ONLY = args.includes("--pg-only");

const mode = process.env.APP_MODE || "production";

// Seed ES_API_KEY / ES_ENDPOINT / GCP_PROJECT_ID from CLI flags when not in env
if (mode !== "local") {
  const flag = (name) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith(`--${name}=`)) return args[i].slice(`--${name}=`.length);
      if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
    }
    return null;
  };
  for (const [envVar, cliFlag] of [
    ["ES_API_KEY",     "es-api-key"],
    ["ES_ENDPOINT",    "es-endpoint"],
    ["GCP_PROJECT_ID", "gcp-project"],
  ]) {
    if (!process.env[envVar]) {
      const val = flag(cliFlag);
      if (val) process.env[envVar] = val;
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

function warn(msg) {
  console.warn(`[warn] ${msg}`);
}

// ─── Elasticsearch bootstrap ─────────────────────────────────────────────────

async function bootstrapEs() {
  if (mode === "local") {
    log("es", "skipped — APP_MODE=local uses SQLite, no ES required");
    return;
  }

  const missing = ["ES_ENDPOINT", "ES_API_KEY"].filter((v) => !process.env[v]);
  if (missing.length) {
    warn(`skipping ES bootstrap — missing env vars: ${missing.join(", ")}`);
    return;
  }

  log("es", "connecting...");
  const esClient = createEsClient();
  const indices = getSchedulerIndexDefinitions();

  for (const { name, body } of indices) {
    const exists = await esClient.indices.exists({ index: name });
    if (exists) {
      log("es", `${name} — already exists, skipped`);
      continue;
    }
    if (DRY_RUN) {
      log("es", `${name} — would create (dry-run)`);
      continue;
    }
    await esClient.indices.create({ index: name, ...body });
    log("es", `${name} — created`);
  }
}

// ─── Postgres migrations ──────────────────────────────────────────────────────

async function bootstrapPg() {
  if (mode === "local") {
    log("pg", "skipped — APP_MODE=local uses SQLite, no Postgres required");
    return;
  }

  const dbEngine = process.env.DB_ENGINE || "direct";
  const hasPgConfig = dbEngine === "cloud-sql"
    ? Boolean(process.env.DB_INSTANCE_CONNECTION_NAME && process.env.DB_USER && process.env.DB_NAME)
    : Boolean(process.env.DATABASE_URL);

  if (!hasPgConfig) {
    warn("skipping Postgres migrations — DB connection vars not set");
    return;
  }

  if (DRY_RUN) {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    log("pg", `would apply migrations (dry-run): ${files.join(", ")}`);
    return;
  }

  log("pg", "running migrations via node-pg-migrate...");
  const { runner } = await import("node-pg-migrate");
  const pool = await createPgPool();

  try {
    await runner({
      dbClient: pool,
      migrationsTable: "pgmigrations",
      dir: MIGRATIONS_DIR,
      direction: "up",
      log: (msg) => log("pg", msg)
    });
    log("pg", "migrations complete");
  } finally {
    await pool.end();
  }
}

// ─── SQLite bootstrap (local mode) ───────────────────────────────────────────

async function bootstrapLocal() {
  if (mode !== "local") return;

  const dataDir = process.env.LOCAL_DATA_DIR || ".local-data";

  if (DRY_RUN) {
    log("local", `would initialise SQLite DB at ${dataDir}/scheduler.db (dry-run)`);
    return;
  }

  const { createLocalDb } = await import("../src/backends/local/db.js");
  const db = createLocalDb(dataDir);
  db.close();
  log("local", `SQLite DB ready at ${dataDir}/scheduler.db`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`bootstrap starting — mode=${mode}${DRY_RUN ? " (dry-run)" : ""}`);

  const runEs = !PG_ONLY;
  const runPg = !ES_ONLY;

  if (mode === "local") {
    await bootstrapLocal();
  } else {
    if (runEs) await bootstrapEs();
    if (runPg) await bootstrapPg();
  }

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error("bootstrap failed:", err.message);
  process.exit(1);
});

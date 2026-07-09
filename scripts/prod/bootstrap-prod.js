#!/usr/bin/env node
// Production bootstrap orchestrator.
//
// Phases:
//   1. Preflight  — env + connectivity checks (no writes)
//   2. Seed       — Postgres migrations, ES index creation
//   3. Manifest   — write bootstrap-manifest.json
//   4. Validate   — post-bootstrap smoke tests (read-back verification)
//
// Usage:
//   node scripts/prod/bootstrap-prod.js
//   node scripts/prod/bootstrap-prod.js --skip-preflight   # skip phase 1 (not recommended)
//   node scripts/prod/bootstrap-prod.js --dry-run          # phases 1+4 only, no writes
//
// Idempotent: existing ES indices and applied PG migrations are left unchanged.
// On success writes bootstrap-manifest.json which teardown.js uses for cleanup.

import { execSync } from "child_process";
import path from "path";
import {
  ok, fail, warn, header, dim,
  REPO_ROOT, MIGRATIONS_DIR, MANIFEST_PATH,
  writeManifest, readManifest, stopwatch
} from "./lib.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_PREFLIGHT = args.includes("--skip-preflight");

let stepFailures = 0;
function pass(s, m) { ok(s, m); }
function fault(s, m) { fail(s, m); stepFailures++; }

// ─── Phase 1: Preflight ───────────────────────────────────────────────────────

header("═══  Phase 1: Preflight  ═══");

if (SKIP_PREFLIGHT) {
  warn("preflight", "--skip-preflight set — skipping connectivity checks (not recommended)");
} else {
  try {
    execSync(`node ${path.join(REPO_ROOT, "scripts/prod/preflight.js")}`, { stdio: "inherit" });
    pass("preflight", "all checks passed");
  } catch {
    fault("preflight", "preflight failed — resolve issues above before seeding");
    console.error("\nAborting bootstrap. Fix preflight failures and re-run.");
    process.exit(1);
  }
}

if (DRY_RUN) {
  console.log("\n[dry-run] phases 2-3 skipped. Proceeding to post-validation read-back only.\n");
}

// ─── Phase 2: Seed ────────────────────────────────────────────────────────────

header("═══  Phase 2: Seed  ═══");

const seeded = {
  esIndicesCreated: [],
  esIndicesExisted: [],
  pgMigrationsApplied: [],
  pgMigrationsAlreadyApplied: [],
};

// 2a. Elasticsearch indices
{
  const hasEsCreds = Boolean(process.env.ES_ENDPOINT && process.env.ES_API_KEY);
  const { getSchedulerIndexDefinitions } = await import("../../src/elasticsearch/schedulerIndexMappings.js");
  const indices = getSchedulerIndexDefinitions();

  if (DRY_RUN) {
    for (const { name } of indices) dim(`  [dry-run] would create index ${name} (if missing)`);
  } else if (!hasEsCreds) {
    fault("es", "ES_ENDPOINT or ES_API_KEY not set — cannot seed ES indices");
  } else {
    const elapsed = stopwatch();
    const { createEsClient } = await import("../../src/clients/esClient.js");
    const esClient = createEsClient();

    for (const { name, body } of indices) {
      const exists = await esClient.indices.exists({ index: name });
      if (exists) {
        seeded.esIndicesExisted.push(name);
        pass("es", `${name} — already exists, skipped`);
      } else {
        await esClient.indices.create({ index: name, ...body });
        seeded.esIndicesCreated.push(name);
        pass("es", `${name} — created`);
      }
    }
    dim(`  ES seed complete (${elapsed()})`);
  }
}

// 2b. Postgres migrations
{
  const elapsed = stopwatch();
  const dbEngine = process.env.DB_ENGINE || "direct";
  const hasPgConfig = dbEngine === "cloud-sql"
    ? Boolean(process.env.DB_INSTANCE_CONNECTION_NAME && process.env.DB_USER && process.env.DB_NAME)
    : Boolean(process.env.DATABASE_URL);

  if (!hasPgConfig && DRY_RUN) {
    warn("pg", "DB connection vars not set — would skip migrations");
  } else if (!hasPgConfig) {
    fault("pg", "DB connection vars missing — cannot run migrations");
  } else if (DRY_RUN) {
    const { default: fs } = await import("fs");
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    dim(`  [dry-run] would apply migrations: ${files.join(", ")}`);
  } else {
    const { createPgPool } = await import("../../src/clients/pgClient.js");
    const { runner } = await import("node-pg-migrate");
    const pool = await createPgPool();

    // Capture which migrations were already applied before running
    let appliedBefore = new Set();
    try {
      const { rows } = await pool.query("SELECT name FROM pgmigrations");
      appliedBefore = new Set(rows.map((r) => r.name));
    } catch {
      // pgmigrations table doesn't exist yet — all migrations are new
    }

    try {
      await runner({
        dbClient: pool,
        migrationsTable: "pgmigrations",
        dir: MIGRATIONS_DIR,
        direction: "up",
        log: (msg) => {
          if (msg.trim()) dim(`  pg: ${msg.trim()}`);
        }
      });

      // Determine what was newly applied
      const { rows: appliedAfter } = await pool.query("SELECT name FROM pgmigrations");
      for (const { name } of appliedAfter) {
        if (appliedBefore.has(name)) {
          seeded.pgMigrationsAlreadyApplied.push(name);
        } else {
          seeded.pgMigrationsApplied.push(name);
          pass("pg", `${name} — applied`);
        }
      }
      if (seeded.pgMigrationsAlreadyApplied.length) {
        pass("pg", `${seeded.pgMigrationsAlreadyApplied.length} migration(s) already applied, skipped`);
      }
    } finally {
      await pool.end().catch(() => {});
    }
    dim(`  PG seed complete (${elapsed()})`);
  }
}

if (stepFailures > 0) {
  fail("seed", `${stepFailures} seeding step(s) failed — see above`);
  process.exit(1);
}

// ─── Phase 3: Manifest ────────────────────────────────────────────────────────

header("═══  Phase 3: Manifest  ═══");

if (!DRY_RUN) {
  const existing = readManifest();
  const now = new Date().toISOString();

  const manifest = {
    schemaVersion: 1,
    bootstrappedAt: now,
    previousRun: existing?.bootstrappedAt ?? null,
    environment: {
      gcpProjectId: process.env.GCP_PROJECT_ID,
      jobZipBucket: process.env.JOB_ZIP_BUCKET,
      dbEngine: process.env.DB_ENGINE,
      dbName: process.env.DB_NAME ?? null,
      dbInstanceConnectionName: process.env.DB_INSTANCE_CONNECTION_NAME ?? null,
      esEndpoint: process.env.ES_ENDPOINT,
    },
    elasticsearch: {
      created: seeded.esIndicesCreated,
      alreadyExisted: seeded.esIndicesExisted,
    },
    postgres: {
      applied: seeded.pgMigrationsApplied,
      alreadyApplied: seeded.pgMigrationsAlreadyApplied,
      migrationsTable: "pgmigrations",
    },
  };

  writeManifest(manifest);
  pass("manifest", `written to bootstrap-manifest.json`);
  dim(`  ES created: [${manifest.elasticsearch.created.join(", ") || "none"}]`);
  dim(`  PG applied: [${manifest.postgres.applied.join(", ") || "none"}]`);
}

// ─── Phase 4: Post-bootstrap validation ───────────────────────────────────────

header("═══  Phase 4: Post-bootstrap validation  ═══");

let validationFailures = 0;
function vpass(s, m) { ok(s, m); }
function vfail(s, m) { fail(s, m); validationFailures++; }

// 4a. Verify ES indices exist and have correct mappings
{
  if (!process.env.ES_ENDPOINT || !process.env.ES_API_KEY) {
    warn("es", "skipped — ES_ENDPOINT or ES_API_KEY not set");
  } else {
  const { createEsClient } = await import("../../src/clients/esClient.js");
  const { getSchedulerIndexDefinitions } = await import("../../src/elasticsearch/schedulerIndexMappings.js");
  const esClient = createEsClient();
  const indices = getSchedulerIndexDefinitions();

  for (const { name } of indices) {
    const exists = await esClient.indices.exists({ index: name });
    if (exists) {
      vpass("es", `index ${name} confirmed`);
    } else {
      vfail("es", `index ${name} missing — ES seed may have failed`);
    }
  }
  } // end ES_ENDPOINT guard
}

// 4b. Verify PG tables exist
{
  const dbEngine = process.env.DB_ENGINE || "direct";
  const hasPgConfig = dbEngine === "cloud-sql"
    ? Boolean(process.env.DB_INSTANCE_CONNECTION_NAME && process.env.DB_USER && process.env.DB_NAME)
    : Boolean(process.env.DATABASE_URL);

  if (!hasPgConfig) {
    warn("pg", "skipped — no PG config");
  } else {
    const { createPgPool } = await import("../../src/clients/pgClient.js");
    const pool = await createPgPool();
    try {
      const { rows } = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('job_instances','job_runs')"
      );
      const found = rows.map((r) => r.tablename);
      for (const table of ["job_instances", "job_runs"]) {
        if (found.includes(table)) vpass("pg", `table ${table} confirmed`);
        else vfail("pg", `table ${table} missing — PG migration may have failed`);
      }

      // Verify indexes
      const { rows: idxRows } = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('job_instances','job_runs')"
      );
      const idxNames = idxRows.map((r) => r.indexname);
      for (const idx of ["idx_job_instances_due", "idx_job_runs_queued", "idx_job_runs_instance"]) {
        if (idxNames.includes(idx)) vpass("pg", `index ${idx} confirmed`);
        else vfail("pg", `index ${idx} missing`);
      }
    } finally {
      await pool.end().catch(() => {});
    }
  }
}

// 4c. GCS bucket still accessible
{
  const bucket = process.env.JOB_ZIP_BUCKET;
  if (!bucket) {
    warn("gcs", "skipped — JOB_ZIP_BUCKET not set");
  } else {
    try {
      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
      const [exists] = await storage.bucket(bucket).exists();
      if (exists) vpass("gcs", `bucket '${bucket}' accessible`);
      else vfail("gcs", `bucket '${bucket}' not found`);
    } catch (e) {
      warn("gcs", `bucket check skipped — credentials unavailable: ${e.message}`);
    }
  }
}

// ─── Final summary ────────────────────────────────────────────────────────────

header("═══  Bootstrap complete  ═══");

if (validationFailures === 0) {
  ok("bootstrap", DRY_RUN
    ? "dry-run complete — no resources were modified"
    : "all resources provisioned and validated");
  if (!DRY_RUN) dim("  Manifest written to bootstrap-manifest.json — keep this file for teardown.");
  process.exit(0);
} else {
  fail("bootstrap", `${validationFailures} post-validation check(s) failed — infrastructure may be partially provisioned`);
  process.exit(1);
}

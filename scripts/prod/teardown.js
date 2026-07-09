#!/usr/bin/env node
// Teardown: reverses exactly what bootstrap-prod.js created, guided by bootstrap-manifest.json.
//
// Only deletes resources that were CREATED (not those that already existed) according to
// the manifest. Resources that existed before bootstrap are left untouched.
//
// Usage:
//   node scripts/prod/teardown.js                  # interactive confirmation
//   node scripts/prod/teardown.js --dry-run        # print what would happen, no deletes
//   node scripts/prod/teardown.js --force          # skip confirmation prompt (CI use)
//   node scripts/prod/teardown.js --manifest path  # use a specific manifest file
//
// WARNING: deletes Elasticsearch indices (all their data) and rolls back PG migrations.
// This is intended for environment cleanup, not production incident response.

import fs from "fs";
import path from "path";
import {
  ok, fail, warn, header, dim,
  MANIFEST_PATH, readManifest, confirm, stopwatch
} from "./lib.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const customManifest = (() => {
  const i = args.indexOf("--manifest");
  return i !== -1 ? args[i + 1] : null;
})();

// ─── Load manifest ────────────────────────────────────────────────────────────

const manifestPath = customManifest ? path.resolve(customManifest) : MANIFEST_PATH;

if (!fs.existsSync(manifestPath)) {
  fail("teardown", `manifest not found: ${manifestPath}`);
  console.error("Run bootstrap-prod.js first, or specify --manifest <path>.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.schemaVersion !== 1) {
  fail("teardown", `unknown manifest schemaVersion: ${manifest.schemaVersion}`);
  process.exit(1);
}

// ─── Print plan ───────────────────────────────────────────────────────────────

header("Teardown plan");
console.log(`  Manifest from: ${manifest.bootstrappedAt}`);
console.log(`  GCP project:   ${manifest.environment.gcpProjectId}`);
console.log(`  ES endpoint:   ${manifest.environment.esEndpoint}`);
console.log(`  DB engine:     ${manifest.environment.dbEngine}`);
console.log();

const esIndices = manifest.elasticsearch?.created ?? [];
const pgMigrations = manifest.postgres?.applied ?? [];

if (esIndices.length === 0 && pgMigrations.length === 0) {
  warn("teardown", "Manifest shows nothing was created by bootstrap — nothing to do.");
  console.log("\nResources that already existed before bootstrap are never deleted.");
  process.exit(0);
}

if (esIndices.length > 0) {
  console.log(`  ES indices to DELETE:  ${esIndices.join(", ")}`);
}
if (pgMigrations.length > 0) {
  console.log(`  PG migrations to ROLL BACK: ${pgMigrations.join(", ")}`);
  console.log(`  (rolls back via 'migrate:down' until pre-bootstrap state)`);
}

const skippedEs = manifest.elasticsearch?.alreadyExisted ?? [];
const skippedPg = manifest.postgres?.alreadyApplied ?? [];
if (skippedEs.length > 0) dim(`  ES indices NOT deleted (existed before bootstrap): ${skippedEs.join(", ")}`);
if (skippedPg.length > 0) dim(`  PG migrations NOT rolled back (existed before bootstrap): ${skippedPg.join(", ")}`);

if (DRY_RUN) {
  console.log("\n[dry-run] No changes made.");
  process.exit(0);
}

// ─── Confirmation ─────────────────────────────────────────────────────────────

if (!FORCE) {
  const confirmed = await confirm(
    `This will DELETE ${esIndices.length} ES index(es) and roll back ${pgMigrations.length} PG migration(s). Continue?`
  );
  if (!confirmed) {
    console.log("\nAborted.");
    process.exit(0);
  }
}

let failures = 0;

// ─── Tear down Elasticsearch ──────────────────────────────────────────────────

if (esIndices.length > 0) {
  header("Elasticsearch — deleting indices");
  const elapsed = stopwatch();

  try {
    // Set env vars from manifest for createEsClient (it reads ES_ENDPOINT + ES_API_KEY directly)
    const { createEsClient } = await import("../../src/clients/esClient.js");
    const esClient = createEsClient();

    for (const name of esIndices) {
      try {
        const exists = await esClient.indices.exists({ index: name });
        if (!exists) {
          warn("es", `${name} — already gone, skipped`);
          continue;
        }
        await esClient.indices.delete({ index: name });
        ok("es", `${name} — deleted`);
      } catch (e) {
        fail("es", `${name} — delete failed: ${e.message}`);
        failures++;
      }
    }
    dim(`  ES teardown complete (${elapsed()})`);
  } catch (e) {
    fail("es", `could not connect: ${e.message}`);
    failures++;
  }
}

// ─── Roll back Postgres migrations ────────────────────────────────────────────

if (pgMigrations.length > 0) {
  header("Postgres — rolling back migrations");
  const elapsed = stopwatch();

  const env = manifest.environment;
  const hasPgConfig = env.dbEngine === "cloud-sql"
    ? Boolean(env.dbInstanceConnectionName && process.env.DB_USER && process.env.DB_NAME)
    : Boolean(process.env.DATABASE_URL);

  if (!hasPgConfig) {
    warn("pg", "DB connection vars not in environment — cannot roll back. Set the same vars used during bootstrap.");
    failures++;
  } else {
    try {
      const { createPgPool } = await import("../../src/clients/pgClient.js");
      const { runner } = await import("node-pg-migrate");
      const { MIGRATIONS_DIR } = await import("./lib.js");
      const pool = await createPgPool();

      try {
        // Roll back exactly as many migrations as bootstrap applied
        await runner({
          dbClient: pool,
          migrationsTable: "pgmigrations",
          dir: MIGRATIONS_DIR,
          direction: "down",
          count: pgMigrations.length,
          log: (msg) => { if (msg.trim()) dim(`  pg: ${msg.trim()}`); }
        });
        ok("pg", `${pgMigrations.length} migration(s) rolled back`);
      } finally {
        await pool.end().catch(() => {});
      }
      dim(`  PG teardown complete (${elapsed()})`);
    } catch (e) {
      fail("pg", `rollback failed: ${e.message}`);
      failures++;
    }
  }
}

// ─── Archive / remove manifest ────────────────────────────────────────────────

header("Manifest");

if (failures === 0) {
  const archivePath = manifestPath.replace(/\.json$/, `.torn-down-${Date.now()}.json`);
  fs.renameSync(manifestPath, archivePath);
  ok("manifest", `archived to ${path.basename(archivePath)}`);
  dim("  Run bootstrap-prod.js again to re-provision.");
} else {
  warn("manifest", "manifest kept (teardown had failures) — re-run after fixing issues");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

header("Summary");

if (failures === 0) {
  ok("teardown", "all resources removed successfully");
  process.exit(0);
} else {
  fail("teardown", `${failures} step(s) failed — some resources may still exist`);
  process.exit(1);
}

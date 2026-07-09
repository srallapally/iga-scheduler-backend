import pg from "pg";
import { runner } from "node-pg-migrate";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function pgAvailable() {
  return Boolean(TEST_DATABASE_URL);
}

export async function createTestPool() {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL });
}

export async function applyMigrations(pool) {
  await runner({
    dbClient: pool,
    migrationsTable: "pgmigrations",
    dir: MIGRATIONS_DIR,
    direction: "up",
    log: () => {}
  });
}

export async function revertMigrations(pool) {
  await runner({
    dbClient: pool,
    migrationsTable: "pgmigrations",
    dir: MIGRATIONS_DIR,
    direction: "down",
    count: Infinity,
    log: () => {}
  });
}

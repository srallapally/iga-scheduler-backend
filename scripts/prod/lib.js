// Shared utilities for prod bootstrap scripts.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const MIGRATIONS_DIR = path.resolve(REPO_ROOT, "migrations");
export const MANIFEST_PATH = path.resolve(REPO_ROOT, "bootstrap-manifest.json");

// ─── terminal output ──────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

export function ok(section, msg) {
  console.log(`  ${GREEN}✓${RESET} [${section}] ${msg}`);
}

export function fail(section, msg) {
  console.error(`  ${RED}✗${RESET} [${section}] ${msg}`);
}

export function warn(section, msg) {
  console.warn(`  ${YELLOW}!${RESET} [${section}] ${msg}`);
}

export function header(msg) {
  console.log(`\n${BOLD}${msg}${RESET}`);
}

export function dim(msg) {
  console.log(`${DIM}  ${msg}${RESET}`);
}

// ─── env helpers ─────────────────────────────────────────────────────────────

export function env(name) {
  return process.env[name] || null;
}

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  return { ok: missing.length === 0, missing };
}

// ─── manifest ────────────────────────────────────────────────────────────────

export function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// ─── prompt ──────────────────────────────────────────────────────────────────

export async function confirm(question) {
  process.stdout.write(`\n${YELLOW}${BOLD}${question} [y/N] ${RESET}`);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.trim().toLowerCase() === "y");
    });
  });
}

// ─── CLI defaults (prod mode only) ───────────────────────────────────────────
//
// If APP_MODE != "local" and a var is absent from the environment, seed it from
// the corresponding CLI flag.  Env vars always win; CLI flags are a fallback.
//
// Supported flags:
//   --es-api-key   <key>    → ES_API_KEY
//   --es-endpoint  <url>    → ES_ENDPOINT
//   --gcp-project  <id>     → GCP_PROJECT_ID

export function applyCliDefaults(argv = process.argv.slice(2)) {
  if ((process.env.APP_MODE || "production") === "local") return;

  const flag = (name) => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(`--${name}=`.length);
      if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
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

// ─── timing ──────────────────────────────────────────────────────────────────

export function stopwatch() {
  const start = Date.now();
  return () => `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

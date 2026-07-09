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

// ─── timing ──────────────────────────────────────────────────────────────────

export function stopwatch() {
  const start = Date.now();
  return () => `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

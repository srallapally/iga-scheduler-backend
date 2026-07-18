// Universal entry point. Reads APP_MODE to decide which backend to start.
// APP_MODE=local  → SQLite + local filesystem (no GCP/ES required)
// APP_MODE=production (or unset) → Cloud SQL + ES + GCS (full production stack)

import { pathToFileURL } from "node:url";

// SEC-8: APP_MODE=local boots app.local.js, which never calls
// validateProductionStartupConfig -- so this is the one contradiction that
// bypasses production validation entirely. Refuse it outright rather than
// silently booting the unvalidated local/dev backend inside what's actually
// a production container.
export function resolveAppMode({ env = process.env } = {}) {
  const mode = env.APP_MODE || "production";
  if (mode === "local" && env.NODE_ENV === "production") {
    throw new Error("APP_MODE=local is incompatible with NODE_ENV=production; refusing to start the local/dev backend in a production environment");
  }
  return mode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = resolveAppMode();
    if (mode === "local") {
      const { startLocalApplication } = await import("./app.local.js");
      await startLocalApplication();
    } else {
      const { startApplication } = await import("./app.js");
      await startApplication();
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

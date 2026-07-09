// Universal entry point. Reads APP_MODE to decide which backend to start.
// APP_MODE=local  → SQLite + local filesystem (no GCP/ES required)
// APP_MODE=production (or unset) → Cloud SQL + ES + GCS (full production stack)

import { pathToFileURL } from "node:url";

const mode = process.env.APP_MODE || "production";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (mode === "local") {
    const { startLocalApplication } = await import("./app.local.js");
    startLocalApplication().catch((err) => { console.error(err); process.exit(1); });
  } else {
    const { startApplication } = await import("./app.js");
    startApplication().catch((err) => { console.error(err); process.exit(1); });
  }
}

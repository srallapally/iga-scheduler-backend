# ADR 0022: Fail Closed on Production-Guardrail Drift

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`validateWorkerStartupConfig` and `validateProductionStartupConfig`
(`src/config/productionValidation.js`) both gated every production control
they enforce — `WORKER_EXECUTION_MODE=isolated`, DB-engine constraints, the
`WORKER_RUNTIME_ISOLATION` rejection, service-account separateness — behind
`if (env.NODE_ENV !== "production") return {status:"skipped"}`. Both call
sites (`src/app.js`'s `startApplication()`, `src/workers/app.js`'s
`startWorker()`) discard the return value entirely. So any `NODE_ENV` drift
— unset, `"Production"`, a staging value copied forward — silently disables
every one of these checks and the process boots anyway, with no signal
anything is wrong. Separately, `src/main.js` reads `APP_MODE` to choose
between `app.js` (production, Cloud SQL/ES/GCS) and `app.local.js` (local
dev, SQLite, "Never calls `getConfig()` or
`validateProductionStartupConfig()`" per its own header comment) with zero
cross-check against `NODE_ENV`. If `APP_MODE=local` were ever set on an
actual production container, `main.js` would silently boot the fully local,
unvalidated backend — neither validator is ever in the loop for that path.
This is tracked as SEC-8.

Today's deploy pipeline hardcodes `NODE_ENV=production` in both Dockerfiles
and both `cloudbuild.yaml` deploy steps, and never sets `APP_MODE` at all,
so live risk was low. That's exactly the shape of gap worth closing anyway:
cheap to fix, and the alternative is a security posture that evaporates
silently on a single future config mistake.

---

## Decision

**Fail closed by default.** Neither `startApplication()` nor `startWorker()`
has a legitimate non-production run mode of its own — the only real
local-dev entrypoint is `app.local.js`, which never calls either validator.
So the "skip" branch in both validators existed purely for test convenience,
not to accommodate any real non-production invocation of `app.js` or
`workers/app.js`. Both are changed from `if (env.NODE_ENV !== "production")
skip` to `if (env.NODE_ENV === "test") skip` — the one value vitest actually
sets and the one every existing skip-path test already used. Every other
value, including unset, now falls through to full enforcement.

**Refuse the one contradiction that bypasses validation entirely.**
`src/main.js`'s mode decision is extracted into an exported, testable
`resolveAppMode({env})` (mirroring the existing `startApplication`/
`startWorker` pattern of an exported function plus a thin
`import.meta.url === pathToFileURL(process.argv[1]).href` bootstrap guard).
It throws if `APP_MODE === "local"` and `NODE_ENV === "production"`,
refusing to boot rather than silently starting the local backend inside a
container that's actually production. The bootstrap guard wraps the whole
startup sequence (mode resolution plus whichever `start*Application()` call
follows) in one `try/catch` → `console.error` + `process.exit(1)`, so a
thrown contradiction and a genuine startup failure are handled identically.

---

## Consequences

### What this closes

`NODE_ENV` drift (unset, mistyped, a stale non-production value) now
enforces every production guardrail instead of silently skipping all of
them. The `APP_MODE=local` + `NODE_ENV=production` contradiction — the one
combination that bypassed both validators structurally, not just via the
`NODE_ENV` check — now refuses to boot instead of silently running the
unvalidated local backend.

### What does not change

- The actual deploy pipeline's observable behavior — it already sets
  `NODE_ENV=production` in both Dockerfiles and both `cloudbuild.yaml`
  deploy steps, and never sets `APP_MODE` — so this fix changes nothing for
  a correctly-configured production deploy, only for drift/misconfiguration.
- `app.local.js` itself — still never calls either validator, by design;
  local dev is unaffected.
- Two related, previously-reviewed footguns are **not** addressed here,
  since both were confirmed unreachable in production: `WorkerRunService
  .completeRun` doesn't thread `dispatchId` into its `markSucceeded`/
  `markFailed` calls, but has zero live callers (SEC-3, ADR 0008, deliberately
  removed its only route); `routes/jobDefinitions.js`'s default
  `new JobDefinitionService()` has no `instanceStore` for COR-7's
  delete-cascade guard, but the only live entry point
  (`src/app.js`/`createApp.js`) always supplies one. Fixing either would be
  scope creep across unrelated bug IDs in this pass.

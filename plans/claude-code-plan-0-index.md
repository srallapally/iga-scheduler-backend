# Claude Code Plan Set: Postgres Coordination + PingOne Public API — Index

Supersedes the phase list in `plan-postgres-coordination-public-api.md`. Five plans, run in order; each leaves `npm test` green and the service deployable.

## Locked decisions carried into these plans

- Cloud SQL Postgres, regional HA. AlloyDB switchable — since no AlloyDB Node.js connector exists, the AlloyDB path is `DB_ENGINE=direct` + AlloyDB Auth Proxy sidecar; engines are `cloud-sql` and `direct`, and the switch lives only in `pgClient.js`. All SQL is portable Postgres.
- **D1:** Postgres is the queue. Cloud Tasks deleted. **Refinement:** no pg-boss — `job_runs` itself is the queue; a dispatch poller claims `QUEUED` rows via conditional `UPDATE`. Rationale: a separate pg-boss job table reintroduces dual-write coordination with the run row, and pg-boss's backoff/cron features are unneeded (retries are operator-driven).
- **D2:** instances move to Postgres. Tick becomes a single transaction.
- Definitions and audit stay in Elasticsearch.
- Public API secured by PingOne (client credentials, JWKS). Tenant scoping deferred.
- Internal Google-OIDC auth for scheduler/runtime callers unchanged.

## Plan sequence and dependencies

| # | File | Contents | Depends on |
|---|---|---|---|
| 1 | `claude-code-plan-1-pg-foundation.md` | Deps, migrations, connection factory, config, ADRs | — |
| 2 | `claude-code-plan-2-run-lifecycle.md` | `runStore`, rewire WorkerRunService / RunControlService / IGA proxy onto PG | 1 |
| 3 | `claude-code-plan-3-tick-instances-dispatch.md` | Instances on PG, transactional tick, dispatch poller | 2 |
| 4 | `claude-code-plan-4-deletion-pass.md` | Delete Cloud Tasks, maintenance service, ES run/instance machinery | 3 |
| 5 | `claude-code-plan-5-public-api-auth.md` | PingOne JWT middleware, secured public routes, run read endpoints | 2 (run read endpoints need `runStore`) |

Plan 5 can run in parallel with 3–4 after plan 2 completes.

## Standing caveats (apply across all plans)

- The repo currently contains **zero test files**; each plan creates the tests it asserts. Vitest is already configured.
- The **P0 trust gate** (`validateArtifactTrust` requires `approval`/`scan` fields nothing populates) is untouched by this plan set and still blocks every dispatch. Any e2e verification of the new path requires either seeding those fields on a test definition or resolving that issue first. Not in scope here — sequence separately.
- Known gap, unchanged by this work: a dispatched Cloud Run Job that dies without calling `/complete` leaves its run `RUNNING` forever (no stale-RUNNING sweep exists today either). Out of scope; noted so it isn't mistaken for a regression.
- No `docker`, `gcloud`, Terraform, or deployment commands in any plan. Infra is documented operator steps only.

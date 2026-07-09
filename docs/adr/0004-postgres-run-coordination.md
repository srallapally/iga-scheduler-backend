# ADR 0004: Postgres for Run Coordination

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-08

---

## Context

The scheduler uses Elasticsearch for all persistent state: job definitions, instances, runs, and audit events. ES was chosen for its flexible schema and full-text search on definitions, but its optimistic-lock model (`_seq_no`/`_primary_term`) and fan-out query patterns are the wrong fit for queue-style run coordination:

- Claiming a QUEUED run requires an ES script update; under load this produces update conflicts that must be retried in application code.
- There is no native row-level locking; the `QUEUED → RUNNING` transition cannot be made atomic without careful seq-no logic.
- Cloud Tasks (the current dispatch path) adds an external dependency and complicates cancellation and redrive flows.

Postgres provides `SELECT … FOR UPDATE SKIP LOCKED` for queue dispatch, native transactions, and `ON CONFLICT DO NOTHING` for idempotent tick inserts — all without an additional service.

---

## Decision

### Database: Cloud SQL regional HA, AlloyDB via auth-proxy

Cloud SQL Postgres (regional HA) is the production target. AlloyDB is supported via `DB_ENGINE=direct` with the AlloyDB Auth Proxy running as a sidecar — there is no AlloyDB language connector for Node.js; the Cloud SQL connector covers Cloud SQL only. This is documented in operator runbooks and ADR operator notes. Set `DB_ALLOW_DIRECT=true` in production AlloyDB deployments.

The engine switch lives exclusively in `src/clients/pgClient.js`. No file downstream of it may import a connector or read `DB_ENGINE`.

**Portable-SQL invariant:** all SQL is standard Postgres. No AlloyDB-only features, no Cloud SQL-specific extensions. This invariant is what makes `DB_ENGINE` an honest switch and what protects future migrations.

### D1: Postgres as queue — no pg-boss

`job_runs` is the queue. A dispatch poller claims `QUEUED` rows via a conditional `UPDATE … WHERE state = 'QUEUED' … RETURNING`. This is the simplest correct implementation.

A separate pg-boss job table was considered and rejected: it would reintroduce dual-write coordination between the run row and the queue entry (the exact problem we are solving), and pg-boss's backoff/cron features are unneeded here — retries are operator-driven, scheduling comes from the tick.

Cloud Tasks is deleted in plan 4.

### D2: Instances move to Postgres

`job_instances` moves from Elasticsearch to Postgres. The tick becomes a single transaction: find due instances, insert run rows (`ON CONFLICT DO NOTHING`), advance `next_fire_at`. This eliminates the ES-based tick's write-amplification and makes scheduling atomic.

### Elasticsearch demotion

ES retains:

- Job definitions (validated zip manifests, parameter schemas)
- Audit events (immutable append log)

Both fit ES's strengths (schema-flexible documents, no concurrency contention). ES run and instance indices are deleted in plan 4.

### Run state machine (unchanged)

```
QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLING → CANCELLED
```

Redrive creates a new run document with `:redrive:<uuid>` appended to `run_id`. The PK dedup mechanism is `ON CONFLICT DO NOTHING` on `run_id`.

---

## Consequences

### Plans 2–4 delete

- Cloud Tasks client and enqueue calls (plan 4)
- ES run/instance index writes and reads (plan 4)
- `internalWorkerPlaceholder.js` dispatch path (plan 4 inventory)

### What does not change

- Internal Google-OIDC auth for scheduler and runtime callers
- Audit event schema and ES emit path
- Route response shapes (one sanctioned exception: `completeRun` success-judgment fix in plan 2)

### Operator notes

**Cloud SQL deployment:**
- Set `DB_ENGINE=cloud-sql`
- Set `DB_INSTANCE_CONNECTION_NAME`, `DB_USER`, `DB_NAME`, and optionally `DB_PASSWORD`
- `DB_IP_TYPE` defaults to `PRIVATE`; set to `PUBLIC` for public-IP instances

**AlloyDB deployment:**
- Run AlloyDB Auth Proxy as a sidecar (standard pattern: `alloydb-auth-proxy <instance-uri> --port 5432`)
- Set `DB_ENGINE=direct`, `DATABASE_URL=postgresql://user:password@127.0.0.1:5432/dbname`
- Set `DB_ALLOW_DIRECT=true` in production to acknowledge the sidecar pattern

**Local / CI:**
- Set `DB_ENGINE=direct`, `DATABASE_URL` pointing at a local Postgres or testcontainer
- No `DB_ALLOW_DIRECT` needed outside production

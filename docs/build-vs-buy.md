# Build vs. Buy

**Date:** 2026-07-18

---

## Context

This system schedules and executes customer-written, untrusted job code against a single PingOne Advanced Identity Cloud (AIC) tenant — one full deployment per customer, and customers cannot share infrastructure. The question evaluated here: could an open-source (or managed) workflow engine replace this system, or its core, with no functional loss on GCP?

The system splits into two parts that are not equally replaceable:

- **The scheduling core** (~1,500 lines): cron tick, Postgres run queue (`FOR UPDATE SKIP LOCKED` claims), `dispatch_id` fencing (ADR 0014), heartbeats, pull-based cancellation (ADR 0019), stale-run sweeping, retry classification. Workflow engines do cover this.
- **Everything else**: the operator-facing API (AIC JWT auth, definitions/instances/runs), artifact verification (SHA-256 recompute + GCS generation pinning, ADR 0021), running untrusted code as capped subprocesses, Secret Manager parameter allowlisting (ADR 0007), the IGA credential boundary (ADR 0006, ADR 0018), and the ES audit trail. Every mainstream engine assumes job code is trusted and deployed with the platform; here, job code is uploaded at runtime by the customer and the platform must defend its credentials against it. No engine covers any of this.

## Decision

Keep the custom scheduling core. No candidate replaces the full system, and the strongest candidate (Temporal Cloud) runs into two properties of this architecture that require run state to live in the broker's own Postgres.

### Temporal

The scheduling core maps almost one-to-one onto Temporal: Schedules ↔ tick, task tokens ↔ dispatch fencing, activity heartbeats ↔ heartbeat loop + stale sweeper, heartbeat-carried cancellation ↔ pull-based cancel. Temporal covers none of the rest.

**Self-hosted** fails on operations alone: the server is four services plus its own database — it does not fit Cloud Run, so effectively GKE — and since customers cannot share infrastructure, that is one cluster per customer.

**Temporal Cloud, one namespace per customer under one account,** is the realistic variant. Two common objections do not hold here, and we say so:

- *Cost.* At this workload's volume (tens of thousands of runs per month for a busy customer; heartbeats on long reconciliation jobs are the main multiplier), metered cost lands in the tens-to-low-hundreds of dollars per customer per month — roughly a wash against the HA Cloud SQL instance Temporal could absorb.
- *Vendor exposure.* Customers already accept a per-customer GCP project and Elastic Cloud deployment under this platform's account; a third vendor is one more line in a security review, not a new category. Payload contents can additionally be encrypted client-side (Temporal stores ciphertext).

What decides against it:

1. **SEC-7 puts run state on the hot path of every job IGA call.** The IGA proxy checks, on *every* request a job makes, that the run is `RUNNING` and the caller's `dispatchId` matches the current claim (`runtimeIgaProxyService.request`). Today that is one indexed Postgres read. If Temporal owned run state, that check would become either (a) a Temporal Cloud API call per IGA request — the standard way to prove an attempt is alive is `RecordActivityTaskHeartbeat` with the task token — putting vendor latency, rate limits, and availability in front of every IGA call, and billing Actions by IGA-call volume instead of run volume, which erases the cost wash; or (b) a copy of the claim state in our own database — which brings back the database Temporal was supposed to replace, with the truth now in two places. A third option — the worker caches its own live task tokens and validates there — is blocked by the other trust boundary: it requires moving the IGA proxy into the worker, and SEC-1/ADR 0006 keeps the IGA credential in the scheduler precisely so the worker never holds it. Together, SEC-1 and SEC-7 force run state into the broker's own database.
2. **The job SDK contract must not change.** Jobs talk to the platform only through environment variables and HTTP (`IGA_BROKER_URL`, `IGA_SCHEDULER_RUN_ID`, `IGA_SCHEDULER_DISPATCH_ID`, the context file, the result protocol). Every customer's uploaded artifact depends on that contract, so any engine swap must keep it byte-for-byte. Jobs can never be Temporal activities themselves — untrusted code must not hold Temporal credentials — so the trusted worker would be the Temporal worker and spawn subprocesses exactly as today. The swap would therefore be invisible to customers: all cost, no customer-visible benefit.
3. **The scheduling core already works.** It is built, tested, and enough for what runs need today. The swap's price is a migration plus one more vendor in every customer's security review; its benefit is durability the system does not yet need.

At the start of the project, Temporal Cloud would have been a reasonable choice for the scheduling core. As a switch today it is not worth it.

### Other candidates

- **Windmill** (AGPLv3) is the only candidate that overlaps the product itself (it runs user-submitted scripts on schedules), but fails on licensing and on the credential boundary: it hands secrets to the running script — precisely what ADR 0006 exists to prevent.
- **Hatchet** (MIT, Postgres-backed, pull workers) matches our operational footprint and would have been a reasonable choice at the start; adopting it now swaps working, tested claim code for a younger project's equivalent.
- **Argo Workflows** requires Kubernetes, but one thing is worth noting honestly: pod-per-step gives the container-per-job isolation this system does not yet have (SEC-4 is open — isolation today is subprocess boundaries plus the credential proxy). If container-per-job ever becomes a hard requirement, Argo-on-GKE or Cloud Run Jobs is the natural shape.
- **Airflow / Dagster / Prefect** load DAGs as trusted platform code — the wrong trust model for runtime-uploaded artifacts. **pg-boss / Graphile Worker / BullMQ** replace only the claim logic, and we would give up control of the fencing behavior (ADR 0014).

## Consequences

- The decision rests on two things: the scheduling core already works, and SEC-1 + SEC-7 require run state in our own database regardless. Defend it in those terms — not by claiming the alternatives are unusable.
- **Revisit trigger:** runs needing to survive worker loss or resume mid-flight (COR-4/COR-5), or exactly-once requirements. The path then is Temporal Cloud, one namespace per customer — and the SEC-7 hot-path question above must be answered first, since it constrains any adoption design.
- Before any revisit: confirm Temporal Cloud namespaces can be created programmatically at customer onboarding (API/Terraform provider) and that account-level namespace limits cover the projected customer count. Unverified as of this ADR.
- Cost figures reflect Temporal Cloud pricing as of mid-2026 (~$50/M Actions, plans from $100–500/month at account level) and should be re-checked at revisit time.
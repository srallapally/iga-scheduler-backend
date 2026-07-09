# IGA Scheduler Backend

A GCP-hosted job scheduling backend. Manages job definitions, cron-scheduled instances, and individual job runs. The public API is secured with PingOne or PingOne Advanced Identity Cloud (AIC) OAuth (client credentials + JWKS). Internal endpoints use Google OIDC.

## Modes

| Mode | Command | Storage | Use |
|---|---|---|---|
| `local` | `npm run start:local` | SQLite + local filesystem | Development, smoke-testing |
| `production` | `npm run start:prod` | Cloud SQL Postgres + Elasticsearch + GCS | Production |

`npm start` reads `APP_MODE` from the environment (default: `production`).

PingOne / PingOne AIC OAuth is active in both modes — you need a real PingOne or AIC environment and a valid token to call the public API.

## Quick start (local mode)

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in the env file
cp .env.example .env
# Set APP_MODE=local and the PUBLIC_API_* / WORKER_* / SCHEDULER_* auth vars

# 3. (Optional) Run preflight — checks only the auth vars and JWKS endpoint in local mode
APP_MODE=local npm run preflight

# 4. Bootstrap (creates SQLite DB)
APP_MODE=local npm run bootstrap

# 5. Start
npm run start:local
```

## Architecture

```
HTTP Routes (src/routes/)
    → Services (src/services/)
    → Stores / Clients (src/stores/, src/clients/)
         → Cloud SQL Postgres  (run + instance state)
         → Elasticsearch       (job definitions + audit)
         → GCS                 (job artifact ZIPs)
```

`src/createApp.js` is the Express app factory used by both `src/app.js` (production) and tests.  
`src/index.js` exports `SchedulerJob` — the base class for job authors.

### Core concepts

- **Job definition** — a versioned ZIP artifact (manifest + entrypoint) stored in GCS and indexed in ES. Parameters are validated against a Zod schema declared in the zip.
- **Job instance** — a cron schedule bound to a definition, with parameter values. Stored in Postgres.
- **Run** — a single execution of a job instance. Created by the tick, executed by a worker.

### Run state machine

```
QUEUED → RUNNING → SUCCEEDED
                 → FAILED
                 → CANCELLING → CANCELLED
```

Redrive creates a new run with `runId` appended as `:redrive:<uuid>`.

### Tick and dispatch

`SchedulerTickService` fires every minute (triggered by GCP Cloud Scheduler). It finds instances where `nextFireAt <= now`, creates `QUEUED` run rows in Postgres, and advances `nextFireAt` — all in one transaction.

`RunDispatcher` polls for `QUEUED` runs and claims them via a conditional `UPDATE`. `WorkerRunService` then verifies the artifact trust chain and dispatches via local child process or isolated Cloud Run Job.

## Project structure

```
src/
├── main.js                   Universal entry — reads APP_MODE, delegates to app.js or app.local.js
├── createApp.js              Express app factory
├── app.js                    Production startup
├── app.local.js              Local startup (SQLite, no GCP/ES)
├── index.js                  SDK export (SchedulerJob)
├── backends/local/           SQLite-backed implementations of all stores/services
├── clients/                  ES, GCS, Cloud SQL, Cloud Run clients
├── config/                   Config loader + production validation
├── elasticsearch/            Index mapping definitions
├── iga/                      IGA API client + token manager
├── middleware/               publicAuth (PingOne/AIC), internalAuth (Google OIDC)
├── routes/                   Express routers (public + internal)
├── runtime/                  JobContext, parameters, result model
├── services/                 Tick, dispatch, worker, run control, proxy
├── stores/                   Postgres run + instance stores
├── utils/                    Cron, hashing, ZIP validation, run IDs
└── validation/               Zod schemas for request payloads
migrations/                   SQL migrations (node-pg-migrate)
scripts/
├── bootstrap.js              Idempotent local/dev bootstrap
└── prod/
    ├── preflight.js          Pre-deploy connectivity + config validation
    ├── bootstrap-prod.js     Production bootstrap (PG migrations + ES indices)
    └── teardown.js           Destroy prod resources
terraform/                    Cloud Scheduler cron tick provisioning
examples/                     Sample job implementations
docs/
├── runbook.md                Full operator runbook
└── adr/                      Architecture Decision Records
```

## npm scripts

| Script | Purpose |
|---|---|
| `npm start` | Start (reads `APP_MODE`, default `production`) |
| `npm run start:local` | Force local mode |
| `npm run start:prod` | Force production mode |
| `npm test` | Run all tests (`vitest run`) |
| `npm run bootstrap` | Idempotent local bootstrap |
| `npm run preflight` | Pre-deploy validation (local: auth vars + JWKS only; production: full) |
| `npm run bootstrap:prod` | Production bootstrap |
| `npm run bootstrap:prod:dry-run` | Dry-run production bootstrap |
| `npm run migrate:up` | Apply pending PG migrations |
| `npm run migrate:down` | Roll back latest PG migration |

## Environment variables

Copy `.env.example` and fill in values. Never commit `.env`.

**Required in all modes:**

| Variable | Purpose |
|---|---|
| `PUBLIC_API_ISSUER` | OAuth AS issuer — see **Choosing an authorization server** below |
| `PUBLIC_API_AUDIENCE` | Expected JWT audience |
| `WORKER_OIDC_AUDIENCE` | Audience for `/internal/worker/*` calls |
| `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL` | Service account allowed to invoke worker endpoints |
| `SCHEDULER_OIDC_AUDIENCE` | Audience for `/internal/scheduler/*` calls |
| `SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL` | Service account allowed to invoke tick endpoint |

**Additional required in production mode:**

| Variable | Purpose |
|---|---|
| `GCP_PROJECT_ID` | GCP project |
| `JOB_ZIP_BUCKET` | GCS bucket for job artifact ZIPs |
| `ES_ENDPOINT` | Elasticsearch cluster URL |
| `ES_API_KEY` | Elasticsearch API key |
| `DB_ENGINE` | `cloud-sql` or `direct` |
| `DB_INSTANCE_CONNECTION_NAME` | Cloud SQL connection name (if `cloud-sql`) |
| `DATABASE_URL` | Postgres URL (if `direct`) |
| `WORKER_EXECUTION_MODE` | Must be `isolated` in production |
| `RUNTIME_CLOUD_RUN_JOB_NAME` | Cloud Run Job name for isolated execution |
| `RUNTIME_SERVICE_ACCOUNT_EMAIL` | Service account for Cloud Run Job |
| `RUNTIME_BROKER_URL` | Callback URL for run completion |
| `IGA_TOKEN_ENDPOINT` | IGA OAuth token endpoint |
| `IGA_CLIENT_ID` | IGA client ID |
| `IGA_CLIENT_SECRET` | IGA client secret (or Secret Manager reference) |
| `IGA_BASE_URL` | IGA API base URL |

## Choosing an authorization server

Set `PUBLIC_API_ISSUER` to the issuer URL of whichever product your organization has licensed. The middleware auto-discovers the JWKS URL via OIDC discovery (`<issuer>/.well-known/openid-configuration`) — no additional configuration is needed for either product.

**PingOne (classic)**

Your organization has PingOne if the admin console is at `console.pingone.com`. The issuer URL is:

```
PUBLIC_API_ISSUER=https://auth.pingone.com/<env-id>/as
```

**PingOne Advanced Identity Cloud (AIC)**

AIC is the SaaS-hosted evolution of ForgeRock Identity Cloud. Your organization has AIC if the admin console is at `<tenant>.forgeblocks.com` (or a custom domain). The issuer is the realm's OAuth 2.0 base URL:

```
PUBLIC_API_ISSUER=https://<tenant>.forgeblocks.com/am/oauth2/<realm>
```

For example, for the `alpha` realm:
```
PUBLIC_API_ISSUER=https://openam-example.forgeblocks.com/am/oauth2/alpha
```

The OIDC discovery document is at `<issuer>/.well-known/openid-configuration` — e.g. `https://openam-example.forgeblocks.com/am/oauth2/alpha/.well-known/openid-configuration`. AIC publishes `jwks_uri` there at a path that differs from the PingOne convention, which is why OIDC discovery is used. If you are unsure of the realm name, check the OAuth 2.0 provider configuration in the AIC admin console under **Realms → \<realm\> → Services → OAuth2 Provider**.

**Overriding the JWKS URL**

In either case, set `PUBLIC_API_JWKS_URL` only if you need to point at a non-standard JWKS endpoint. When set, discovery is skipped entirely.

## Production bootstrap

Run preflight first — it validates all required vars and probes live connectivity without writing anything. In production mode it checks all six areas (env vars, Elasticsearch, Postgres, GCS, Secret Manager, JWKS). In local mode it checks only the auth vars and JWKS endpoint.

```bash
# Production (default)
npm run preflight
# or with inline creds if not already in the environment:
node scripts/prod/preflight.js \
  --es-endpoint https://my-cluster.es.io:9243 \
  --es-api-key  <key> \
  --gcp-project my-project

# Local mode
APP_MODE=local npm run preflight
```

`ES_ENDPOINT`, `ES_API_KEY`, and `GCP_PROJECT_ID` can be passed as `--es-endpoint`, `--es-api-key`, and `--gcp-project` CLI flags if they aren't already in the environment (production mode only).

Then seed Postgres migrations and Elasticsearch indices:

```bash
npm run bootstrap:prod
# or dry-run to see what would change:
npm run bootstrap:prod:dry-run
```

## Infrastructure

Cloud Scheduler (the minute-tick trigger) and its IAM bindings are provisioned by Terraform:

```bash
cd terraform
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

See `terraform/README.md` for required variables.

## Writing a job

```js
import { SchedulerJob } from 'iga-scheduler';

export default class MyJob extends SchedulerJob {
  async execute(context) {
    const { params, iga, logger } = context;
    // do work, call context.iga.* for IGA API access
    return { processed: 42 };
  }
}
```

Package as a ZIP with a `manifest.json` at the root:

```json
{
  "entrypoint": "my-job.js",
  "runtime": "node22",
  "wrapperVersion": "1"
}
```

See `examples/` for complete samples.

## Tests

```bash
npm test                                    # all tests
npx vitest run test/some.test.js            # single file
```

Tests use Vitest. No build step — the app runs as ESM directly under Node 22.

## Further reading

- `docs/runbook.md` — full operator runbook (local dev, production deploy, troubleshooting)
- `docs/adr/` — architecture decisions (Postgres-as-queue, PingOne auth)
- `terraform/README.md` — Cloud Scheduler Terraform module

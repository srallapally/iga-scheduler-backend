# Example Jobs

Each job lives in its own folder under `examples/js/` with a `job.js`, `manifest.json`, and a `README.md` covering packaging, deployment, and execution.

## Available examples

| Job | Description |
|---|---|
| [`js/risk-score-job`](js/risk-score-job/README.md) | Triggers a risk score recompute in the IGA platform |
| [`js/create-managed-users-job`](js/create-managed-users-job/README.md) | Creates 10 managed users in the AIC `alpha` realm |

## Prerequisites

All examples assume:

- The scheduler is running locally (`npm run start:local`) or in production.
- You have a valid Bearer token from your PingOne or AIC authorization server.
- `BASE_URL` and `TOKEN` are set in your shell.

```bash
BASE_URL=http://localhost:3000

TOKEN=$(curl -s -X POST "$PUBLIC_API_ISSUER/access_token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scope=<scope>" \
  | jq -r .access_token)
```

## Common operations

### List all job definitions

```bash
curl -s $BASE_URL/job-definitions \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

### List all instances for a definition

```bash
curl -s $BASE_URL/job-definitions/<definitionId>/instances \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

### Get a specific instance

```bash
curl -s $BASE_URL/job-instances/<instanceId> \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

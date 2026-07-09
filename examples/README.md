# Example Jobs

Two sample jobs are provided in `examples/js/`. Each section below covers what the job does, how to package and deploy it, and how to trigger a run.

## Prerequisites

All examples assume:

- The scheduler is running locally (`npm run start:local`) or in production.
- You have a valid Bearer token from your PingOne or AIC authorization server.
- `BASE_URL` is set to the scheduler's base URL (e.g. `http://localhost:3000`).

```bash
# Convenience variables used throughout this guide
BASE_URL=http://localhost:3000

TOKEN=$(curl -s -X POST "$PUBLIC_API_ISSUER/access_token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scope=<scope>" \
  | jq -r .access_token)
```

---

## 1. Risk Score Job (`risk-score-job.js`)

Triggers a risk score recompute in the IGA platform for a given scan type and set of applications.

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `scanType` | `string` | Yes | The type of risk scan to run (e.g. `full`, `delta`) |
| `applications` | `string[]` | Yes | List of application IDs to include in the scan |

### Package

```bash
mkdir -p /tmp/risk-score-job
cp examples/js/risk-score-job.js /tmp/risk-score-job/job.js

cat > /tmp/risk-score-job/manifest.json << 'EOF'
{
  "entrypoint": "job.js",
  "runtime": "node22",
  "wrapperVersion": "1"
}
EOF

cd /tmp/risk-score-job && zip -r /tmp/risk-score-job.zip . && cd -
```

### Deploy the definition

```bash
curl -s -X POST $BASE_URL/job-definitions \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={
    "definitionId":     "risk-score-recompute",
    "name":             "Risk Score Recompute",
    "runtime":          "javascript",
    "runtimeVersion":   "22",
    "wrapperVersion":   "1",
    "entrypoint":       "job.js",
    "parameters": [
      { "name": "scanType",     "type": "string",   "required": true },
      { "name": "applications", "type": "string[]", "required": true }
    ]
  }' \
  -F "artifact=@/tmp/risk-score-job.zip" \
  | jq .
```

### Create an instance and schedule a run

Pick a cron time 1–2 minutes from now. The scheduler tick fires every minute; once it passes the scheduled time it creates and dispatches a run.

```bash
curl -s -X POST $BASE_URL/job-definitions/risk-score-recompute/instances \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "risk-score-recompute-once",
    "schedule": {
      "type":       "cron",
      "expression": "30 15 * * *",
      "timezone":   "UTC"
    },
    "parameters": {
      "scanType":     { "type": "string",   "value": "full" },
      "applications": { "type": "string[]", "value": ["app-1", "app-2"] }
    }
  }' \
  | jq .
```

### Check the run

```bash
curl -s $BASE_URL/job-instances/risk-score-recompute-once/runs \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

### Disable after the first fire

```bash
curl -s -X PATCH $BASE_URL/job-instances/risk-score-recompute-once \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  | jq .
```

---

## 2. Create Managed Users Job (`create-managed-users-job.js`)

Creates managed users in the PingOne Advanced Identity Cloud (AIC) `alpha` realm via the IGA proxy (`context.iga.post`). Users are generated with realistic names. Any user that already exists (HTTP 409) or fails for any other reason is skipped; the run still succeeds and the return value reports what was created vs skipped.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `userNamePrefix` | `string` | No | `test-user-` | Prefix for generated `userName` values |
| `mailDomain` | `string` | No | `example.com` | Domain used for generated `mail` addresses |
| `count` | `string` | No | `10` | Number of users to create |

> `count` is declared as `string` because the parameter schema does not have a numeric type. The job converts it to a number internally.

### Local mode requirement

In local mode the job calls `context.iga.post()`, which proxies through the IGA client. Ensure `.env.local` has the AIC credentials set:

```
IGA_TOKEN_ENDPOINT=https://<tenant>.forgeblocks.com/am/oauth2/<realm>/access_token
IGA_CLIENT_ID=<client-id>
IGA_CLIENT_SECRET=<client-secret>
IGA_BASE_URL=https://<tenant>.forgeblocks.com
```

### Package

```bash
mkdir -p /tmp/create-users-job
cp examples/js/create-managed-users-job.js /tmp/create-users-job/job.js

cat > /tmp/create-users-job/manifest.json << 'EOF'
{
  "entrypoint": "job.js",
  "runtime": "node22",
  "wrapperVersion": "1"
}
EOF

cd /tmp/create-users-job && zip -r /tmp/create-managed-users-job.zip . && cd -
```

### Deploy the definition

```bash
curl -s -X POST $BASE_URL/job-definitions \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={
    "definitionId":     "create-managed-users",
    "name":             "Create Managed Users",
    "runtime":          "javascript",
    "runtimeVersion":   "22",
    "wrapperVersion":   "1",
    "entrypoint":       "job.js",
    "parameters": [
      { "name": "userNamePrefix", "type": "string", "required": false },
      { "name": "mailDomain",     "type": "string", "required": false },
      { "name": "count",          "type": "string", "required": false }
    ]
  }' \
  -F "artifact=@/tmp/create-managed-users-job.zip" \
  | jq .
```

### Create an instance and schedule a run

```bash
curl -s -X POST $BASE_URL/job-definitions/create-managed-users/instances \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "create-managed-users-once",
    "schedule": {
      "type":       "cron",
      "expression": "30 15 * * *",
      "timezone":   "UTC"
    },
    "parameters": {
      "userNamePrefix": { "type": "string", "value": "test-user-" },
      "mailDomain":     { "type": "string", "value": "example.com" },
      "count":          { "type": "string", "value": "10" }
    }
  }' \
  | jq .
```

Replace `30 15 * * *` with a time 1–2 minutes from now (in UTC): `<minute> <hour> * * *`.

### Check the run

```bash
curl -s $BASE_URL/job-instances/create-managed-users-once/runs \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

A successful run returns a result like:

```json
{
  "requested": 10,
  "created": 10,
  "skipped": 0,
  "createdUsers": ["test-user-01", "test-user-02", "..."],
  "skippedUsers": []
}
```

### Disable after the first fire

```bash
curl -s -X PATCH $BASE_URL/job-instances/create-managed-users-once \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  | jq .
```

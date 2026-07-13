# alpha-users-ml-job (Python)

Queries all managed users in the PingOne AIC **alpha realm** via the IGA Scheduler
SDK and runs **IsolationForest** anomaly detection to flag accounts with unusual
access patterns (stale sync, high role/group count, long inactivity, disabled status).

## What it does

1. Paginates through `GET /openidm/managed/alpha_user` using `context["iga_client"]`
2. Extracts numeric features per user: account age, days since last sync, role count, group count, disabled flag
3. Scales features with `StandardScaler` and fits an `IsolationForest` model
4. Returns flagged accounts sorted by anomaly score, plus per-feature summary statistics

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `pageSize` | int | `200` | IDM query page size per request |
| `contamination` | float | `0.05` | Expected fraction of anomalous accounts (0–0.5) |
| `fields` | string | see job.py | Comma-separated IDM field names to fetch |

## Local dev setup

### Prerequisites

```bash
# From the repo root — install the SDK and ML libraries
pip install sdk/python/ numpy scipy pandas scikit-learn python-dateutil
```

### Required environment variables

```bash
# For local mode — DirectIgaClient reads these from env
export IGA_BASE_URL=https://<tenant>.forgeblocks.com/am
export IGA_TOKEN_ENDPOINT=https://<tenant>.forgeblocks.com/am/oauth2/alpha/access_token
export IGA_CLIENT_ID=<your-client-id>
export IGA_CLIENT_SECRET=<your-client-secret>
export IGA_SCHEDULER_RUN_ID=local-test-run
```

## Deploy

```bash
# 1. Create the artifact ZIP
zip -j alpha-users-ml-job.zip manifest.json job.py

# 2. Create the job definition
curl -X POST http://localhost:3000/api/v1/definitions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "definitionId": "alpha-users-ml",
    "name": "Alpha Users ML Anomaly Detection",
    "runtime": "python",
    "runtimeVersion": "python311",
    "entrypoint": "job.py",
    "parameters": {
      "pageSize":      { "type": "number" },
      "contamination": { "type": "number" },
      "fields":        { "type": "string" }
    }
  }'

# 3. Upload the artifact
curl -X PUT "http://localhost:3000/api/v1/definitions/alpha-users-ml/artifact" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/zip" \
  --data-binary @alpha-users-ml-job.zip
```

## Schedule

```bash
curl -X POST http://localhost:3000/api/v1/instances \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "alpha-users-ml-nightly",
    "definitionId": "alpha-users-ml",
    "cronExpression": "0 2 * * *",
    "params": {
      "pageSize": 200,
      "contamination": 0.05
    }
  }'
```

## Sample output

```json
{
  "status": "completed",
  "totalFetched": 1432,
  "anomalyCount": 71,
  "flaggedUsers": [
    {
      "_id": "abc123",
      "userName": "jdoe@example.com",
      "anomaly_score": -0.1843,
      "role_count": 47,
      "group_count": 12,
      "days_since_sync": 342,
      "is_disabled": 0
    }
  ],
  "summary": {
    "account_age_days": { "mean": 487.3, "std": 210.1, "max": 1820.0 },
    "days_since_sync":  { "mean": 14.2,  "std": 31.8,  "max": 401.0  },
    "role_count":       { "mean": 3.1,   "std": 4.7,   "max": 63.0   },
    "group_count":      { "mean": 2.4,   "std": 2.9,   "max": 28.0   },
    "is_disabled":      { "mean": 0.03,  "std": 0.17,  "max": 1.0    }
  }
}
```

## Production notes

- `numpy`, `scipy`, `pandas`, `scikit-learn`, and `python-dateutil` are pre-installed
  in the worker image (`runtime-containers/worker/Dockerfile`). No extra packaging needed.
- The job does **not** persist the trained model — it is re-fit on each run from the
  live user population. For trend analysis across runs, emit the `summary` block to an
  external store.
- Tune `contamination` to your environment. A value of `0.05` flags roughly the top 5%
  most anomalous accounts. Lower values reduce false positives at the cost of recall.
- The IDM field list (`fields` parameter) must match your tenant's schema. Use
  `GET /openidm/managed/alpha_user?_queryFilter=true&_pageSize=1` to inspect available fields.

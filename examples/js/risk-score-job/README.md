# Risk Score Job

Triggers a risk score recompute in the IGA platform for a given scan type and set of applications.

## Files

```
risk-score-job/
├── job.js          Job implementation
└── manifest.json   Runtime manifest
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `scanType` | `string` | Yes | Type of risk scan to run (e.g. `full`, `delta`) |
| `applications` | `string[]` | Yes | List of application IDs to include in the scan |

## Package

Run from the repo root:

```bash
cd examples/js/risk-score-job
zip -r /tmp/risk-score-job.zip .
cd -
```

## Deploy the definition

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

## List definitions

```bash
curl -s $BASE_URL/job-definitions \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Create an instance and schedule a run

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

Replace `30 15 * * *` with a time 1–2 minutes from now (in UTC): `<minute> <hour> * * *`.

## List instances

```bash
curl -s $BASE_URL/job-definitions/risk-score-recompute/instances \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Check the run

```bash
curl -s $BASE_URL/job-instances/risk-score-recompute-once/runs \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Disable after the first fire

```bash
curl -s -X PATCH $BASE_URL/job-instances/risk-score-recompute-once \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  | jq .
```

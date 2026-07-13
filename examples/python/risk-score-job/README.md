# risk-score-job (Python)

Triggers an IGA risk score recompute for a configurable list of applications.

## Local dev setup

1. Install Python 3.11 or 3.12.
2. From the repo root, install the SDK and its dependencies once:
   ```bash
   pip install sdk/python/
   ```
3. If `python3.11` or `python3.12` is installed but not on `PATH` (e.g. via pyenv without
   shell integration), set the override:
   ```bash
   export PYTHON311_BIN=/path/to/python3.11
   ```

## Deploy

```bash
# 1. Create a zip of this directory
zip -j risk-score-job.zip manifest.json job.py

# 2. Upload the definition
curl -X POST http://localhost:3000/api/v1/definitions \
  -H "Content-Type: application/json" \
  -d '{
    "definitionId": "risk-score-python",
    "name": "Risk Score Recompute (Python)",
    "runtime": "python",
    "runtimeVersion": "python311",
    "entrypoint": "job.py",
    "parameters": {
      "scanType": { "type": "string", "required": true },
      "applications": { "type": "array", "items": { "type": "string" }, "required": true }
    }
  }'

# 3. Upload the artifact zip
curl -X PUT "http://localhost:3000/api/v1/definitions/risk-score-python/artifact" \
  -H "Content-Type: application/zip" \
  --data-binary @risk-score-job.zip
```

## Schedule

```bash
curl -X POST http://localhost:3000/api/v1/instances \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "risk-score-python-hourly",
    "definitionId": "risk-score-python",
    "cronExpression": "0 * * * *",
    "params": {
      "scanType": "full",
      "applications": ["salesforce", "workday"]
    }
  }'
```

## Check a run

```bash
curl http://localhost:3000/api/v1/runs/risk-score-python-hourly
```

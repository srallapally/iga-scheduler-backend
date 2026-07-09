# Create Managed Users Job

Creates managed users in the PingOne Advanced Identity Cloud (AIC) `alpha` realm via the IGA proxy (`context.iga.post`). Users are generated with realistic names. Any user that already exists (HTTP 409) or fails for any other reason is skipped; the run still succeeds and the return value reports what was created vs skipped.

## Files

```
create-managed-users-job/
├── job.js          Job implementation
└── manifest.json   Runtime manifest
```

## Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `userNamePrefix` | `string` | No | `test-user-` | Prefix for generated `userName` values |
| `mailDomain` | `string` | No | `example.com` | Domain used for generated `mail` addresses |
| `count` | `string` | No | `10` | Number of users to create |

> `count` is declared as `string` because the parameter schema does not have a numeric type. The job converts it to a number internally.

## Local mode requirement

In local mode the job calls `context.iga.post()`, which proxies through the IGA client. Ensure `.env.local` has the AIC credentials set:

```
IGA_TOKEN_ENDPOINT=https://<tenant>.forgeblocks.com/am/oauth2/<realm>/access_token
IGA_CLIENT_ID=<client-id>
IGA_CLIENT_SECRET=<client-secret>
IGA_BASE_URL=https://<tenant>.forgeblocks.com
```

## Package

Run from the repo root:

```bash
cd examples/js/create-managed-users-job
zip -r /tmp/create-managed-users-job.zip .
cd -
```

## Deploy the definition

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

## List definitions

```bash
curl -s $BASE_URL/job-definitions \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Create an instance and schedule a run

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

## List instances

```bash
curl -s $BASE_URL/job-definitions/create-managed-users/instances \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Check the run

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

## Disable after the first fire

```bash
curl -s -X PATCH $BASE_URL/job-instances/create-managed-users-once \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  | jq .
```

#!/usr/bin/env bash
# Post-deploy smoke test: exercises the full job lifecycle against the live scheduler service.
#
# Steps (each validated before proceeding to the next):
#   1. Health check    — GET /health
#   2. AIC token       — obtain a public API access token from IGA_TOKEN_ENDPOINT
#   3. Create def      — POST /job-definitions (multipart with test zip)
#   4. Get def         — GET /job-definitions/:id
#   5. List defs       — GET /job-definitions (confirm test def appears)
#   6. Create instance — POST /job-definitions/:id/instances
#   7. List instances  — GET /job-definitions/:id/instances
#   8. Run now         — POST /job-instances/:instanceId/run-now
#   9. Cancel run      — POST /job-runs/:runId/cancel
#  10. Delete instance — DELETE /job-instances/:instanceId
#  11. Delete def      — DELETE /job-definitions/:id
#
# Usage:
#   source scripts/prod/set-env.sh
#   bash scripts/prod/post-deploy.sh
#   bash scripts/prod/post-deploy.sh --dry-run   # print steps only, no API calls
#
# Required env vars:
#   RUNTIME_BROKER_URL, IGA_TOKEN_ENDPOINT, IGA_CLIENT_ID, IGA_CLIENT_SECRET, PUBLIC_API_AUDIENCE
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

# ── Required env var check ────────────────────────────────────────────────────
REQUIRED_VARS=(RUNTIME_BROKER_URL IGA_TOKEN_ENDPOINT IGA_CLIENT_ID IGA_CLIENT_SECRET PUBLIC_API_AUDIENCE)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!v:-}" ]] && MISSING+=("$v")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: missing required environment variables:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  echo "Run: source scripts/prod/set-env.sh" >&2
  exit 1
fi

BASE_URL="${RUNTIME_BROKER_URL%/}"
FAILURES=0
DEF_ID="post-deploy-smoke-test"
INSTANCE_ID=""
RUN_ID=""
ACCESS_TOKEN=""

# ── Output helpers ────────────────────────────────────────────────────────────
ok()   { printf "  \033[32m[ok]\033[0m    %s\n" "$*"; }
fail() { printf "  \033[31m[FAIL]\033[0m  %s\n" "$*" >&2; FAILURES=$((FAILURES+1)); }
step() { echo ""; echo "── $*"; }
info() { printf "  \033[2m%s\033[0m\n" "$*"; }

# ── HTTP helper ───────────────────────────────────────────────────────────────
# http <method> <path> [extra curl args...]
# Sets HTTP_STATUS and HTTP_BODY globals.
http() {
  local method="$1" path="$2"
  shift 2
  local response
  response=$(curl -s -w "\n__STATUS__%{http_code}" \
    -X "$method" \
    "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    "$@" 2>/dev/null)
  HTTP_BODY="${response%$'\n__STATUS__'*}"
  HTTP_STATUS="${response##*$'\n__STATUS__'}"
}

# jq_val: extract a JSON field from $HTTP_BODY using jq if available, or a
# simple sed fallback so the script works without jq installed.
jq_val() {
  local key="$1"
  if command -v jq &>/dev/null; then
    echo "$HTTP_BODY" | jq -r ".${key} // empty" 2>/dev/null
  else
    echo "$HTTP_BODY" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
  fi
}

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "=== Post-deploy smoke test (dry-run) ==="
  echo "  BASE_URL: ${BASE_URL}"
  echo "  Steps that would run:"
  echo "    1. GET  /health"
  echo "    2. POST ${IGA_TOKEN_ENDPOINT} (AIC token)"
  echo "    3. POST /job-definitions  (create ${DEF_ID})"
  echo "    4. GET  /job-definitions/${DEF_ID}"
  echo "    5. GET  /job-definitions"
  echo "    6. POST /job-definitions/${DEF_ID}/instances"
  echo "    7. GET  /job-definitions/${DEF_ID}/instances"
  echo "    8. POST /job-instances/<id>/run-now"
  echo "    9. POST /job-runs/<runId>/cancel"
  echo "   10. DELETE /job-instances/<id>"
  echo "   11. DELETE /job-definitions/${DEF_ID}"
  echo ""
  echo "=== Dry-run complete ==="
  exit 0
fi

echo ""
echo "=== Post-deploy smoke test ==="
echo "  BASE_URL: ${BASE_URL}"

# ── Step 1: Health check ──────────────────────────────────────────────────────
step "1 / 11  Health check"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health" 2>/dev/null)
if [[ "$HTTP_STATUS" == "200" ]]; then
  ok "GET /health → 200"
else
  fail "GET /health → ${HTTP_STATUS} (expected 200)"
  echo "ERROR: service not reachable at ${BASE_URL}" >&2
  exit 1
fi

# ── Step 2: AIC access token ──────────────────────────────────────────────────
step "2 / 11  AIC access token"
TOKEN_RESPONSE=$(curl -s -w "\n__STATUS__%{http_code}" \
  -X POST "${IGA_TOKEN_ENDPOINT}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${IGA_CLIENT_ID}&client_secret=${IGA_CLIENT_SECRET}" \
  2>/dev/null)
TOKEN_BODY="${TOKEN_RESPONSE%$'\n__STATUS__'*}"
TOKEN_STATUS="${TOKEN_RESPONSE##*$'\n__STATUS__'}"

if [[ "$TOKEN_STATUS" != "200" ]]; then
  fail "POST ${IGA_TOKEN_ENDPOINT} → ${TOKEN_STATUS} (expected 200)"
  info "Response: ${TOKEN_BODY}"
  echo "ERROR: cannot obtain AIC token — aborting smoke test" >&2
  exit 1
fi

if command -v jq &>/dev/null; then
  ACCESS_TOKEN=$(echo "$TOKEN_BODY" | jq -r '.access_token // empty')
else
  ACCESS_TOKEN=$(echo "$TOKEN_BODY" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

if [[ -z "$ACCESS_TOKEN" ]]; then
  fail "access_token missing in token response"
  info "Response: ${TOKEN_BODY}"
  exit 1
fi
ok "access_token obtained (${#ACCESS_TOKEN} chars)"

# ── Step 3: Create job definition ─────────────────────────────────────────────
step "3 / 11  Create job definition"

# Build a minimal test zip in /tmp: manifest.json + job.js
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "${TMP_DIR}/manifest.json" <<'EOF'
{
  "entrypoint": "job.js",
  "runtime": "javascript",
  "wrapperVersion": "1.0.0"
}
EOF

cat > "${TMP_DIR}/job.js" <<'EOF'
export default async function run(ctx) {
  ctx.log("post-deploy smoke test job");
  return { ok: true };
}
EOF

(cd "$TMP_DIR" && zip -q smoke-test.zip manifest.json job.js)
TEST_ZIP="${TMP_DIR}/smoke-test.zip"

METADATA=$(printf '{"definitionId":"%s","name":"Post-deploy smoke test","runtime":"javascript","runtimeVersion":"22","wrapperVersion":"1.0.0","entrypoint":"job.js","parameters":[],"timeoutSeconds":60}' "$DEF_ID")

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${BASE_URL}/job-definitions" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F "artifact=@${TEST_ZIP};type=application/zip" \
  -F "metadata=${METADATA}" \
  2>/dev/null)

if [[ "$HTTP_STATUS" == "201" ]] || [[ "$HTTP_STATUS" == "409" ]]; then
  [[ "$HTTP_STATUS" == "201" ]] && ok "POST /job-definitions → 201 (created)" \
                                || ok "POST /job-definitions → 409 (already exists — idempotent re-run)"
else
  fail "POST /job-definitions → ${HTTP_STATUS} (expected 201)"
fi

# ── Step 4: Get job definition ────────────────────────────────────────────────
step "4 / 11  Get job definition"
http GET "/job-definitions/${DEF_ID}"
if [[ "$HTTP_STATUS" == "200" ]]; then
  ok "GET /job-definitions/${DEF_ID} → 200"
else
  fail "GET /job-definitions/${DEF_ID} → ${HTTP_STATUS} (expected 200)"
fi

# ── Step 5: List job definitions — pick an ACTIVE one for instance/run steps ──
# The smoke test definition is PENDING (awaiting trust-gate approval/scan), so it
# won't appear in the list and can't have instances created against it.
# Use the first ACTIVE definition found in the list for steps 6–10.
step "5 / 11  List job definitions"
http GET "/job-definitions"
ACTIVE_DEF_ID=""
if [[ "$HTTP_STATUS" == "200" ]]; then
  ok "GET /job-definitions → 200"
  if command -v jq &>/dev/null; then
    ACTIVE_DEF_ID=$(echo "$HTTP_BODY" | jq -r '[.items[] | select(.state=="ACTIVE")] | first | .definitionId // empty' 2>/dev/null)
  else
    # Grab the definitionId of the first item whose state is ACTIVE
    ACTIVE_DEF_ID=$(echo "$HTTP_BODY" \
      | grep -o '"definitionId":"[^"]*"' | head -1 \
      | sed 's/"definitionId":"//;s/"//')
  fi
  if [[ -n "$ACTIVE_DEF_ID" ]]; then
    ok "active definition for instance/run steps: ${ACTIVE_DEF_ID}"
  else
    fail "no ACTIVE definition found in list — steps 6–10 will be skipped"
    info "Response: ${HTTP_BODY}"
  fi
else
  fail "GET /job-definitions → ${HTTP_STATUS} (expected 200)"
fi

# ── Step 6: Create instance ───────────────────────────────────────────────────
step "6 / 11  Create instance"
if [[ -z "$ACTIVE_DEF_ID" ]]; then
  fail "skipped — no ACTIVE definition available"
else
  INSTANCE_BODY='{"instanceId":"post-deploy-smoke-instance","enabled":false,"schedule":{"type":"cron","expression":"0 2 * * *","timezone":"UTC"},"parameters":{}}'
  http POST "/job-definitions/${ACTIVE_DEF_ID}/instances" \
    -H "Content-Type: application/json" \
    -d "$INSTANCE_BODY"

  if [[ "$HTTP_STATUS" == "201" ]] || [[ "$HTTP_STATUS" == "409" ]]; then
    [[ "$HTTP_STATUS" == "201" ]] && ok "POST /job-definitions/${ACTIVE_DEF_ID}/instances → 201" \
                                  || ok "POST /job-definitions/${ACTIVE_DEF_ID}/instances → 409 (already exists)"
    http GET "/job-instances/post-deploy-smoke-instance"
    INSTANCE_ID=$(jq_val "instanceId")
    [[ -n "$INSTANCE_ID" ]] && info "instanceId: ${INSTANCE_ID}" || INSTANCE_ID="post-deploy-smoke-instance"
  else
    fail "POST /job-definitions/${ACTIVE_DEF_ID}/instances → ${HTTP_STATUS} (expected 201)"
    info "Response: ${HTTP_BODY}"
  fi
fi

# ── Step 7: List instances ────────────────────────────────────────────────────
step "7 / 11  List instances"
if [[ -z "$ACTIVE_DEF_ID" ]]; then
  fail "skipped — no ACTIVE definition available"
else
  http GET "/job-definitions/${ACTIVE_DEF_ID}/instances"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    ok "GET /job-definitions/${ACTIVE_DEF_ID}/instances → 200"
  else
    fail "GET /job-definitions/${ACTIVE_DEF_ID}/instances → ${HTTP_STATUS} (expected 200)"
  fi
fi

# ── Step 8: Run now ───────────────────────────────────────────────────────────
step "8 / 11  Run now"
if [[ -z "$INSTANCE_ID" ]]; then
  fail "skipped — no instanceId available"
else
  http POST "/job-instances/${INSTANCE_ID}/run-now" \
    -H "Content-Type: application/json" -d '{}'
  if [[ "$HTTP_STATUS" == "201" ]]; then
    RUN_ID=$(jq_val "runId")
    ok "POST /job-instances/${INSTANCE_ID}/run-now → 201"
    info "runId: ${RUN_ID}"
  else
    fail "POST /job-instances/${INSTANCE_ID}/run-now → ${HTTP_STATUS} (expected 201)"
    info "Response: ${HTTP_BODY}"
  fi
fi

# ── Step 9: Cancel run ────────────────────────────────────────────────────────
step "9 / 11  Cancel run"
if [[ -z "$RUN_ID" ]]; then
  fail "skipped — no runId available"
else
  # URL-encode the runId (colons → %3A)
  ENCODED_RUN_ID="${RUN_ID//:/%3A}"
  http POST "/job-runs/${ENCODED_RUN_ID}/cancel" \
    -H "Content-Type: application/json" \
    -d '{"reason":"post-deploy smoke test cleanup"}'
  if [[ "$HTTP_STATUS" == "202" ]] || [[ "$HTTP_STATUS" == "409" ]]; then
    [[ "$HTTP_STATUS" == "202" ]] && ok "POST /job-runs/.../cancel → 202" \
                                  || ok "POST /job-runs/.../cancel → 409 (already terminal)"
  else
    fail "POST /job-runs/.../cancel → ${HTTP_STATUS} (expected 202)"
    info "Response: ${HTTP_BODY}"
  fi
fi

# ── Step 10: Delete instance ──────────────────────────────────────────────────
step "10 / 11  Delete instance"
if [[ -z "$INSTANCE_ID" ]]; then
  fail "skipped — no instanceId available"
else
  http DELETE "/job-instances/post-deploy-smoke-instance"
  if [[ "$HTTP_STATUS" == "200" ]] || [[ "$HTTP_STATUS" == "404" ]]; then
    [[ "$HTTP_STATUS" == "200" ]] && ok "DELETE /job-instances/post-deploy-smoke-instance → 200" \
                                  || ok "DELETE /job-instances/post-deploy-smoke-instance → 404 (already deleted)"
  else
    fail "DELETE /job-instances/post-deploy-smoke-instance → ${HTTP_STATUS} (expected 200)"
    info "Response: ${HTTP_BODY}"
  fi
fi

# ── Step 11: Delete job definition ────────────────────────────────────────────
step "11 / 11  Delete job definition"
http DELETE "/job-definitions/${DEF_ID}"
if [[ "$HTTP_STATUS" == "200" ]] || [[ "$HTTP_STATUS" == "404" ]]; then
  [[ "$HTTP_STATUS" == "200" ]] && ok "DELETE /job-definitions/${DEF_ID} → 200" \
                                || ok "DELETE /job-definitions/${DEF_ID} → 404 (already deleted)"
else
  fail "DELETE /job-definitions/${DEF_ID} → ${HTTP_STATUS} (expected 200)"
  info "Response: ${HTTP_BODY}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "── Summary"
if [[ $FAILURES -eq 0 ]]; then
  printf "\033[32m  all smoke tests passed\033[0m\n"
  echo ""
  exit 0
else
  printf "\033[31m  %d smoke test(s) failed — see above\033[0m\n" "$FAILURES"
  echo ""
  exit 1
fi

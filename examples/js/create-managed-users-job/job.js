import fs from "fs/promises";
import { SchedulerJob } from "./scheduler-sdk.js";

const GIVEN_NAMES = [
  "James", "William", "Henry", "Charles", "George",
  "Thomas", "Edward", "Robert", "Richard", "Arthur",
];
const SURNAMES = [
  "Harrison", "Fletcher", "Whitmore", "Caldwell", "Bennett",
  "Sinclair", "Montgomery", "Ashford", "Pemberton", "Holloway",
];

function buildUser(index, { userNamePrefix, mailDomain }) {
  const given = GIVEN_NAMES[index % GIVEN_NAMES.length];
  const sn    = SURNAMES[index % SURNAMES.length];
  const tag   = String(index + 1).padStart(2, "0");
  const userName = `${userNamePrefix}${tag}`;
  return { userName, givenName: given, sn, mail: `${userName}@${mailDomain}` };
}

// Fetch a client-credentials token from the IGA token endpoint.
async function fetchToken({ tokenEndpoint, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "fr:idm:*",
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token fetch failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

// Build a minimal IGA HTTP client from igaDirect config in the context file.
function buildIgaClient({ baseUrl, tokenEndpoint, clientId, clientSecret }) {
  let cachedToken = null;

  async function getToken() {
    if (!cachedToken) {
      cachedToken = await fetchToken({ tokenEndpoint, clientId, clientSecret });
    }
    return cachedToken;
  }

  async function post(path, body) {
    const token = await getToken();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return { post };
}

class CreateManagedUsersJob extends SchedulerJob {
  async execute(context) {
    const userNamePrefix = context.param?.string?.("userNamePrefix") ?? context.params?.userNamePrefix?.value ?? "test-user-";
    const mailDomain     = context.param?.string?.("mailDomain")     ?? context.params?.mailDomain?.value     ?? "example.com";
    const count          = Number(context.param?.get?.("count", 10)  ?? context.params?.count?.value          ?? 10);

    const igaClient = context.igaDirect
      ? buildIgaClient(context.igaDirect)
      : context.iga;

    const MANAGED_USER_PATH = "/openidm/managed/alpha_user";
    const created = [];
    const skipped = [];

    for (let i = 0; i < count; i++) {
      const user = buildUser(i, { userNamePrefix, mailDomain });
      try {
        await igaClient.post(MANAGED_USER_PATH, user);
        created.push(user.userName);
        process.stderr.write(`[INFO] Created user ${user.userName}\n`);
      } catch (err) {
        const status = err.status ?? err.statusCode ?? err.response?.status;
        if (status === 409) {
          process.stderr.write(`[WARN] User ${user.userName} already exists — skipping\n`);
        } else {
          process.stderr.write(`[ERROR] Failed to create ${user.userName}: ${err.message}\n`);
        }
        skipped.push({ userName: user.userName, reason: err.message });
      }
    }

    return {
      requested: count,
      created: created.length,
      skipped: skipped.length,
      createdUsers: created,
      skippedUsers: skipped,
    };
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────
const RESULT_PREFIX = "IGA_RESULT_JSON:";

async function main() {
  const contextFile = process.env.IGA_SCHEDULER_CONTEXT_FILE;
  if (!contextFile) throw new Error("IGA_SCHEDULER_CONTEXT_FILE is required");
  const context = JSON.parse(await fs.readFile(contextFile, "utf8"));

  const job = new CreateManagedUsersJob();
  const result = await job.execute(context);

  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[FATAL] ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

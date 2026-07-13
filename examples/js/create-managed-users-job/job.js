import { SchedulerJob, runJob } from "./scheduler-sdk.js";

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

const MANAGED_USER_PATH = "/openidm/managed/alpha_user";

class CreateManagedUsersJob extends SchedulerJob {
  async execute(context) {
    const userNamePrefix = context.param.string("userNamePrefix") ?? "test-user-";
    const mailDomain     = context.param.string("mailDomain") ?? "example.com";
    const count          = Number(context.param.get("count", 10) ?? 10);

    const created = [];
    const skipped = [];

    for (let i = 0; i < count; i++) {
      const user = buildUser(i, { userNamePrefix, mailDomain });
      try {
        await context.igaClient.execute("POST", MANAGED_USER_PATH, user);
        created.push(user.userName);
        process.stderr.write(`[INFO] Created user ${user.userName}\n`);
      } catch (err) {
        if (err.status === 409) {
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

runJob(CreateManagedUsersJob);

import { SchedulerJob } from "../../../src/index.js";

// Static name pool — diverse but recognisably Western/English names.
// The job picks from these deterministically based on position so that
// repeated dry-runs produce the same users (idempotent by userName).
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

  return {
    userName,
    givenName: given,
    sn,
    mail: `${userName}@${mailDomain}`,
  };
}

export default class CreateManagedUsersJob extends SchedulerJob {
  async execute(context) {
    // ── Parameters ────────────────────────────────────────────────────────────
    // userNamePrefix  (string, default "test-user-")  prefix for generated userNames
    // mailDomain      (string, default "example.com") domain for generated mail addresses
    // count           (number, default 10)            number of users to create
    const userNamePrefix = context.param.string("userNamePrefix") ?? "test-user-";
    const mailDomain     = context.param.string("mailDomain")     ?? "example.com";
    const count          = Number(context.param.get("count", 10));

    // ── AIC managed-user endpoint (alpha realm) ───────────────────────────────
    const MANAGED_USER_PATH = "/openidm/managed/alpha_user";

    const created = [];
    const skipped = [];

    for (let i = 0; i < count; i++) {
      const user = buildUser(i, { userNamePrefix, mailDomain });

      try {
        await context.iga.post(MANAGED_USER_PATH, user);
        created.push(user.userName);
        context.logger?.info(`Created user ${user.userName}`);
      } catch (err) {
        // 409 Conflict = user already exists; any other error is also skipped
        // but logged distinctly so the operator can investigate.
        const status = err.status ?? err.statusCode ?? err.response?.status;
        if (status === 409) {
          context.logger?.warn(`User ${user.userName} already exists — skipping`);
        } else {
          context.logger?.error(`Failed to create ${user.userName}: ${err.message}`);
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

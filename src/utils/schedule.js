import { CronExpressionParser } from "cron-parser";

export function computeNextFireAt(schedule, fromDate = new Date()) {
  if (!schedule || schedule.type !== "cron") {
    throw new Error("Only cron schedules are supported");
  }

  try {
    const interval = CronExpressionParser.parse(schedule.expression, {
      currentDate: fromDate,
      tz: schedule.timezone || "UTC"
    });

    return interval.next().toDate().toISOString();
  } catch (error) {
    throw new Error(`Invalid cron schedule: ${error.message}`);
  }
}

import { SchedulerJob, runJob } from "./scheduler-sdk.js";

class HelloWorldJob extends SchedulerJob {
  async execute(context) {
    const greeting = context.param.string("greeting") ?? "Hello";
    const target = context.param.string("target") ?? "World";
    const message = `${greeting}, ${target}!`;

    process.stderr.write(`[INFO] ${message}\n`);
    process.stderr.write(`[INFO] runId: ${context.runId}\n`);
    process.stderr.write(`[INFO] scheduledFireTime: ${context.scheduledFireTime}\n`);

    return {
      message,
      runId: context.runId,
      scheduledFireTime: context.scheduledFireTime,
      attempt: context.attempt
    };
  }
}

runJob(HelloWorldJob);

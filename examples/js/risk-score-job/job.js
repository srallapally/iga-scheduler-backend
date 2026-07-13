import { SchedulerJob, runJob } from "./scheduler-sdk.js";

export default class RiskScoreJob extends SchedulerJob {
  async execute(context) {
    const scanType    = context.param.requiredString("scanType");
    const applications = context.param.requiredStringArray("applications");

    const response = await context.igaClient.execute(
      "POST",
      "/scheduler/risk-scores/recompute",
      { scanType, applications }
    );

    return {
      status: "submitted",
      igaRequestId: response.requestId
    };
  }
}

// Only auto-run when executed directly (not when imported by tests)
if (!process.env.VITEST) runJob(RiskScoreJob);

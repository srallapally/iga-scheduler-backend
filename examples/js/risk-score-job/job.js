import { SchedulerJob } from "./scheduler-sdk.js";

export default class RiskScoreJob extends SchedulerJob {
    async execute(context) {
        const scanType = context.parameters.getString("scanType");
        const applications = context.parameters.getStringArray("applications");

        await context.status.update({
            phase: "starting",
            message: "Starting risk score recompute"
        });

        const response = await context.iga.riskScores.recompute({
            scanType,
            applications
        });

        await context.feedback.update({
            igaRequestId: response.requestId
        });

        return {
            status: "submitted",
            igaRequestId: response.requestId
        };
    }
}
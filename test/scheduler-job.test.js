import { describe, expect, it, vi } from "vitest";
import RiskScoreJob from "../examples/js/risk-score-job.js";

describe("RiskScoreJob", () => {
    it("executes using wrapper-provided context", async () => {
        const context = {
            runId: "run-1",
            definitionId: "risk-score",
            instanceId: "risk-score-prod",
            parameters: {
                getString: vi.fn().mockReturnValue("FULL"),
                getStringArray: vi.fn().mockReturnValue(["Salesforce"]),
                getSecret: vi.fn()
            },
            iga: {
                riskScores: {
                    recompute: vi.fn().mockResolvedValue({ requestId: "iga-123" })
                }
            },
            status: {
                update: vi.fn()
            },
            feedback: {
                update: vi.fn()
            },
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn()
            },
            audit: {
                event: vi.fn()
            },
            isCancellationRequested: vi.fn().mockResolvedValue(false)
        };

        const job = new RiskScoreJob();
        const result = await job.run(context);

        expect(result).toEqual({
            status: "submitted",
            igaRequestId: "iga-123"
        });

        expect(context.iga.riskScores.recompute).toHaveBeenCalledWith({
            scanType: "FULL",
            applications: ["Salesforce"]
        });
    });
});
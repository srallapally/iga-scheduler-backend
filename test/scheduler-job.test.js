import { describe, expect, it, vi } from "vitest";
import RiskScoreJob from "../examples/js/risk-score-job/job.js";

describe("RiskScoreJob", () => {
  it("calls igaClient.execute with the correct path and returns the result", async () => {
    const igaClient = {
      execute: vi.fn().mockResolvedValue({ requestId: "iga-123" })
    };
    const context = {
      param: {
        requiredString: vi.fn().mockReturnValue("FULL"),
        requiredStringArray: vi.fn().mockReturnValue(["Salesforce"])
      },
      igaClient
    };

    const job = new RiskScoreJob();
    const result = await job.execute(context);

    expect(result).toEqual({ status: "submitted", igaRequestId: "iga-123" });
    expect(igaClient.execute).toHaveBeenCalledWith(
      "POST",
      "/scheduler/risk-scores/recompute",
      { scanType: "FULL", applications: ["Salesforce"] }
    );
  });
});

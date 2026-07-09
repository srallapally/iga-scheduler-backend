import { describe, expect, it, vi } from "vitest";
import { createRuntimeContext } from "../src/runtime/context.js";
import { createIgaHelpers } from "../src/runtime/iga.js";
import { createIgaHelpers as exportedCreateIgaHelpers } from "../src/runtime/index.js";

function createClient() {
  return {
    get: vi.fn(async (path) => ({ path, ok: true })),
    post: vi.fn(async (path, body) => ({ path, body, ok: true }))
  };
}

describe("runtime IGA helpers", () => {
  it("maps typed helpers to IGA client operations", async () => {
    const client = createClient();
    const iga = createIgaHelpers({ client });

    await expect(iga.health.check()).resolves.toEqual({
      path: "/info/ping",
      ok: true
    });
    await expect(iga.riskScores.recompute({ userId: "user-1" })).resolves.toEqual({
      path: "/scheduler/risk-scores/recompute",
      body: { userId: "user-1" },
      ok: true
    });

    expect(client.get).toHaveBeenCalledWith("/info/ping");
    expect(client.post).toHaveBeenCalledWith("/scheduler/risk-scores/recompute", { userId: "user-1" });
  });

  it("supports generic get and post helpers", async () => {
    const client = createClient();
    const iga = createIgaHelpers({ client });

    await iga.get("/custom/read");
    await iga.post("/custom/write", { ok: true });

    expect(client.get).toHaveBeenCalledWith("/custom/read");
    expect(client.post).toHaveBeenCalledWith("/custom/write", { ok: true });
  });

  it("returns unavailable helpers when no client is configured", async () => {
    const iga = createIgaHelpers();

    await expect(iga.health.check()).rejects.toMatchObject({
      code: "RUNTIME_IGA_CLIENT_UNAVAILABLE"
    });
    await expect(iga.riskScores.recompute({})).rejects.toMatchObject({
      code: "RUNTIME_IGA_CLIENT_UNAVAILABLE"
    });
  });

  it("attaches IGA helpers to created runtime context", async () => {
    const client = createClient();
    const context = await createRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile: async () => JSON.stringify({
        runId: "run-1",
        params: {
          window: "PT1H"
        }
      }),
      igaClient: client
    });

    await expect(context.iga.riskScores.recompute({ window: context.param.requiredString("window") })).resolves.toEqual({
      path: "/scheduler/risk-scores/recompute",
      body: { window: "PT1H" },
      ok: true
    });
  });

  it("exports IGA helpers from runtime index", () => {
    expect(exportedCreateIgaHelpers).toBe(createIgaHelpers);
  });
});

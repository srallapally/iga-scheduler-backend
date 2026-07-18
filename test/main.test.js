import { describe, expect, it } from "vitest";
import { resolveAppMode } from "../src/main.js";

describe("resolveAppMode (SEC-8)", () => {
  it("defaults to production when APP_MODE is unset", () => {
    expect(resolveAppMode({ env: {} })).toBe("production");
  });

  it("returns production when APP_MODE=production explicitly", () => {
    expect(resolveAppMode({ env: { APP_MODE: "production", NODE_ENV: "production" } })).toBe("production");
  });

  it("returns local when APP_MODE=local and NODE_ENV is not production", () => {
    expect(resolveAppMode({ env: { APP_MODE: "local" } })).toBe("local");
    expect(resolveAppMode({ env: { APP_MODE: "local", NODE_ENV: "development" } })).toBe("local");
  });

  it("refuses APP_MODE=local combined with NODE_ENV=production", () => {
    expect(() => resolveAppMode({ env: { APP_MODE: "local", NODE_ENV: "production" } }))
      .toThrow("APP_MODE=local is incompatible with NODE_ENV=production");
  });
});

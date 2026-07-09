import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createGoogleOidcVerifier, createInternalAuthMiddleware } from "../src/middleware/internalAuth.js";

function createApp(authMiddleware) {
  const app = express();
  app.get("/internal/test", authMiddleware, (req, res) => {
    res.json({ ok: true, principal: req.internalAuth.principal });
  });
  return app;
}

function createMiddleware(overrides = {}) {
  return createInternalAuthMiddleware({
    expectedAudience: "https://worker.example.test",
    expectedServiceAccountEmail: "worker-invoker@example.iam.gserviceaccount.com",
    verifyToken: vi.fn(async () => ({ aud: "https://worker.example.test", email: "worker-invoker@example.iam.gserviceaccount.com" })),
    ...overrides
  });
}

describe("internal auth middleware", () => {
  it("accepts a valid Google OIDC token payload", async () => {
    const verifyToken = vi.fn(async () => ({ aud: "https://worker.example.test", email: "worker-invoker@example.iam.gserviceaccount.com" }));
    const app = createApp(createMiddleware({ verifyToken }));
    const response = await request(app).get("/internal/test").set("authorization", "Bearer token-1");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, principal: "worker-invoker@example.iam.gserviceaccount.com" });
    expect(verifyToken).toHaveBeenCalledWith("token-1", { audience: "https://worker.example.test", serviceAccountEmail: "worker-invoker@example.iam.gserviceaccount.com" });
  });

  it("rejects missing bearer token", async () => {
    const verifyToken = vi.fn();
    const app = createApp(createMiddleware({ verifyToken }));
    const response = await request(app).get("/internal/test");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "missing bearer token" });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("rejects invalid token audience", async () => {
    const app = createApp(createMiddleware({ verifyToken: vi.fn(async () => ({ aud: "https://other.example.test", email: "worker-invoker@example.iam.gserviceaccount.com" })) }));
    const response = await request(app).get("/internal/test").set("authorization", "Bearer token-1");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "invalid token audience" });
  });

  it("rejects invalid token principal", async () => {
    const app = createApp(createMiddleware({ verifyToken: vi.fn(async () => ({ aud: "https://worker.example.test", email: "other@example.iam.gserviceaccount.com" })) }));
    const response = await request(app).get("/internal/test").set("authorization", "Bearer token-1");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "invalid token principal" });
  });

  it("rejects verifier failures", async () => {
    const verifyToken = vi.fn(() => Promise.reject(new Error("bad signature")));
    const app = createApp(createMiddleware({ verifyToken }));
    const response = await request(app).get("/internal/test").set("authorization", "Bearer token-1").timeout({ response: 1000, deadline: 1500 });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid bearer token" });
    expect(verifyToken).toHaveBeenCalledOnce();
  });

  it("verifies Google ID token with configured audience", async () => {
    const payload = { aud: "https://worker.example.test", email: "worker-invoker@example.iam.gserviceaccount.com" };
    const client = { verifyIdToken: vi.fn(async () => ({ getPayload: () => payload })) };
    const verifyGoogleOidcToken = createGoogleOidcVerifier({ client });
    await expect(verifyGoogleOidcToken("token-1", { audience: "https://worker.example.test" })).resolves.toBe(payload);
    expect(client.verifyIdToken).toHaveBeenCalledWith({ idToken: "token-1", audience: "https://worker.example.test" });
  });

  it("rejects Google ID token without payload", async () => {
    const client = { verifyIdToken: vi.fn(async () => ({ getPayload: () => undefined })) };
    const verifyGoogleOidcToken = createGoogleOidcVerifier({ client });
    await expect(verifyGoogleOidcToken("token-1", { audience: "https://worker.example.test" })).rejects.toThrow("OIDC token payload is empty");
  });
});

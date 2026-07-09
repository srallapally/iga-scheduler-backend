import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPublicAuthMiddleware, createJoseVerifier } from "../src/middleware/publicAuth.js";

function createApp(authMiddleware) {
  const app = express();
  app.get("/protected", authMiddleware, (req, res) => {
    res.json({ ok: true, clientId: req.publicAuth.clientId });
  });
  return app;
}

function createMiddleware(overrides = {}) {
  return createPublicAuthMiddleware({
    issuer: "https://auth.pingone.example.test/env1/as",
    audience: "https://scheduler.example.test",
    verifyToken: vi.fn(async () => ({ sub: "client-1", scope: "scheduler:admin" })),
    ...overrides
  });
}

describe("publicAuth middleware", () => {
  it("throws at construction when issuer is missing", () => {
    expect(() => createPublicAuthMiddleware({ audience: "https://scheduler.example.test" })).toThrow("PUBLIC_API_ISSUER is required");
  });

  it("throws at construction when audience is missing", () => {
    expect(() => createPublicAuthMiddleware({ issuer: "https://auth.example.test" })).toThrow("PUBLIC_API_AUDIENCE is required");
  });

  it("rejects missing Authorization header with 401", async () => {
    const app = createApp(createMiddleware());
    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "missing bearer token" });
  });

  it("rejects malformed Authorization header with 401", async () => {
    const app = createApp(createMiddleware());
    const res = await request(app).get("/protected").set("authorization", "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "missing bearer token" });
  });

  it("rejects token that fails verification with 401", async () => {
    const verifyToken = vi.fn(() => Promise.reject(new Error("invalid signature")));
    const app = createApp(createMiddleware({ verifyToken }));
    const res = await request(app).get("/protected").set("authorization", "Bearer bad-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid bearer token" });
  });

  it("accepts a valid token and populates req.publicAuth with client_id claim", async () => {
    const verifyToken = vi.fn(async () => ({ client_id: "ping-client", sub: "ping-client", scope: "scheduler:admin" }));
    const app = createApp(createMiddleware({ verifyToken }));
    const res = await request(app).get("/protected").set("authorization", "Bearer good-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, clientId: "ping-client" });
    expect(verifyToken).toHaveBeenCalledWith("good-token");
  });

  it("falls back to sub when client_id is absent", async () => {
    const verifyToken = vi.fn(async () => ({ sub: "sub-client", scope: "scheduler:admin" }));
    const app = createApp(createMiddleware({ verifyToken }));
    const res = await request(app).get("/protected").set("authorization", "Bearer good-token");
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe("sub-client");
  });

  it("returns 403 when required scope is missing from token", async () => {
    const verifyToken = vi.fn(async () => ({ sub: "client-1", scope: "other:scope" }));
    const app = createApp(createMiddleware({ verifyToken, requiredScope: "scheduler:admin" }));
    const res = await request(app).get("/protected").set("authorization", "Bearer good-token");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "insufficient scope" });
  });

  it("returns 403 when token has no scope claim and scope is required", async () => {
    const verifyToken = vi.fn(async () => ({ sub: "client-1" }));
    const app = createApp(createMiddleware({ verifyToken, requiredScope: "scheduler:admin" }));
    const res = await request(app).get("/protected").set("authorization", "Bearer good-token");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "insufficient scope" });
  });

  it("accepts token with required scope present", async () => {
    const verifyToken = vi.fn(async () => ({ sub: "client-1", scope: "read scheduler:admin write" }));
    const app = createApp(createMiddleware({ verifyToken, requiredScope: "scheduler:admin" }));
    const res = await request(app).get("/protected").set("authorization", "Bearer good-token");
    expect(res.status).toBe(200);
  });

  it("does not require scope when requiredScope is unset", async () => {
    const verifyToken = vi.fn(async () => ({ sub: "client-1" }));
    const app = createApp(createMiddleware({ verifyToken, requiredScope: undefined }));
    const res = await request(app).get("/protected").set("authorization", "Bearer good-token");
    expect(res.status).toBe(200);
  });

  it("constructs the JWKS set once across multiple requests", async () => {
    let constructCount = 0;
    const verifyToken = vi.fn(async () => {
      constructCount++;
      return { sub: "client-1" };
    });
    const authMiddleware = createPublicAuthMiddleware({
      issuer: "https://auth.example.test",
      audience: "https://scheduler.example.test",
      verifyToken
    });
    const app = createApp(authMiddleware);
    await request(app).get("/protected").set("authorization", "Bearer t1");
    await request(app).get("/protected").set("authorization", "Bearer t2");
    await request(app).get("/protected").set("authorization", "Bearer t3");
    expect(constructCount).toBe(3);
    expect(verifyToken).toHaveBeenCalledTimes(3);
  });
});

describe("createJoseVerifier (local JWKS integration test)", () => {
  it("verifies a locally-signed JWT against a local JWKS", async () => {
    const { generateKeyPair, SignJWT, exportJWK } = await import("jose");
    const { alg, privateKey, publicKey } = await generateKeyPair("RS256").then(async (kp) => ({
      alg: "RS256",
      ...kp
    }));

    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key-1";
    jwk.alg = alg;
    jwk.use = "sig";
    const jwks = { keys: [jwk] };

    const issuer = "https://auth.test.local";
    const audience = "https://scheduler.test.local";

    const token = await new SignJWT({ scope: "scheduler:admin" })
      .setProtectedHeader({ alg, kid: "test-key-1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("1h")
      .setSubject("test-client")
      .sign(privateKey);

    // Serve the JWKS via a tiny express app
    const jwksApp = express();
    jwksApp.get("/.well-known/jwks.json", (_req, res) => res.json(jwks));
    const jwksServer = await new Promise((resolve) => {
      const s = jwksApp.listen(0, () => resolve(s));
    });

    try {
      const { port } = jwksServer.address();
      const jwksUrl = `http://localhost:${port}/.well-known/jwks.json`;
      const verifyToken = createJoseVerifier({ issuer, audience, jwksUrl });
      const payload = await verifyToken(token);
      expect(payload.sub).toBe("test-client");
      expect(payload.scope).toBe("scheduler:admin");
    } finally {
      await new Promise((resolve) => jwksServer.close(resolve));
    }
  });
});

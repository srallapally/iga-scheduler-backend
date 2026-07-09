import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPublicAuthMiddleware, createJoseVerifier, resolveJwksUrl } from "../src/middleware/publicAuth.js";

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

  it("uses azp as clientId (PingOne AIC access tokens)", async () => {
    const verifyToken = vi.fn(async () => ({ azp: "aic-client", sub: "aic-client", scope: "scheduler:admin" }));
    const app = createApp(createMiddleware({ verifyToken }));
    const res = await request(app).get("/protected").set("authorization", "Bearer aic-token");
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe("aic-client");
  });

  it("prefers client_id over azp when both are present", async () => {
    const verifyToken = vi.fn(async () => ({ client_id: "ping-client", azp: "aic-client", sub: "s" }));
    const app = createApp(createMiddleware({ verifyToken }));
    const res = await request(app).get("/protected").set("authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe("ping-client");
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
  it("verifies a locally-signed JWT against a local JWKS (explicit jwksUrl)", async () => {
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

  it("discovers jwks_uri from OIDC discovery document (AIC path)", async () => {
    const { generateKeyPair, SignJWT, exportJWK } = await import("jose");
    // AIC signs with PS256 — verify the middleware accepts it via header-driven alg
    const { privateKey, publicKey } = await generateKeyPair("PS256");

    const jwk = await exportJWK(publicKey);
    jwk.kid = "aic-key-1";
    jwk.alg = "PS256";
    jwk.use = "sig";
    const jwks = { keys: [jwk] };

    // AIC-style: JWKS is at a path that doesn't match /.well-known/jwks.json
    const aicApp = express();
    aicApp.get("/.well-known/openid-configuration", (req, res) => {
      const base = `http://localhost:${server.address().port}`;
      res.json({ issuer: base, jwks_uri: `${base}/oauth2/realms/root/connect/jwk_uri` });
    });
    aicApp.get("/oauth2/realms/root/connect/jwk_uri", (_req, res) => res.json(jwks));
    // Should NOT be called — discovery points elsewhere
    aicApp.get("/.well-known/jwks.json", (_req, res) => res.status(404).end());

    const server = await new Promise((resolve) => {
      const s = aicApp.listen(0, () => resolve(s));
    });

    try {
      const base = `http://localhost:${server.address().port}`;
      const issuer = base;
      const audience = "https://scheduler.test.local";

      const token = await new SignJWT({ azp: "aic-oauth-client" })
        .setProtectedHeader({ alg: "PS256", kid: "aic-key-1" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("1h")
        .setSubject("aic-oauth-client")
        .sign(privateKey);

      // No jwksUrl supplied — must be discovered
      const verifyToken = createJoseVerifier({ issuer, audience });
      const payload = await verifyToken(token);
      expect(payload.azp).toBe("aic-oauth-client");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("resolveJwksUrl", () => {
  it("returns jwks_uri from OIDC discovery when available", async () => {
    const app = express();
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://localhost:${server.address().port}`;
    const expectedJwksUri = `${base}/am/oauth2/realms/root/connect/jwk_uri`;
    app.get("/.well-known/openid-configuration", (_req, res) =>
      res.json({ issuer: base, jwks_uri: expectedJwksUri })
    );

    try {
      const result = await resolveJwksUrl(base);
      expect(result).toBe(expectedJwksUri);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("falls back to <issuer>/.well-known/jwks.json when discovery returns no jwks_uri", async () => {
    const app = express();
    app.get("/.well-known/openid-configuration", (_req, res) => res.json({ issuer: "https://fallback.test" }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://localhost:${server.address().port}`;
    try {
      const result = await resolveJwksUrl(base);
      expect(result).toBe(`${base}/.well-known/jwks.json`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("falls back to <issuer>/.well-known/jwks.json when discovery endpoint is unreachable", async () => {
    const issuer = "http://127.0.0.1:1"; // nothing listening here
    const result = await resolveJwksUrl(issuer);
    expect(result).toBe(`${issuer}/.well-known/jwks.json`);
  });

  it("falls back to <issuer>/.well-known/jwks.json when discovery returns non-200", async () => {
    const app = express();
    app.get("/.well-known/openid-configuration", (_req, res) => res.status(404).end());
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://localhost:${server.address().port}`;
    try {
      const result = await resolveJwksUrl(base);
      expect(result).toBe(`${base}/.well-known/jwks.json`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

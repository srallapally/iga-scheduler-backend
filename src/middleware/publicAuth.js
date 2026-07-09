import { createRemoteJWKSet, jwtVerify } from "jose";

export function createPublicAuthMiddleware({
  issuer = process.env.PUBLIC_API_ISSUER,
  audience = process.env.PUBLIC_API_AUDIENCE,
  requiredScope = process.env.PUBLIC_API_REQUIRED_SCOPE,
  jwksUrl = process.env.PUBLIC_API_JWKS_URL,
  verifyToken
} = {}) {
  if (!issuer) throw new Error("PUBLIC_API_ISSUER is required");
  if (!audience) throw new Error("PUBLIC_API_AUDIENCE is required");

  const resolvedVerifyToken = verifyToken || createJoseVerifier({ issuer, audience, jwksUrl });

  return async function publicAuth(req, res, next) {
    try {
      const authorization = req.get("authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);

      if (!match) {
        return res.status(401).json({ error: "missing bearer token" });
      }

      let claims;
      try {
        claims = await resolvedVerifyToken(match[1]);
      } catch {
        return res.status(401).json({ error: "invalid bearer token" });
      }

      if (requiredScope) {
        const tokenScopes = (claims.scope || "").split(" ").filter(Boolean);
        if (!tokenScopes.includes(requiredScope)) {
          return res.status(403).json({ error: "insufficient scope" });
        }
      }

      // client_id = PingOne; azp = PingOne AIC (ForgeRock); sub = fallback
      req.publicAuth = { claims, clientId: claims.client_id || claims.azp || claims.sub };
      return next();
    } catch {
      return res.status(401).json({ error: "invalid bearer token" });
    }
  };
}

// Fetches the OIDC discovery document to find jwks_uri.
// Supports both PingOne (issuer/.well-known/jwks.json convention) and
// PingOne Advanced Identity Cloud (ForgeRock), which publishes jwks_uri via
// the standard openid-configuration discovery endpoint.
// Falls back to <issuer>/.well-known/jwks.json if discovery is unavailable.
export async function resolveJwksUrl(issuer) {
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (res.ok) {
      const doc = await res.json();
      if (doc.jwks_uri) return doc.jwks_uri;
    }
  } catch {
    // network error or non-JSON — fall through
  }
  return `${issuer}/.well-known/jwks.json`;
}

export function createJoseVerifier({ issuer, audience, jwksUrl }) {
  // When jwksUrl is explicit, initialise the JWKS set immediately (sync, preserves prior behaviour).
  // When it is absent, defer to OIDC discovery on the first token verification so that
  // PingOne AIC realm URLs (which publish jwks_uri in their discovery doc) work without
  // requiring the operator to look up and hard-code the URL.
  let jwksPromise = jwksUrl
    ? Promise.resolve(createRemoteJWKSet(new URL(jwksUrl)))
    : null;

  function getJwks() {
    if (!jwksPromise) {
      jwksPromise = resolveJwksUrl(issuer).then((url) => createRemoteJWKSet(new URL(url)));
    }
    return jwksPromise;
  }

  return async function verifyJoseToken(token) {
    const JWKS = await getJwks();
    const { payload } = await jwtVerify(token, JWKS, { issuer, audience });
    return payload;
  };
}

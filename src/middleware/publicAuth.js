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

      req.publicAuth = { claims, clientId: claims.client_id || claims.sub };
      return next();
    } catch {
      return res.status(401).json({ error: "invalid bearer token" });
    }
  };
}

export function createJoseVerifier({ issuer, audience, jwksUrl }) {
  const discoveryUrl = jwksUrl || `${issuer}/.well-known/jwks.json`;
  const JWKS = createRemoteJWKSet(new URL(discoveryUrl));

  return async function verifyJoseToken(token) {
    const { payload } = await jwtVerify(token, JWKS, { issuer, audience });
    return payload;
  };
}

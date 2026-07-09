import { OAuth2Client } from "google-auth-library";

export function createInternalAuthMiddleware({
  expectedAudience = process.env.WORKER_OIDC_AUDIENCE || process.env.WORKER_BASE_URL,
  expectedServiceAccountEmail = process.env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL,
  verifyToken = createGoogleOidcVerifier()
} = {}) {
  if (!expectedAudience) {
    throw new Error("WORKER_OIDC_AUDIENCE or WORKER_BASE_URL is required");
  }

  if (!expectedServiceAccountEmail) {
    throw new Error("WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL is required");
  }

  return async function internalAuth(req, res, next) {
    try {
      const authorization = req.get("authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);

      if (!match) {
        return res.status(401).json({ error: "missing bearer token" });
      }

      const claims = await verifyToken(match[1], {
        audience: expectedAudience,
        serviceAccountEmail: expectedServiceAccountEmail
      });

      if (claims.aud !== expectedAudience) {
        return res.status(403).json({ error: "invalid token audience" });
      }

      const email = claims.email || claims.sub;

      if (email !== expectedServiceAccountEmail) {
        return res.status(403).json({ error: "invalid token principal" });
      }

      req.internalAuth = {
        claims,
        principal: email
      };

      return next();
    } catch {
      return res.status(401).json({ error: "invalid bearer token" });
    }
  };
}

export function createGoogleOidcVerifier({ client = new OAuth2Client() } = {}) {
  return async function verifyGoogleOidcToken(token, { audience }) {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience
    });

    const payload = ticket.getPayload();

    if (!payload) {
      throw new Error("OIDC token payload is empty");
    }

    return payload;
  };
}

# ADR 0020: Pin the Public API JWT Algorithm Allowlist

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`createJoseVerifier` (`src/middleware/publicAuth.js`) verified public API bearer tokens by reading the token's own protected-header `alg` via `decodeProtectedHeader` and feeding that single value straight back into `jwtVerify`'s `algorithms` option. An allowlist that's derived from the value it's supposed to constrain is a tautology — whatever algorithm a token claims to use is exactly what gets "allowed" for it. `createRemoteJWKSet` already restricts JWKS keys to asymmetric ones and `jose` already rejects `alg:"none"`, so this wasn't practically exploitable, but it nullified the allowlist as a defense-in-depth layer against, for example, a future RSA-key-confusion-style attack or a JWKS key usable under more than one algorithm. This is tracked as SEC-5.

The original code read `alg` from the header deliberately, not by oversight: PingOne signs with RS256, while PingOne Advanced Identity Cloud (ForgeRock) signs with **PS256** — confirmed by this codebase's own existing AIC integration test, which signs and verifies a real PS256 token. A fixed allowlist that omitted PS256 would have regressed real AIC deployments while fixing the security gap, so the default couldn't just be lifted verbatim from the bug report's illustrative `["RS256","ES256"]` example.

---

## Decision

`createJoseVerifier` now takes an `algorithms` parameter, defaulting to `["RS256", "ES256", "PS256"]`, and passes it directly to `jwtVerify` instead of deriving it from the token's own header. `createPublicAuthMiddleware` threads an `algorithms` option through to it, defaulting from a new optional `PUBLIC_API_ALGORITHMS` env var (comma-separated) when unset — consistent with this middleware's existing `PUBLIC_API_*` configuration convention. Neither PingOne (RS256) nor AIC (PS256) deployments need to set the new var; it exists for an operator who needs a different default, not as a required piece of configuration.

---

## Consequences

### What this closes

The algorithm allowlist is now genuinely independent of what a token's header claims — a token signed with an algorithm outside the configured list is rejected outright, regardless of what its own `alg` field says.

### What does not change

- Existing PingOne (RS256) and AIC (PS256) callers — both are in the new default, so no functional change or new required configuration for either.
- `createRemoteJWKSet`'s asymmetric-key-only behavior, issuer/audience validation, and scope enforcement — untouched.
- No other JWT verification path exists in this codebase (`internalAuth.js` uses Google's OIDC library, which handles its own algorithm validation) — this fix is scoped entirely to `publicAuth.js`.

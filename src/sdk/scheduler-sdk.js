/**
 * IGA Scheduler SDK — injected into every job's extraction directory at runtime.
 * Self-contained: no imports outside Node built-ins. Do not add external imports.
 */
import fs from "fs/promises";

// ── Parameter reader ──────────────────────────────────────────────────────────

function createParameterReader(params = {}) {
  return {
    get(name, defaultValue) {
      const value = params[name];
      return value === undefined ? defaultValue : value;
    },
    require(name) {
      const value = params[name];
      if (value === undefined || value === null || value === "") {
        throw parameterError("RUNTIME_PARAMETER_REQUIRED", `required runtime parameter is missing: ${name}`);
      }
      return value;
    },
    string(name, defaultValue) {
      const value = this.get(name, defaultValue);
      if (value === undefined) return undefined;
      if (typeof value !== "string") {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string`);
      }
      return value;
    },
    requiredString(name) {
      const value = this.require(name);
      if (typeof value !== "string") {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string`);
      }
      return value;
    },
    stringArray(name, defaultValue) {
      const value = this.get(name, defaultValue);
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string array`);
      }
      return value;
    },
    requiredStringArray(name) {
      const value = this.require(name);
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string array`);
      }
      return value;
    }
  };
}

function parameterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ── BrokerIgaClient ───────────────────────────────────────────────────────────

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

class BrokerIgaClient {
  constructor({ runId, brokerUrl, fetchImpl = fetch }) {
    this._runId = runId;
    this._brokerUrl = brokerUrl.replace(/\/+$/, "");
    this._fetch = fetchImpl;
    this._cachedToken = null; // { token, expiresAtMs }
  }

  async execute(method, path, body) {
    const token = await this._getToken();
    return this._request(method, path, body, token, true);
  }

  async _request(method, path, body, token, retryOn401) {
    const res = await this._fetch(`${this._brokerUrl}/internal/runtime/iga/request`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ runId: this._runId, method, path, body })
    });

    if (res.status === 401 && retryOn401) {
      this._cachedToken = null;
      const freshToken = await this._getToken();
      return this._request(method, path, body, freshToken, false);
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return json.result;
  }

  async _getToken() {
    const now = Date.now();
    if (this._cachedToken && this._cachedToken.expiresAtMs - now > TOKEN_REFRESH_SKEW_MS) {
      return this._cachedToken.token;
    }
    const token = await this._fetchOidcToken();
    // OIDC tokens from the metadata server are JWTs — parse expiry from payload
    const expiresAtMs = parseJwtExp(token) ?? now + 3_600_000;
    this._cachedToken = { token, expiresAtMs };
    return token;
  }

  async _fetchOidcToken() {
    const url = `${METADATA_TOKEN_URL}?audience=${encodeURIComponent(this._brokerUrl)}&format=full`;
    const res = await this._fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Metadata-Flavor": "Google" }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OIDC token fetch failed: HTTP ${res.status} ${text}`);
    }
    return res.text();
  }
}

// ── DirectIgaClient (local mode only) ─────────────────────────────────────────

class DirectIgaClient {
  constructor({ baseUrl, tokenEndpoint, clientId, clientSecret, fetchImpl = fetch }) {
    this._baseUrl = baseUrl.replace(/\/+$/, "");
    this._tokenEndpoint = tokenEndpoint;
    this._clientId = clientId;
    this._clientSecret = clientSecret;
    this._fetch = fetchImpl;
    this._cachedToken = null; // { token, expiresAtMs }
  }

  async execute(method, path, body) {
    const token = await this._getToken();
    return this._request(method, path, body, token, true);
  }

  async _request(method, path, body, token, retryOn401) {
    const res = await this._fetch(`${this._baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {})
    });

    if (res.status === 401 && retryOn401) {
      this._cachedToken = null;
      const freshToken = await this._getToken();
      return this._request(method, path, body, freshToken, false);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const json = safeParseJson(text) ?? {};
      const err = new Error(json.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  async _getToken() {
    const now = Date.now();
    if (this._cachedToken && this._cachedToken.expiresAtMs - now > TOKEN_REFRESH_SKEW_MS) {
      return this._cachedToken.token;
    }
    const { token, expiresAtMs } = await this._fetchToken();
    this._cachedToken = { token, expiresAtMs };
    return token;
  }

  async _fetchToken() {
    const basic = Buffer.from(`${this._clientId}:${this._clientSecret}`, "utf8").toString("base64");
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: "fr:idm:*" });
    const res = await this._fetch(this._tokenEndpoint, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status} ${text}`);
    const json = JSON.parse(text);
    if (!json.access_token) throw new Error("OAuth token response missing access_token");
    const expiresIn = Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
      ? Number(json.expires_in)
      : 300;
    return { token: json.access_token, expiresAtMs: Date.now() + expiresIn * 1000 };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJwtExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function buildIgaClient(env) {
  const brokerUrl = env.IGA_BROKER_URL;
  if (brokerUrl) {
    return new BrokerIgaClient({ runId: env.IGA_SCHEDULER_RUN_ID, brokerUrl });
  }
  // Local dev fallback: direct IGA credentials injected by LocalWorkerRunService
  if (env.IGA_BASE_URL && env.IGA_TOKEN_ENDPOINT && env.IGA_CLIENT_ID && env.IGA_CLIENT_SECRET) {
    return new DirectIgaClient({
      baseUrl: env.IGA_BASE_URL,
      tokenEndpoint: env.IGA_TOKEN_ENDPOINT,
      clientId: env.IGA_CLIENT_ID,
      clientSecret: env.IGA_CLIENT_SECRET
    });
  }
  return {
    execute: async () => {
      throw Object.assign(new Error("igaClient is not configured: IGA_BROKER_URL is missing"), {
        code: "IGA_CLIENT_NOT_CONFIGURED"
      });
    }
  };
}

// ── Context ───────────────────────────────────────────────────────────────────

export async function createContext(env = process.env) {
  const contextFile = env.IGA_SCHEDULER_CONTEXT_FILE;
  if (!contextFile) {
    throw Object.assign(new Error("IGA_SCHEDULER_CONTEXT_FILE is required"), {
      code: "RUNTIME_CONTEXT_FILE_REQUIRED"
    });
  }
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(contextFile, "utf8"));
  } catch (err) {
    throw Object.assign(new Error(`failed to read runtime context: ${err.message}`), {
      code: "RUNTIME_CONTEXT_FILE_READ_FAILED",
      cause: err
    });
  }
  const params = raw.params || {};
  return {
    runId: raw.runId,
    definition: raw.definition,
    instance: raw.instance,
    scheduledFireTime: raw.scheduledFireTime,
    attempt: raw.attempt,
    params,
    param: createParameterReader(params),
    igaClient: buildIgaClient(env)
  };
}

// ── SchedulerJob ──────────────────────────────────────────────────────────────

export class SchedulerJob {
  async run(context) {
    return this.execute(context);
  }

  async execute(_context) {
    throw new Error("execute(context) must be implemented");
  }
}

// ── runJob ────────────────────────────────────────────────────────────────────

export async function runJob(JobClass, env = process.env) {
  const context = await createContext(env);
  const job = new JobClass();
  const result = await job.run(context);
  process.stdout.write(`IGA_RESULT_JSON:${JSON.stringify(result ?? null)}\n`);
}
